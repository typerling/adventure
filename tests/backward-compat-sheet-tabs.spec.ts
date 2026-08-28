import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'
import { SHEET_TABS } from '../src/types/sheets'

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet'

/**
 * Sheet-tab *presence* half of the backward-compatibility suite (see
 * tests/fixtures/backward-compat/README.md for the whole suite and why fixtures here don't need
 * updating as SHEET_TABS keeps growing) — row-*shape* coverage lives in
 * backward-compat-row-shapes.spec.ts, frontmatter-*field* coverage in
 * backward-compat-frontmatter.spec.ts.
 *
 * The first test below is the original regression coverage for issue #46, a real production bug:
 * SHEET_TABS grew a new tab (NPCAttributes, when NPC profiles shipped, #30/PR #37), but nothing
 * ever backfilled that tab into campaigns whose spreadsheets were created before it existed.
 * Sheets' batchGet fails the *entire* request if even one referenced tab doesn't exist, so opening
 * any such campaign failed outright with "Couldn't load this campaign: Google API request failed
 * (400)…" — every existing campaign predating that PR was permanently unopenable. #47 fixed it
 * (auto-backfill missing tabs, see campaignRepo.ts's loadSheetSnapshot / isMissingTabError and
 * sheetsApi.ts's addMissingTabs) — this file is that fix's regression test, folded into this
 * issue's general suite rather than left sitting outside it as a one-off (issue #49's explicit
 * ask), plus two tests generalizing it beyond that one specific tab name: the healing path isn't
 * special-cased to NPCAttributes (loadSheetSnapshot always passes addMissingTabs the *whole*
 * current SHEET_TABS list, not a hardcoded one), and it isn't limited to healing exactly one tab
 * per load either.
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

test('healing is not special-cased to NPCAttributes — any missing tab is backfilled the same way', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await createRandomCampaign(page)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  const spreadsheet = store.allFiles().find((f) => f.mimeType === SPREADSHEET_MIME)
  if (!spreadsheet) throw new Error('no spreadsheet file found in the fake store')
  // A tab present since this app's very first commit, unrelated to the #46 NPCAttributes case —
  // proves the recovery path is generic over "whatever's missing," not hardcoded to one name.
  store.removeSheetTab(spreadsheet.id, 'Lore')

  await page.reload()

  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  const healed = store.get(spreadsheet.id)?.spreadsheet?.sheets.Lore
  expect(healed?.rows[0]).toBeTruthy()
  expect(healed?.rows[0].length).toBeGreaterThan(0)
})

test('a campaign whose spreadsheet predates the Threads tab (issue #83) is healed the same way', async ({
  page,
}) => {
  // Threads (issue #83's foreshadowed-thread/clock tracking) is the newest tab SHEET_TABS has
  // grown — this is that specific case's fixture, per the README's "add a fresh one anyway if
  // it's the first fixture to model that shape" guidance, even though the generic loop below
  // already covers it incidentally.
  const store = await installGoogleApiMock(page)
  await createRandomCampaign(page)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  const spreadsheet = store.allFiles().find((f) => f.mimeType === SPREADSHEET_MIME)
  if (!spreadsheet) throw new Error('no spreadsheet file found in the fake store')
  store.removeSheetTab(spreadsheet.id, 'Threads')

  await page.reload()

  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  const healed = store.get(spreadsheet.id)?.spreadsheet?.sheets.Threads
  expect(healed?.rows[0]).toBeTruthy()
  expect(healed?.rows[0].length).toBeGreaterThan(0)

  // The turn loop itself still works against a freshly healed Threads tab, not just the Codex/load
  // path — proves an empty Threads snapshot doesn't break prompt-building or submission.
  await page.reload()
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
})

test('multiple missing tabs are all backfilled in a single heal, not one at a time', async ({ page }) => {
  const store = await installGoogleApiMock(page)
  await createRandomCampaign(page)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  const spreadsheet = store.allFiles().find((f) => f.mimeType === SPREADSHEET_MIME)
  if (!spreadsheet) throw new Error('no spreadsheet file found in the fake store')
  store.removeSheetTab(spreadsheet.id, 'NPCAttributes')
  store.removeSheetTab(spreadsheet.id, 'Skills')

  await page.reload()

  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  const sheets = store.get(spreadsheet.id)?.spreadsheet?.sheets ?? {}
  for (const tab of SHEET_TABS) {
    expect(sheets[tab]?.rows[0], `expected ${tab} to have a header row after healing`).toBeTruthy()
  }
})
