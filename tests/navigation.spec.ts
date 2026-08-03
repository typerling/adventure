import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, getRecordedToasts, recordToasts } from './helpers'

/**
 * Regression coverage for a real gap: a campaign's own settings (AI mode, voice providers) used
 * to live on the same page as device-global settings, gated on a `:campaignId` route param that
 * was easy to lose. They're now Codex's final "Settings" tab (src/pages/Codex.tsx) — reachable
 * from Play via the Codex link, and directly from the Dashboard via a `?tab=settings` deep link.
 */
test.describe("reaching a campaign's own settings", () => {
  test('is reachable from the Play screen via Codex', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await page.getByRole('link', { name: 'Codex' }).click()
    await expect(page).toHaveURL(/\/codex\/.+/)
    await page.getByRole('tab', { name: 'Settings' }).click()

    await expect(page.getByText('This campaign', { exact: true })).toBeVisible()
    await expect(page.getByText('AI mode', { exact: true })).toBeVisible()
  })

  test('is reachable directly from the Dashboard', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await page.goto('/')
    await page.getByRole('link', { name: 'Campaign settings' }).click()

    await expect(page).toHaveURL(/\/codex\/.+\?tab=settings/)
    await expect(page.getByText('This campaign', { exact: true })).toBeVisible()
    await expect(page.getByText('AI mode', { exact: true })).toBeVisible()
  })
})

/**
 * Settings (src/pages/Settings.tsx) is device-global now — not campaign-scoped at all — so its
 * header link is always the same plain `/settings` regardless of whether a campaign is open, and
 * stays visible at every viewport width (no more deferring to BottomNav on mobile). Play/Codex
 * still share one header (src/store/playHeaderStore.ts) for the campaign title, the Codex link,
 * and the campaign name shown as "Adventure - <name>".
 */
test.describe('the top-bar header', () => {
  test('shows just "Adventure" with no campaign chrome when no campaign is open', async ({ page }) => {
    await installGoogleApiMock(page)
    await page.goto('/')

    await expect(page.getByRole('link', { name: 'Adventure' })).toBeVisible()
    await expect(page.getByTitle('Back to play')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Codex' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(1)
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('shows the campaign name and exactly one Codex link on Play and Codex', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    const campaignLink = page.getByTitle('Back to play')
    await expect(campaignLink).toBeVisible()
    const campaignName = await campaignLink.textContent()
    await expect(page.getByRole('link', { name: 'Codex' })).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(1)

    await page.getByRole('link', { name: 'Codex' }).click()
    await expect(page).toHaveURL(/\/codex\/.+/)
    await expect(page.getByTitle('Back to play')).toHaveText(campaignName ?? '')
    await expect(page.getByRole('link', { name: 'Codex' })).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(1)
  })

  test('Settings always points at the same global page, even with a campaign open', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    // Leaving the campaign entirely — Settings is device-global, so the header drops back to
    // the plain "Adventure" logo instead of showing the campaign that was open.
    await expect(page.getByTitle('Back to play')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Adventure' })).toBeVisible()
  })

  test('the turn/location icon button opens a dialog, not a toast', async ({ page }) => {
    await installGoogleApiMock(page)
    await recordToasts(page)
    await createRandomCampaign(page)

    const turnButton = page.getByTitle(/^Turn 0/)
    await expect(turnButton).toBeVisible()
    const label = await turnButton.getAttribute('title')

    await turnButton.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Where you are', { exact: true })).toBeVisible()
    await expect(dialog.getByText(label ?? '', { exact: true })).toBeVisible()
    // No toast — this used to just fire a Sonner toast instead of a dismissable dialog. Asserted
    // against the recorded history rather than a live locator: `toHaveCount(0)` auto-retries and
    // toasts auto-dismiss, so that spelling passes even when a toast did appear (see recordToasts).
    expect(await getRecordedToasts(page)).not.toContainEqual(expect.stringMatching(/^Turn 0/))

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})

/**
 * "Standard" is the default difficulty (NewCampaign.tsx) and the one the Random-fill quick
 * button leaves in place — showing a chip for it on every single campaign card/header would just
 * be noise, so it's hidden; only a deliberately-chosen non-default difficulty is worth flagging.
 */
test.describe('the "Standard" difficulty chip is hidden', () => {
  test('is not shown on Play or the Dashboard for a Standard-difficulty campaign', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page) // Random-fill never touches difficulty — stays "Standard".

    await expect(page.getByText('Standard', { exact: true })).toHaveCount(0)

    await page.goto('/')
    await expect(page.getByText('Standard', { exact: true })).toHaveCount(0)
  })
})
