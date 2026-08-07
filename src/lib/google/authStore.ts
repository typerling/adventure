import { create } from 'zustand'
import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES, isGoogleConfigured } from './config'
import { GIS_SCRIPT_SRC, loadScript } from './loadScript'
import { disableCrossOriginIsolationAndReload } from '@/lib/coiServiceWorker'
import { fetchAccountEmail, getStoredLoginHint, setStoredLoginHint } from './loginHint'

type AuthStatus = 'unconfigured' | 'restoring' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'

interface AuthState {
  status: AuthStatus
  accessToken: string | null
  /** epoch ms */
  expiresAt: number | null
  errorMessage: string | null
  signIn: () => Promise<void>
  signOut: () => void
  /** Returns a currently-valid access token, silently refreshing if the existing one is stale.
   * Throws if the user needs to interactively sign in again — callers should catch and prompt. */
  getValidAccessToken: () => Promise<string>
}

/**
 * localStorage, not sessionStorage: this is a short-lived (~1hr) access token that gets silently
 * refreshed anyway (see requestToken's `prompt: ''` path below), so the thing that actually
 * matters for "staying signed in" is surviving a closed tab/PWA, not just a single tab's
 * lifetime. sessionStorage was clearing this on every close, forcing an interactive re-login far
 * more often than the underlying Google session actually required.
 */
const SESSION_STORAGE_KEY = 'adventure:google-session'

interface StoredSession {
  accessToken: string
  expiresAt: number
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return null
    // Same 60s safety margin as getValidAccessToken's freshness check below.
    if (parsed.expiresAt - Date.now() <= 60_000) return null
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

function persistSession(accessToken: string | null, expiresAt: number | null): void {
  try {
    if (accessToken && expiresAt) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken, expiresAt }))
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY)
    }
  } catch {
    // localStorage unavailable (private browsing, storage disabled, …) — sign-in just won't
    // survive a reload; everything else keeps working.
  }
}

const restoredSession = isGoogleConfigured ? readStoredSession() : null

let tokenClient: TokenClient | null = null
// GIS fixes initTokenClient's `callback` for the whole lifetime of the client — requestAccessToken()
// has no way to override it per call. So the registered callback never changes; it's a stable
// dispatcher that forwards to whichever handler below is "current" at the moment a request went out.
let currentTokenHandler: ((res: TokenResponse) => void) | null = null

async function ensureTokenClient(): Promise<TokenClient> {
  if (tokenClient) return tokenClient
  await loadScript(GIS_SCRIPT_SRC)
  if (!window.google) throw new Error('Google Identity Services failed to load')
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID as string,
    scope: GOOGLE_SCOPES,
    callback: (res) => currentTokenHandler?.(res),
    error_callback: (err) =>
      currentTokenHandler?.({
        access_token: '',
        expires_in: 0,
        scope: '',
        token_type: '',
        error: err.type,
        error_description: err.message,
      }),
  })
  return tokenClient
}

/**
 * True when a GIS popup token request failed because `Cross-Origin-Opener-Policy: same-origin`
 * (enabled by src/lib/coiServiceWorker.ts, for Kokoro's threaded WASM - see that file and
 * coi-serviceworker.js's doc comments) severed `window.opener` for the popup accounts.google.com
 * opens. Confirmed by reading GIS's own unminified source, not assumed: both interactive sign-in
 * and background silent refresh open a popup that relays its result back via
 * `window.opener.postMessage(...)`, which throws/no-ops once `opener` is null - and confirmed
 * empirically in real Chromium with a synthetic two-origin popup+postMessage test that COOP:
 * same-origin does exactly this. GIS's own "popup closed before finishing" detection (unaffected
 * by COOP - it only reads `.closed` on *our* reference to the popup, never the popup's own
 * `opener`) then reports `'popup_closed'`, indistinguishable from the user actually closing it,
 * even though the popup completed the flow just fine server-side.
 *
 * Every call site below treats this one error id as "the isolation shim needs to step out of the
 * way" rather than a normal auth failure - it isn't safe to just retry, since every popup this
 * session opens while still isolated would fail the same way, including the *next* automatic
 * silent refresh roughly an hour from now (this app's access tokens are short-lived - see
 * SESSION_STORAGE_KEY's comment below).
 */
function isPopupSeveredByIsolation(res: TokenResponse): boolean {
  return res.error === 'popup_closed' && window.crossOriginIsolated === true
}

