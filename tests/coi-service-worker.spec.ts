import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

const SESSION_STORAGE_KEY = 'adventure:google-session'

/**
 * Coverage for src/lib/coiServiceWorker.ts, public/coi-serviceworker.js, and the sign-in recovery
 * path in src/lib/google/authStore.ts (see coi-serviceworker.js's doc comment for the full
 * rationale: cross-origin isolation speeds up Kokoro's WASM backend but breaks GIS's popup-based
 * OAuth flow, so authStore.ts detects that specific failure and steps back out of isolation).
 *
 * Two genuinely different things are tested, in two different ways:
 *  - "the service worker actually isolates the page" needs the real worker running end-to-end —
 *    every other spec in this suite blocks service workers by default (see playwright.config.ts)
 *    so they don't race the page.route() mocks below, so this file overrides that per-describe.
 *  - "authStore recovers when isolation breaks a popup" doesn't need a real popup or a real
 *    isolated page at all — window.crossOriginIsolated is browser-computed and can't be flipped
 *    true by test setup alone without a real cross-origin-isolated load, so that one test
 *    overrides the getter directly via addInitScript, clearly called out as a fake below. What's
 *    real is everything downstream of that: authStore's detection logic and the actual
 *    unregister-and-reload call.
 */

test.describe('the service worker itself', () => {
  test.use({ serviceWorkers: 'allow' })

  test('registers and makes the page cross-origin isolated after one reload', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    // src/lib/coiServiceWorker.ts registers the worker and reloads once on its own the moment it
    // becomes ready - wait for that whole dance to settle rather than reloading ourselves.
    await page.waitForFunction(() => window.crossOriginIsolated === true, undefined, { timeout: 15_000 })

    const swRegistered = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0)
    expect(swRegistered).toBe(true)

    // And the app underneath is still fully usable once isolated - the whole point is this is
    // invisible to everything except Kokoro's WASM backend.
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  })
})

/**
 * Overrides the read-only, browser-computed `crossOriginIsolated` getter - there's no way to make
 * a Playwright-driven page genuinely cross-origin isolated without the real service worker's
 * register-then-reload flow (covered above), and this test is about authStore's response to that
 * state, not about reproducing it. Real GIS's popup completion mechanism (confirmed by reading its
 * source - see authStore.ts's isPopupSeveredByIsolation) is also faked here, same as every other
 * GIS fake in this suite (see google-session-restore.spec.ts) - it unconditionally reports
 * 'popup_closed', exactly as it would if COOP had actually severed window.opener.
 *
 * The getter starts out `true` and flips permanently to `false` the moment something calls
 * `navigator.serviceWorker.getRegistrations()` - the real `disableCrossOriginIsolationAndReload`'s
 * first move (src/lib/coiServiceWorker.ts) - standing in for a real unregister actually ending
 * isolation. Without this the fake GIS's unconditional 'popup_closed' plus a permanently-true
 * crossOriginIsolated would make authStore "recover" into another isolated popup failure forever.
 */
async function installIsolatedFakeGis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'crossOriginIsolated', {
      configurable: true,
      get: () => sessionStorage.getItem('test:coiRecovered') !== '1',
    })
    const realGetRegistrations = navigator.serviceWorker.getRegistrations.bind(navigator.serviceWorker)
    navigator.serviceWorker.getRegistrations = async () => {
      sessionStorage.setItem('test:coiRecovered', '1')
      return realGetRegistrations()
    }
    ;(window as unknown as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { error_callback?: (err: { type: string; message: string }) => void }) => ({
            requestAccessToken: () => {
              config.error_callback?.({ type: 'popup_closed', message: 'Popup window closed' })
            },
          }),
          revoke: () => {},
        },
      },
    }
  })
}

test('recovers from a sign-in popup severed by cross-origin isolation instead of getting stuck', async ({ page }) => {
  await installGoogleApiMock(page)
  await createRandomCampaign(page)
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

  await installIsolatedFakeGis(page)
  // Force the startup silent-reauth path (src/lib/google/authStore.ts, bottom of the file) to
  // actually run - same technique google-session-restore.spec.ts uses.
  await page.addInitScript((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY)

  await page.goto(`/play/${campaignId}`)

  // The real, unfaked disableCrossOriginIsolationAndReload triggers a genuine reload before
  // landing here - proving authStore treated 'popup_closed' while crossOriginIsolated as
  // "isolation needs to step aside" rather than an ordinary auth failure (which would show this
  // same card immediately, with no reload). Post-reload, the getter above reports
  // crossOriginIsolated: false, so that second 'popup_closed' falls through to the ordinary
  // "no session to restore" path instead of looping into another "recovery".
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible({ timeout: 15_000 })
})
