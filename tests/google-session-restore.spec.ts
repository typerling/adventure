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