/**
 * Issue #45 research summary — why silent restore likely fails specifically in an installed
 * Android home-screen app ("WebAPK"), cited sources in the issue/PR discussion:
 *
 * 1. GIS's OAuth2 token client documents `prompt: ''` as "the user will be prompted only the
 *    first time your app requests access" (developers.google.com/identity/oauth2/web/reference/
 *    js-reference) — not a guarantee of zero UI. Per this file's own prior investigation (see
 *    isPopupSeveredByIsolation above, verified against GIS's unminified source), that request
 *    still opens a real `window.open()` popup even when "silent"; it just closes itself
 *    unnoticed when Google's session/consent state lets it skip straight through.
 * 2. Browsers gate `window.open()` behind a direct user gesture (transient activation) by
 *    default (developer.chrome.com/blog/user-activation; MDN "Transient activation"). This
 *    app's silent requests — both the startup reauth below and getValidAccessToken's refresh —
 *    fire automatically, with no click behind them, which is exactly the case popup blockers
 *    target.
 * 3. This combination is independently, if older, documented as a real gap: an archived
 *    google/google-api-javascript-client issue (#816) reports that a `requestAccessToken` whose
 *    popup can't open due to a missing user gesture produces **no reliable error either** —
 *    "it seems that no error is produced and it is not possible to catch and react to these
 *    cases." Modern GIS *does* document two error_callback types for this
 *    (`popup_failed_to_open`, `popup_closed` — developers.google.com/identity/oauth2/web/guides/
 *    error), which is better, but the "callback never fires at all" case can't be ruled out from
 *    reading docs alone — hence SILENT_REFRESH_TIMEOUT_MS below as a defensive backstop
 *    regardless of which one actually happens on-device.
 * 4. A plain installed WebAPK (not a TWA/native wrapper) is documented to share the same Chrome
 *    profile's cookies/localStorage as an ordinary tab on that origin (developers.google.com/web/
 *    fundamentals/integration/webapks; corroborated by community reporting), so this app's own
 *    persisted-token localStorage isn't the likely culprit — it's specifically the *popup-based*
 *    silent-reissuance mechanic that's unlikely to survive a gesture-less request in a standalone
 *    app context with no visible browser chrome to host a blocked-popup indicator in.
 * 5. FedCM (developers.google.com/identity/gsi/web/guides/fedcm-migration) does not apply here:
 *    its migration guidance is scoped to "Sign In With Google" (One Tap / ID-token identity), not
 *    the OAuth2 token client (`initTokenClient`/`requestAccessToken`) this app uses for Drive/
 *    Sheets *authorization* — confirmed by that guide's own text, which never mentions
 *    `initTokenClient` or `requestAccessToken`.
 *
 * None of this was verified against a real installed Android WebAPK — this sandboxed environment
 * has no adb/emulator (same constraint issue #39 documented). The fixes below (SILENT_REFRESH_
 * TIMEOUT_MS, loginHint.ts) are grounded in the sources above and audited for correctness at the
 * code level (tests/google-session-restore.spec.ts, tests/google-login-hint.spec.ts), but the
 * actual root-cause diagnosis and the fix's real-world effect both still need the project owner's
 * own device to confirm.
 */

/** Serialized queue tail. GIS allows only one outstanding request per client, and its callback is
 * fixed at creation (above), so overlapping callers would each overwrite `currentTokenHandler` —
 * every handler but the last would then never be invoked and its promise would never settle. */
let tokenQueue: Promise<unknown> = Promise.resolve()

/** Shared silent-refresh promise, so parallel API calls hitting an expired token coalesce into a
 * single GIS request instead of queueing one each. See getValidAccessToken. */
let inFlightRefresh: Promise<string> | null = null

