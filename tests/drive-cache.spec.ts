import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

/**
 * Regression coverage for a real gap: useCampaign() re-ran its full Drive/Sheets load (campaign
 * file, sheet snapshot, rolling summary, turn log) on every mount, and Settings.tsx separately
 * re-fetched settings.md on every mount too — so navigating Play -> Codex -> Settings -> back to
 * Play re-hit Drive/Sheets from scratch at every single stop, even though nothing had changed.
 * src/hooks/campaignCache.ts now caches this per campaign for the page session.
 */
test('revisiting a campaign this session reuses cached Drive/Sheets data instead of re-fetching', async ({
  page,
}) => {
  await installGoogleApiMock(page)
  await createRandomCampaign(page)

  // createRandomCampaign only waits for the URL to reach /play/:id, not for useCampaign's own
  // async load to finish — wait for that too before counting requests, or the still-in-flight
  // *initial* batchGet can get counted as if it were a redundant re-fetch.
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // Client-side SPA navigation (clicking Links), not page.goto() — a real page.goto() is a full
  // reload, which legitimately clears the in-memory cache this test is checking (see
  // campaignCache.ts). The cache is about avoiding redundant fetches during in-app navigation.
  let sheetsBatchGets = 0
  page.on('request', (req) => {
    if (req.url().includes('sheets.googleapis.com') && req.url().includes(':batchGet')) sheetsBatchGets++
  })

  await page.getByRole('link', { name: 'Codex' }).click()
  await expect(page.getByRole('tab', { name: 'Inventory' })).toBeVisible()

  // The campaign name in the top-bar header doubles as "back to play" (title attribute, stable
  // regardless of the actual random campaign name used here).
  await page.getByTitle('Back to play').click()
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByText('AI mode', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // The campaign's spreadsheet was fetched once, when the campaign was first created/opened —
  // none of the four subsequent navigations above re-issued a batchGet for it.
  expect(sheetsBatchGets).toBe(0)
})
