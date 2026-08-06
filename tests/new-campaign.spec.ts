import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'

test.describe('new campaign flow', () => {
  test('shows an empty dashboard, then creates a campaign through the full wizard', async ({ page }) => {
    await installGoogleApiMock(page)

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Your adventures' })).toBeVisible()
    await expect(page.getByText('No campaigns yet')).toBeVisible()

    await page.getByRole('link', { name: 'Create your first campaign' }).click()
    await expect(page).toHaveURL(/\/new$/)

    // --- Step 0: Basics ---
    await expect(page.getByText('Basics', { exact: true })).toBeVisible()
    await page.locator('#name').fill('The Sunken Chapel')
    await page.locator('#genre').fill('Cozy fantasy village')
    await page.locator('[data-slot="select-trigger"]').click()
    await page.getByRole('option', { name: 'Hard' }).click()
    await page.getByRole('button', { name: 'Next' }).click()

    // --- Step 1: Character ---
    await expect(page.getByText('Character', { exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('Stat').first()).toHaveValue('Name')
    await page.getByPlaceholder('Value').first().fill('Elowen')
    await page.getByRole('button', { name: 'Next' }).click()

    // --- Step 2: Inventory ---
    await expect(page.getByText('Inventory', { exact: true }).first()).toBeVisible()
    await page.getByPlaceholder('Item name').first().fill('Rusty Dagger')
    await page.getByPlaceholder('Description (optional)').first().fill('Found in an alley.')
    await page.getByRole('button', { name: 'Next' }).click()

    // --- Step 3: World & expectations ---
    await expect(page.getByText('World & expectations', { exact: true })).toBeVisible()
    await page.locator('#world').fill('A quiet fishing town has started hearing bells from a chapel that sank a century ago.')
    await page.locator('#location').fill('The docks of Kelmouth')
    await page.getByRole('button', { name: 'Next' }).click()

    // --- Step 4: Review ---
    await expect(page.getByText(/The Sunken Chapel — Cozy fantasy village — Hard/)).toBeVisible()
    await expect(page.getByText(/3 stat\(s\), 1 item\(s\)/)).toBeVisible()

    await page.getByRole('button', { name: 'Create campaign' }).click()

    // --- Lands on the Play screen ---
    await expect(page).toHaveURL(/\/play\/.+/)
    // The campaign name now lives in the top-bar header ("Adventure - <name>"), not a page h1,
    // and the turn/location line is a header icon button (toasts the label on click) rather
    // than page body text.
    await expect(page.getByRole('link', { name: 'The Sunken Chapel' })).toBeVisible()
    await expect(page.getByTitle('Turn 0 · The docks of Kelmouth')).toBeVisible()
    await expect(page.getByText('Hard')).toBeVisible()
    await expect(page.getByText('No story yet — describe your first action below to begin.')).toBeVisible()

    // --- Data round-tripped through the mocked Sheets backend shows up in the Codex ---
    await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'Codex' }).click()
    await expect(page).toHaveURL(/\/codex\/.+/)
    await expect(page.getByText('Elowen')).toBeVisible()

    await page.getByRole('tab', { name: 'Inventory' }).click()
    await expect(page.getByText('Rusty Dagger')).toBeVisible()
    await expect(page.getByText('x1')).toBeVisible()

    // --- Back on the dashboard, the new campaign is now listed ---
    await page.goto('/')
    await expect(page.getByText('The Sunken Chapel', { exact: true })).toBeVisible()
    await expect(page.getByText('Turn 0')).toBeVisible()
  })

  test('creates a campaign via the Random campaign quick-fill, landing on /new directly', async ({ page }) => {
    await installGoogleApiMock(page)

    // Deliberately skip the dashboard: this is also a regression test for the "Library not
    // loaded yet" bug, where createCampaign assumed Dashboard's mount effect had already run.
    await page.goto('/new')

    const nameInput = page.locator('#name')
    await expect(nameInput).toHaveValue('')

    await page.getByRole('button', { name: 'Random campaign' }).click()
    await expect(nameInput).not.toHaveValue('')

    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'Next' }).click()
    }
    await expect(page.getByRole('button', { name: 'Create campaign' })).toBeVisible()

    await page.getByRole('button', { name: 'Create campaign' }).click()

    await expect(page).toHaveURL(/\/play\/.+/, { timeout: 10_000 })
    await expect(page.getByTitle(/^Turn 0/)).toBeVisible()
  })
})
