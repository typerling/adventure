import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet'

/**
 * Regression coverage for a real production bug: SHEET_TABS has grown over time (most recently
 * gaining NPCAttributes when NPC profiles shipped, #30/PR #37), but nothing ever backfilled that
 * new tab into campaigns whose spreadsheets were created before it existed. Sheets' batchGet
 * fails the *entire* request if even one referenced tab doesn't exist, so opening any such
 * campaign failed outright with "Couldn't load this campaign: Google API request failed (400)…" —
 * every existing campaign predating that PR was permanently unopenable. See
 * campaignRepo.ts's loadSheetSnapshot / isMissingTabError and sheetsApi.ts's addMissingTabs.
 */
test('a campaign whose spreadsheet predates a newer tab is healed automatically instead of failing to load', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await createRandomCampaign(page)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // Simulate an older campaign's spreadsheet — created before NPCAttributes existed.
  const spreadsheet = store.allFiles().find((f) => f.mimeType === SPREADSHEET_MIME)
  if (!spreadsheet) throw new Error('no spreadsheet file found in the fake store')
  store.removeSheetTab(spreadsheet.id, 'NPCAttributes')

  await page.reload()

  // Loads successfully — not stuck on the error this bug produced.
  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // The tab was actually backfilled in the spreadsheet, not just tolerated for this one load —
  // a second full reload (a fresh batchGet against the now-healed spreadsheet, no special-casing
  // left over from the first load) still works.
  await page.reload()
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // The healed tab actually has a real header row, not just an empty sheet with the right name —
  // proves the atomic addSheet+updateCells write in addMissingTabs genuinely wrote the header,
  // not just created the tab (see that function's doc comment on why this is one atomic call).
  const healed = store.get(spreadsheet.id)?.spreadsheet?.sheets.NPCAttributes
  expect(healed?.rows[0]).toBeTruthy()
  expect(healed?.rows[0].length).toBeGreaterThan(0)
})

test('a spreadsheet already missing nothing loads with no extra requests needed', async ({ page }) => {
  // Sanity check the common case isn't affected: a fully up-to-date spreadsheet loads in one
  // batchGet, same as before this fix — addMissingTabs (and its metadata-GET existence check) is
  // never reached.
  await installGoogleApiMock(page)
  await createRandomCampaign(page)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  let metadataGetCount = 0
  page.on('request', (req) => {
    // The bare spreadsheet-metadata GET addMissingTabs uses — no :suffix, unlike batchGet/
    // batchUpdate — so this only counts the request that function would make, not every request.
    if (/\/v4\/spreadsheets\/[^/:]+$/.test(new URL(req.url()).pathname) && req.method() === 'GET') {
      metadataGetCount++
    }
  })
  await page.reload()
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  expect(metadataGetCount).toBe(0)
})
