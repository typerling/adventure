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
 */

const RELOAD_GUARD_KEY = 'adventure:coi-reload-attempted'

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
 * coi-serviceworker.js's doc comment for why this is ever needed): unregisters the worker and
 * clears the reload guard so the *next* load is no longer isolated, then reloads immediately so
 * the popup-based OAuth flow that just failed can be retried in a working state.
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
    window.location.reload()
  }
}
