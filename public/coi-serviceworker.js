/**
 * Cross-origin isolation shim: a minimal service worker that injects the
 * `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
 * response headers GitHub Pages has no way to set natively (see CLAUDE.md's Deployment section),
 * so that `self.crossOriginIsolated` becomes true and ONNX Runtime Web's WASM backend (used by
 * `src/lib/voice/kokoroTts.worker.ts`) can switch from single- to multi-threaded execution via
 * SharedArrayBuffer. This is the well-known "coi-serviceworker" pattern
 * (github.com/gzuidhof/coi-serviceworker), reimplemented small and auditable here rather than
 * vendored, matching this repo's thin-hand-rolled-client convention (see driveApi.ts et al.).
 *
 * This is currently the ONLY service worker this app registers. DESIGN.md's "PWA (manifest +
 * service worker)" line was aspirational — only the installability manifest (manifest.webmanifest)
 * was ever actually implemented, so there was nothing for this one to conflict with (verified by
 * searching the whole repo for `serviceWorker`/`workbox`/`vite-plugin-pwa` before adding this -
 * none existed). If offline/install support is added later, extend THIS file's fetch handler
 * rather than registering a second service worker: only one can control a given scope, and two
 * independently-registered workers racing/overwriting each other's registration is exactly the
 * failure mode this file exists to avoid.
 *
 * IMPORTANT — read src/lib/coiServiceWorker.ts and authStore.ts's `recoverFromIsolatedPopupFailure`
 * before touching the header values below. Enabling cross-origin isolation has a real, confirmed
 * cost: it breaks Google Identity Services' popup-based OAuth flow. Verified by reading GIS's own
 * unminified `gsi/client.js` source (not assumed): both interactive sign-in AND background silent
 * token refresh go through the *same* code path (`TOKEN_CLIENT.requestAccessToken` ->
 * `_.Jd`/`window.open` -> the popup's own script calling `window.opener.postMessage(...)`), and
 * `Cross-Origin-Opener-Policy: same-origin` severs `window.opener` for that cross-origin popup —
 * confirmed empirically in real Chromium with a synthetic two-origin popup+postMessage test, not
 * just from spec-reading. Neither swapping COEP to `credentialless` nor anything else about COEP
 * changes this — it is entirely a COOP effect. `authStore.ts` detects the resulting
 * `popup_closed`/`popup_failed_to_open` GIS error while `self.crossOriginIsolated` is true and
 * unregisters this worker + reloads to recover sign-in, trading away the speed win rather than
 * leaving the user stuck signed out. Don't change these header values without re-reading that flow.
 */

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for a previous worker's clients to drop to zero —
  // there is no previous worker in this app (see the doc comment above), so there's nothing to
  // hand off from, and waiting would just delay the very first isolation reload.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Only GET requests, and only same-origin ones. Cross-origin requests (Google/ElevenLabs/
  // Anthropic API calls, the GIS script) are left completely untouched — they already carry
  // whatever CORS/CORP headers they need on the real response (verified for the GIS script: it
  // serves `Cross-Origin-Resource-Policy: cross-origin` today), and rewriting headers on a
  // response we don't control would be both unnecessary and a good way to break something.
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return

  event.respondWith(
    fetch(request).then((response) => {
      // Opaque/error responses carry no headers we can read or reconstruct - pass through as-is.
      if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
        return response
      }
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }),
  )
})
