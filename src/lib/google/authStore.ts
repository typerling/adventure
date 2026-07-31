import { create } from 'zustand'
import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES, isGoogleConfigured } from './config'
import { GIS_SCRIPT_SRC, loadScript } from './loadScript'

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

/** Serialized queue tail. GIS allows only one outstanding request per client, and its callback is
 * fixed at creation (above), so overlapping callers would each overwrite `currentTokenHandler` —
 * every handler but the last would then never be invoked and its promise would never settle. */
let tokenQueue: Promise<unknown> = Promise.resolve()

/** Shared silent-refresh promise, so parallel API calls hitting an expired token coalesce into a
 * single GIS request instead of queueing one each. See getValidAccessToken. */
let inFlightRefresh: Promise<string> | null = null

/** Issues one token request and resolves with its single response. Requests are chained so a
 * second caller waits for the first to settle rather than clobbering its handler. */
function requestToken(overrideConfig?: { prompt?: string }): Promise<TokenResponse> {
  const result = tokenQueue.then(async () => {
    const client = await ensureTokenClient()
    return new Promise<TokenResponse>((resolve) => {
      currentTokenHandler = (res) => {
        // GIS should only fire once per request, but guard anyway: a duplicate callback must not
        // leak into whichever request happens to be queued next.
        currentTokenHandler = null
        resolve(res)
      }
      client.requestAccessToken(overrideConfig)
    })
  })
  // Keep the chain alive even when a link rejects (e.g. the GIS script fails to load), otherwise
  // one failure would permanently wedge every later token request.
  tokenQueue = result.catch(() => {})
  return result
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
      const res = await requestToken()
      if (res.error) throw new Error(res.error_description ?? res.error)
      set({
        status: 'signed-in',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
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
      if (res.error) {
        set({ status: 'signed-out', accessToken: null, expiresAt: null })
        throw new Error('Session expired — please sign in again.')
      }
      set({
        status: 'signed-in',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
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
      if (res.error) {
        useGoogleAuth.setState({ status: 'signed-out' })
        return
      }
      useGoogleAuth.setState({
        status: 'signed-in',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
    })
    .catch(() => {
      useGoogleAuth.setState({ status: 'signed-out' })
    })
}
