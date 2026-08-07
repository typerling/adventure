import type { FakeDriveStore } from '../../mocks/googleApi'
import type { Row } from '../../../src/lib/google/sheetsApi'
import { SHEET_TABS, type SheetTab } from '../../../src/types/sheets'
import { TAB_HEADERS } from '../../../src/lib/google/sheetSchema'

/**
 * Builds a full campaign folder directly in the fake Drive store from literal older-shaped
 * content, bypassing the app's own setup wizard entirely — the wizard (`campaignRepo.ts`'s
 * `createCampaign`) only ever writes *today's* shape, so it can't produce the older data these
 * fixtures need. Mirrors the wizard's real write order/layout (campaign.md, settings.md,
 * story/summary/rolling.md, and a "<name> — Data" spreadsheet with every current `SHEET_TABS`
 * tab) closely enough that `useCampaign.ts`'s normal read path — `loadCampaignFile`/
 * `loadSettings`/`loadSheetSnapshot`/`readRollingSummary`/`readRecentTurns` — works against it
 * unmodified, which is the whole point: these tests exercise the real app, not a stand-in.
 */
export interface LegacyCampaignFixture {
  /** Used as both the fake folder's name and the spreadsheet title prefix — doesn't need to be
   * URL-safe, the fake store has no real slug/filename constraints. */
  slug: string
  /** Literal campaign.md content with a `{{SPREADSHEET_ID}}` token where the spreadsheet's id
   * goes — filled in here once the fake spreadsheet exists, mirroring the real write order
   * (`createCampaign` creates the spreadsheet before campaign.md ever references it). */
  campaignMd: string
  settingsMd: string
  /** Per-tab row overrides, header row included at index 0. Any current `SHEET_TABS` tab not
   * listed here is seeded with just today's real header row (i.e. "fully up to date, no data
   * yet") — a fixture only needs to state the tab(s) whose *shape* it's actually testing. This
   * helper always creates every current tab; for a tab missing *entirely* (the #46/#47 case,
   * generalized in tests/backward-compat-sheet-tabs.spec.ts) use `createRandomCampaign` +
   * `FakeDriveStore.removeSheetTab` instead — simpler, and no less real. */
  sheetTabs?: Partial<Record<SheetTab, Row[]>>
}

export function seedLegacyCampaign(
  store: FakeDriveStore,
  fixture: LegacyCampaignFixture,
): { folderId: string; spreadsheetId: string } {
  const spreadsheet = store.createSpreadsheet(`${fixture.slug} — Data`, [...SHEET_TABS])
  for (const tab of SHEET_TABS) {
    store.setSheetRows(spreadsheet.id, tab, fixture.sheetTabs?.[tab] ?? [TAB_HEADERS[tab]])
  }

  const folder = store.createFolder(fixture.slug, ['root'])
  store.moveParents(spreadsheet.id, folder.id, 'root')

  store.createFile(
    'campaign.md',
    'text/markdown',
    [folder.id],
    fixture.campaignMd.replace('{{SPREADSHEET_ID}}', spreadsheet.id),
  )
  store.createFile('settings.md', 'text/markdown', [folder.id], fixture.settingsMd)

  const storyFolder = store.createFolder('story', [folder.id])
  const summaryFolder = store.createFolder('summary', [storyFolder.id])
  store.createFile(
    'rolling.md',
    'text/markdown',
    [summaryFolder.id],
    '_No story yet — this campaign has not started._',
  )

  return { folderId: folder.id, spreadsheetId: spreadsheet.id }
}
