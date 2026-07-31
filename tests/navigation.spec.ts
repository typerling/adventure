import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

/**
 * Regression coverage for a real gap: the app's only "Settings" link anywhere (the top-bar
 * header) used to always go to /settings with no campaign ID, and that page hides the AI mode
 * selector entirely without one — so a campaign's own Settings (AI mode, voice providers) was
 * reachable only by typing /settings/:campaignId directly. The header's single Settings link is
 * now campaign-aware (src/store/playHeaderStore.ts) — it points at the currently open campaign
 * whenever one is active, and at plain /settings otherwise.
 */
test.describe('reaching a campaign\'s own Settings', () => {
  test('is reachable from the Play screen', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await expect(page.getByRole('link', { name: 'Codex' })).toBeVisible()
    await page.getByRole('link', { name: 'Settings' }).click()

    await expect(page).toHaveURL(/\/settings\/.+/)
    await expect(page.getByText('This campaign', { exact: true })).toBeVisible()
    await expect(page.getByText('AI mode', { exact: true })).toBeVisible()
  })

  test('is reachable from the Dashboard', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await page.goto('/')
    await page.getByRole('link', { name: 'Campaign settings' }).click()

    await expect(page).toHaveURL(/\/settings\/.+/)
    await expect(page.getByText('This campaign', { exact: true })).toBeVisible()
    await expect(page.getByText('AI mode', { exact: true })).toBeVisible()
  })
})

/**
 * Play/Codex/Settings used to each carry their own Codex/Settings/"Back to play" links, separate
 * from (and inconsistent with) the top-bar header's own single global Settings link. They now all
 * share one header (src/store/playHeaderStore.ts): exactly one Settings link and one Codex link,
 * both campaign-aware, plus the campaign name shown as "Adventure - <name>".
 */
test.describe('the top-bar header merges campaign navigation', () => {
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

  test('shows the campaign name and exactly one Codex/Settings link on Play, Codex, and Settings', async ({
    page,
  }) => {
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

    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings\/.+/)
    await expect(page.getByTitle('Back to play')).toHaveText(campaignName ?? '')
    await expect(page.getByRole('link', { name: 'Codex' })).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(1)
  })

  test('the turn/location icon button opens a dialog, not a toast', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    const turnButton = page.getByTitle(/^Turn 0/)
    await expect(turnButton).toBeVisible()
    const label = await turnButton.getAttribute('title')

    await turnButton.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Where you are', { exact: true })).toBeVisible()
    await expect(dialog.getByText(label ?? '', { exact: true })).toBeVisible()
    // No toast — this used to just fire a Sonner toast instead of a dismissable dialog.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

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