/**
 * Issue #45 research finding: neither the request UI nor an error is guaranteed for a silent
 * (`prompt: ''`) request whose popup can't open — confirmed as a real, if older, community-
 * documented gap in Google's own client-library ecosystem (google/google-api-javascript-client
 * #816: "the UI may not be opened in cases where the request wasn't initialised by a user action
 * ... it seems that no error is produced and it is not possible to catch and react to these
 * cases"). That's exactly the shape of failure most likely in an installed Android WebAPK: GIS's
 * silent flow is confirmed (see isPopupSeveredByIsolation's comment) to still open a real popup
 * even when "silent," and browsers require a direct user gesture to open one — a request fired
 * automatically on page load / token refresh has none. Without a bound on how long we'll wait,
 * a request that never calls back would wedge `tokenQueue` forever (GIS supports only one
 * in-flight `requestAccessToken` per client), silently blocking every later token request too —
 * including an explicit "Sign in" click. This timeout only applies to silent requests; an
 * interactive request legitimately waits on real user input.
 *
 * Known tradeoff (found in independent review, not eliminated): if the real GIS callback for a
 * silent request arrives *after* this timeout has already fired, `settle`'s
 * `currentTokenHandler !== settle` guard correctly no-ops the late response — no dangling promise,
 * no queue corruption — but that also means a legitimately slow-but-*successful* silent refresh
 * gets treated as a failure, forcing an interactive "Session expired" prompt the user didn't
 * strictly need. 8s is chosen generous enough that this should be rare, but it isn't provably
 * impossible, and there is no way to distinguish "never responding" from "responding slowly" ahead
 * of time without a longer wait that would make the original wedged-queue problem worse instead.
 */
const SILENT_REFRESH_TIMEOUT_MS = 8_000

/** Issues one token request and resolves with its single response. Requests are chained so a
 * second caller waits for the first to settle rather than clobbering its handler. */
function requestToken(overrideConfig?: { prompt?: string; login_hint?: string }): Promise<TokenResponse> {
  const result = tokenQueue.then(async () => {
    const client = await ensureTokenClient()
    return new Promise<TokenResponse>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const settle = (res: TokenResponse) => {
        // GIS should only fire once per request, but guard anyway: a duplicate callback (or a
        // late one arriving after our own timeout already settled this) must not leak into
        // whichever request happens to be queued next.
        if (currentTokenHandler !== settle) return
        currentTokenHandler = null
        if (timeoutId !== null) clearTimeout(timeoutId)
        resolve(res)
      }
      currentTokenHandler = settle
      if (overrideConfig?.prompt === '') {
        timeoutId = setTimeout(() => {
          settle({
            access_token: '',
            expires_in: 0,
            scope: '',
            token_type: '',
            error: 'silent_refresh_timeout',
            error_description: 'Silent sign-in did not respond in time.',
          })
        }, SILENT_REFRESH_TIMEOUT_MS)
      }
      client.requestAccessToken(overrideConfig)
    })
  })
  // Keep the chain alive even when a link rejects (e.g. the GIS script fails to load), otherwise
  // one failure would permanently wedge every later token request.
  tokenQueue = result.catch(() => {})
  return result
}

/**
 * Best-effort, fire-and-forget capture of the signed-in account's email as a future `login_hint`
 * (see loginHint.ts) — issue #45's mitigation for forced interactive re-login. Only fetches once
 * per stored hint (not on every refresh): it's a UX nicety, not something worth spending an extra
 * API call on each hourly token refresh for.
 */
function ensureLoginHint(accessToken: string): void {
  if (getStoredLoginHint()) return
  fetchAccountEmail(accessToken)
    .then((email) => {
      if (email) setStoredLoginHint(email)
    })
    .catch(() => {
      // Never let this affect sign-in itself — see loginHint.ts's doc comment.
    })
}

