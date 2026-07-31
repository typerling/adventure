import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

const SESSION_STORAGE_KEY = 'adventure:google-session'

/**
 * Fakes window.google.accounts.oauth2 so a reload can exercise authStore's startup silent-reauth
 * path (src/lib/google/authStore.ts) without a real Google account. installGoogleApiMock already
 * stubs the GIS script network request to return an empty body (never expecting it to run real
 * code); this defines window.google directly via addInitScript, which still runs before that
 * empty script tag loads, so authStore's `window.google` check finds it either way.
 */
async function installFakeGis(page: Page, silentReauth: 'succeed' | 'fail'): Promise<void> {
  await page.addInitScript((mode) => {
    ;(window as unknown as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            callback: (res: Record<string, unknown>) => void
            error_callback?: (err: { type: string }) => void
          }) => ({
            requestAccessToken: (override?: { prompt?: string }) => {
              if (override?.prompt === '' && mode === 'fail') {
                config.callback({ error: 'access_denied', error_description: 'no active session' })
                return
              }
              config.callback({
                access_token: override?.prompt === '' ? 'silently-restored-token' : 'interactive-token',
                expires_in: 3600,
                scope: '',
                token_type: 'Bearer',
              })
            },
          }),
          revoke: () => {},
        },
      },
    }
  }, silentReauth)
}

/**
 * Same fake, but the callback fires **asynchronously** — as real GIS does — and it counts how many
 * token requests were issued. The synchronous fake above cannot expose ordering bugs: it resolves
 * before a second caller can overwrite the shared handler, which is exactly why a bug where
 * concurrent token requests never settled was invisible to these tests.
 */
async function installAsyncFakeGis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__gisRequests = 0
    ;(w as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (res: Record<string, unknown>) => void }) => ({
            requestAccessToken: () => {
              const n = (w.__gisRequests as number) + 1
              w.__gisRequests = n
              setTimeout(
                () =>
                  config.callback({
                    access_token: `async-token-${n}`,
                    // The first token comes back already inside authStore's 60s staleness margin,
                    // so the parallel reads that follow all need a refresh at the same moment.
                    // Later ones are fresh, so the refresh converges instead of looping.
                    expires_in: n === 1 ? 0 : 3600,
                    scope: '',
                    token_type: 'Bearer',
                  }),
                40,
              )
            },
          }),
          revoke: () => {},
        },
      },
    }
  })
}

test('parallel calls hitting a stale token share one refresh instead of hanging', async ({ page }) => {
  // Regression test. requestToken kept a single module-level handler, so with overlapping requests
  // every handler but the last was overwritten before GIS's async callback fired — those promises
  // never resolved *or* rejected, leaving a permanent "Loading campaign…" spinner. useCampaign
  // loads four things via Promise.all, so one stale token fans out into four simultaneous
  // refreshes. Note this needs the *async* GIS fake: the synchronous one settles each request
  // before the next can clobber it, which is why the existing tests never caught this.
  await installGoogleApiMock(page)
  await installAsyncFakeGis(page)
  await createRandomCampaign(page)
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

  // Drop the pre-seeded session so the next load goes through the real startup-reauth path and
  // picks up the deliberately-stale first token above.
  await page.addInitScript((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY)
  await page.goto(`/play/${campaignId}`)

  // The real assertion: the page finishes loading at all. With the bug the refresh promises never
  // settled, so this sat on the spinner until the test timed out.
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Loading campaign…')).toHaveCount(0)

  // And the concurrent callers coalesced rather than each firing its own GIS request.
  const gisRequests = await page.evaluate(() => (window as unknown as Record<string, number>).__gisRequests)
  expect(gisRequests).toBeGreaterThan(1) // startup restore + at least one refresh
  expect(gisRequests).toBeLessThanOrEqual(3) // but not one per parallel reader
})

test.describe('Google session restore across reloads', () => {
  test('a cleared/expired local session is silently restored on load, with no sign-in click', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeGis(page, 'succeed')
    await createRandomCampaign(page)

    // Simulate what prompted the original bug report: the persisted session is gone (expired,
    // or storage was cleared) by the time the app reloads. installGoogleApiMock's own
    // addInitScript re-seeds a valid session on every navigation, so undo that with a second
    // init script registered after it — init scripts run in registration order on every load,
    // including the reload below.
    await page.addInitScript((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY)
    await page.reload()

    // Reload keeps the same /play/:id URL and lands back on it signed-in, on its own — no
    // "Sign in with Google" click needed. (The fake GIS callback above resolves synchronously, so
    // the transient 'restoring' state — see AuthGate's "Reconnecting to Google Drive…" branch —
    // isn't reliably observable here; that's the fast, non-flashing outcome this path is for.)
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).not.toBeVisible()
  })

  test('falls back to the interactive sign-in card when silent restore has nothing to restore', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeGis(page, 'fail')
    await createRandomCampaign(page)

    await page.addInitScript((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY)
    await page.reload()

    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
  })
})
