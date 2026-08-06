/**
 * Registers `public/coi-serviceworker.js` (see that file's doc comment for the full rationale and
 * the confirmed Google-sign-in conflict) so `self.crossOriginIsolated` becomes true on GitHub
 * Pages, letting ONNX Runtime Web's WASM backend run Kokoro TTS multi-threaded.
 *
 * Isolation is a property of the *document*, fixed at load time — a service worker that starts
 * controlling a page only takes effect on the page's *next* load, so the very first visit (or any
 * visit after this worker is newly installed/updated) needs exactly one reload before
 * `crossOriginIsolated` flips true. `sessionStorage` guards that to happen at most once per tab
 * session, so a browser that never actually achieves isolation (no ServiceWorker support, or
 * something blocks it) degrades to "stays single-threaded," not a reload loop.
 *
 * The other reload loop, found in independent review of the PR that introduced this: isolation
 * being unregistered by `disableCrossOriginIsolationAndReload()` (below) only lasts until the
 * *next* call to this function — which happens unconditionally on every app boot, from
 * `main.tsx`. Without `ISOLATION_DISABLED_KEY`, an ordinary page reload (or PWA relaunch) right
 * after recovery would immediately re-register the worker and re-isolate the page, so the very
 * next popup-based token refresh (this app's access tokens are short-lived — see authStore.ts's
 * SESSION_STORAGE_KEY comment) would sever and "recover" all over again, forever, within the same
 * tab. `ISOLATION_DISABLED_KEY` makes that recovery durable for the rest of *this* `sessionStorage`
 * lifetime (survives reloads, cleared by closing the tab) — a fresh tab/session still retries
 * isolation from scratch, so this is a bounded, per-session opt-out, not a permanent one.
 */

const RELOAD_GUARD_KEY = 'adventure:coi-reload-attempted'
/** Set by disableCrossOriginIsolationAndReload(), checked here — see the doc comment above. */
const ISOLATION_DISABLED_KEY = 'adventure:coi-disabled'

function swUrl(): string {
  return `${import.meta.env.BASE_URL}coi-serviceworker.js`
}

function swScope(): string {
  return import.meta.env.BASE_URL
}

/** Best-effort: never blocks app startup, never throws past its own boundary. Kokoro simply stays
 * single-threaded (its existing, already-supported baseline - see kokoroTts.worker.ts) if this
 * doesn't succeed, same graceful-degradation posture as every other optional perf feature here. */
export async function ensureCrossOriginIsolated(): Promise<void> {
  try {
    if (window.crossOriginIsolated) return // Already isolated - a host that CAN set the headers
    // natively (local dev/preview with VITE_COI_HEADERS, or a future non-GitHub-Pages host)
    // needs no service worker at all.
    // Recovery just deliberately stepped out of isolation for a broken sign-in popup - honor that
    // for the rest of this tab session instead of immediately re-isolating on the very next load
    // (this function's own doc comment above has the full story).
    if (sessionStorage.getItem(ISOLATION_DISABLED_KEY) === '1') return
    if (!('serviceWorker' in navigator)) return

    await navigator.serviceWorker.register(swUrl(), { scope: swScope() })
    await navigator.serviceWorker.ready

    // The current document already finished loading before the worker could intercept its own
    // navigation response, so it isn't isolated yet even though the worker is now active and
    // WILL isolate the next load. Reload once to pick that up.
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === '1') return
    sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    window.location.reload()
  } catch {
    // Registration blocked (e.g. Playwright's `serviceWorkers: 'block'` context option used by
    // this repo's e2e suite - see playwright.config.ts) or unsupported entirely - no-op.
  }
}

/**
 * The escape hatch for authStore.ts's sign-in recovery path (see that file and
 * coi-serviceworker.js's doc comment for why this is ever needed): unregisters the worker,
 * marks isolation disabled for the rest of this tab session (see ISOLATION_DISABLED_KEY's doc
 * comment above - without this, `ensureCrossOriginIsolated()` would just re-register on the very
 * next load and re-break the next popup-based token request), then reloads immediately so the
 * popup-based OAuth flow that just failed can be retried in a working, unisolated state.
 */
export async function disableCrossOriginIsolationAndReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister()))
    }
  } catch {
    // Fall through to reload regardless - an unregister failure shouldn't strand the user on an
    // isolated page that can never sign in.
  } finally {
    sessionStorage.removeItem(RELOAD_GUARD_KEY)
    sessionStorage.setItem(ISOLATION_DISABLED_KEY, '1')
    window.location.reload()
  }
}