export const useGoogleAuth = create<AuthState>((set, get) => ({
  status: restoredSession ? 'signed-in' : isGoogleConfigured ? 'restoring' : 'unconfigured',
  accessToken: restoredSession?.accessToken ?? null,
  expiresAt: restoredSession?.expiresAt ?? null,
  errorMessage: null,

  signIn: async () => {
    if (!isGoogleConfigured) {
      set({ status: 'unconfigured' })
      return
    }
    set({ status: 'signing-in', errorMessage: null })
    try {
      // No `prompt` override: GIS then defaults to 'select_account', which is interactive (right
      // for an explicit "Sign in" click) but doesn't re-ask for consent the user already granted.
      // Forcing 'consent' here meant every returning sign-in replayed the full consent screen.
      //
      // login_hint (issue #45 mitigation): if we already know which account signed in last time,
      // passing it here skips the account picker per GIS's own documented behavior ("When
      // successful, account selection is skipped") — turning a forced interactive re-login (e.g.
      // after a failed silent restore in an installed Android app — see this file's header
      // comment) into a single tap/consent instead of a full chooser. undefined when we don't
      // have one yet (first-ever sign-in, or storage unavailable), which just falls back to
      // today's behavior.
      const hint = getStoredLoginHint()
      const res = await requestToken(hint ? { login_hint: hint } : undefined)
      if (isPopupSeveredByIsolation(res)) {
        set({
          status: 'error',
          errorMessage: 'One moment — reloading to finish signing in…',
        })
        await disableCrossOriginIsolationAndReload() // navigates away; nothing after this runs
        return
      }
      if (res.error) throw new Error(res.error_description ?? res.error)
      set({
        status: 'signed-in',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
      ensureLoginHint(res.access_token)
    } catch (err) {
      set({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  signOut: () => {
    const token = get().accessToken
    if (token && window.google) {
      window.google.accounts.oauth2.revoke(token)
    }
    // Clear the login_hint too: it exists to speed up re-authenticating as the *same* account,
    // and a stale one would bias GIS's account picker toward that account — working against
    // someone who signed out specifically to switch accounts. See loginHint.ts.
    setStoredLoginHint(null)
    set({ status: 'signed-out', accessToken: null, expiresAt: null })
  },

  getValidAccessToken: async () => {
    const { accessToken, expiresAt } = get()
    // 60s safety margin before expiry
    if (accessToken && expiresAt && expiresAt - Date.now() > 60_000) {
      return accessToken
    }
    if (!isGoogleConfigured) {
      throw new Error('Google Drive is not configured yet — add VITE_GOOGLE_CLIENT_ID.')
    }
    // Concurrent callers share one refresh. Parallel Drive/Sheets reads are the norm here
    // (useCampaign loads four at once; http.ts retries every 401), so without this a single
    // expiry would fan out into N simultaneous GIS requests.
    if (inFlightRefresh) return inFlightRefresh

    const refresh = (async () => {
      // Silent refresh (no consent prompt) — piggybacks on Google's own cookie session.
      const res = await requestToken({ prompt: '' })
      if (isPopupSeveredByIsolation(res)) {
        // Don't report this as a normal expired session: it isn't one, and "sign in again" would
        // just fail the same way while still isolated. Step out of isolation and reload instead —
        // see isPopupSeveredByIsolation's doc comment.
        set({ status: 'signed-out', accessToken: null, expiresAt: null })
        await disableCrossOriginIsolationAndReload() // navigates away; nothing after this runs
        throw new Error('Reloading to restore your session…')
      }
      if (res.error) {
        set({ status: 'signed-out', accessToken: null, expiresAt: null })
        throw new Error('Session expired — please sign in again.')
      }
      set({
        status: 'signed-in',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
      ensureLoginHint(res.access_token)
      return res.access_token
    })()

    inFlightRefresh = refresh
    try {
      return await refresh
    } finally {
      if (inFlightRefresh === refresh) inFlightRefresh = null
    }
  },
}))

// Central persistence point — covers every path that changes the token, including the direct
// `useGoogleAuth.setState(...)` call in http.ts's 401 handling, without duplicating storage
// calls into every action above.
useGoogleAuth.subscribe((state, prevState) => {
  if (state.accessToken !== prevState.accessToken || state.expiresAt !== prevState.expiresAt) {
    persistSession(state.accessToken, state.expiresAt)
  }
})

// On a fresh load with no still-valid persisted token, try one silent reauth — this piggybacks
// on Google's own cookie-backed session, not our storage, so it can restore access even after
// the persisted token expired or storage was cleared, without ever showing a sign-in prompt.
// AuthGate holds children back during 'restoring' so nothing calls getValidAccessToken() and
// races this request (GIS only supports one in-flight requestAccessToken per client anyway).
if (isGoogleConfigured && !restoredSession) {
  requestToken({ prompt: '' })
    .then((res) => {
      // See isPopupSeveredByIsolation's doc comment - this is the same recovery as
      // getValidAccessToken's silent refresh, just for the very first load's reauth attempt.
      if (isPopupSeveredByIsolation(res)) {
        useGoogleAuth.setState({ status: 'signed-out' })
        void disableCrossOriginIsolationAndReload()
        return
      }
      if (res.error) {
        useGoogleAuth.setState({ status: 'signed-out' })
        return
      }
      useGoogleAuth.setState({
        status: 'signed-in',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
      ensureLoginHint(res.access_token)
    })
    .catch(() => {
      useGoogleAuth.setState({ status: 'signed-out' })
    })
}
