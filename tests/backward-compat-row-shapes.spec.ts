import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { seedLegacyCampaign } from './fixtures/backward-compat/seedLegacyCampaign'
import {
  PRE_NPC_PROFILE_NPCS_HEADER,
  PRE_NPC_PROFILE_NPC_ROW,
  PRE_VOICE_CASTING_NPCS_HEADER,
  PRE_VOICE_CASTING_NPC_ROW,
} from './fixtures/backward-compat/legacyNpcRows'
import { PHASE1_SETTINGS_MD } from './fixtures/backward-compat/legacySettingsMd'
import { CAMPAIGN_MD_MISSING_CURRENT_LOCATION } from './fixtures/backward-compat/legacyCampaignMd'
import { decodeTab, TAB_HEADERS } from '../src/lib/google/sheetSchema'
import { SHEET_TABS } from '../src/types/sheets'

/**
 * Row-*shape* half of the backward-compatibility suite (see
 * tests/fixtures/backward-compat/README.md for the whole suite) — tab-*presence* coverage lives
 * in backward-compat-sheet-tabs.spec.ts, frontmatter-*field* coverage in
 * backward-compat-frontmatter.spec.ts.
 */

test('a real pre-NPC-profile NPCs tab (6 columns, missing voice/secrets/notes/detailFile) loads and renders', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  const { folderId } = seedLegacyCampaign(store, {
    slug: 'sunken-chapel-npcs',
    campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
    settingsMd: PHASE1_SETTINGS_MD,
    sheetTabs: {
      NPCs: [PRE_NPC_PROFILE_NPCS_HEADER, PRE_NPC_PROFILE_NPC_ROW],
    },
  })

  await page.goto(`/codex/${folderId}`)

  // Loads and decodes without throwing — the app doesn't even show an error state.
  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)

  await page.getByRole('tab', { name: 'NPCs' }).click()
  // Fields present in the legacy row render as normal.
  await expect(page.getByText('Old Maren')).toBeVisible()
  await expect(page.getByText('wary')).toBeVisible()
  await expect(page.getByText(/Keeper of the sunken chapel/)).toBeVisible()
  // Its status column (present in the legacy shape) survived positionally, not defaulted away.
  await expect(page.getByText('alive', { exact: true })).toBeVisible()

  // The turn loop itself still works against this campaign — proves the missing trailing columns
  // don't just render fine but stay silently unusable for actual play (e.g. a validator crashing
  // on an undefined field it assumed always exists).
  await page.goto(`/play/${folderId}`)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
})

test('a real pre-voice-casting NPCs tab (10 columns, missing voiceId/voiceSpeed/voiceLocked) loads with sane defaults', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  const { folderId } = seedLegacyCampaign(store, {
    slug: 'sunken-chapel-voice-casting',
    campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
    settingsMd: PHASE1_SETTINGS_MD,
    sheetTabs: {
      NPCs: [PRE_VOICE_CASTING_NPCS_HEADER, PRE_VOICE_CASTING_NPC_ROW],
    },
  })

  await page.goto(`/codex/${folderId}`)
  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await page.getByRole('tab', { name: 'NPCs' }).click()
  // Pre-existing fields (present in the legacy row) still render as normal.
  await expect(page.getByText('Corin the Warden')).toBeVisible()

  // The turn loop still works against this campaign — a garbage-free, decode-without-throwing
  // proof, same reasoning as the pre-NPC-profile test above.
  await page.goto(`/play/${folderId}`)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // Direct decode assertion: voiceId/voiceSpeed/voiceLocked default to '' / 0 / false for a row
  // that never had those columns at all, not undefined or a thrown error.
  const [decoded] = decodeTab<{ voiceId: string; voiceSpeed: number; voiceLocked: boolean }>('NPCs', [
    PRE_VOICE_CASTING_NPCS_HEADER,
    PRE_VOICE_CASTING_NPC_ROW,
  ])
  expect(decoded.voiceId).toBe('')
  expect(decoded.voiceSpeed).toBe(0)
  expect(decoded.voiceLocked).toBe(false)
})

/**
 * Systemic contract test, not tied to any one tab or historical shape: every tab's `fromRow`
 * codec must tolerate a row shorter than its current header without throwing, degrading missing
 * fields to the same safe defaults `str`/`num`/`bool` already document (empty string / 0 / false,
 * or a field's own documented fallback literal). This is the general mechanism the NPCs fixture
 * above is one concrete historical instance of — asserting it for every tab means the *next*
 * append-only column addition (on any tab, not just the one a past bug happened to hit) is
 * covered before it ships, not after it breaks a real campaign the way #46 did. Runs directly
 * against sheetSchema.ts, no browser/mock needed — this is a pure-function contract, not a
 * rendering concern.
 */
for (const tab of SHEET_TABS) {
  test(`${tab}'s row codec tolerates a row shorter than its current header`, () => {
    for (const shortRow of [[], [TAB_HEADERS[tab][0] ?? 'only-one-value']]) {
      expect(() => decodeTab(tab, [TAB_HEADERS[tab], shortRow])).not.toThrow()
      const [decoded] = decodeTab<Record<string, unknown>>(tab, [TAB_HEADERS[tab], shortRow])
      expect(decoded).toBeTruthy()
      for (const [key, value] of Object.entries(decoded)) {
        // Every field must have degraded to a defined, non-throwing primitive default — not
        // `undefined` leaking out of a positional array read past its end (the codec's own
        // documented "optional pointer" fields, e.g. detailFile, are the sole allowed exception).
        if (value === undefined) {
          // detailFile (NPCs/Lore) and x/y (Map) are documented optional pointer/coordinate
          // fields — `undefined` is their correct, intentional "not set" value, not a leak.
          expect(['detailFile', 'x', 'y'], `${tab}.${key} was undefined for a short row`).toContain(key)
        }
      }
    }
  })
}

/**
 * Known, deliberate limitation — NOT proof this is safe, the opposite: `fromRow` reads columns
 * purely by position, so a column *reordered* (as opposed to appended) inside an existing tab is
 * silently misread rather than caught or defaulted. Demonstrating the failure here (rather than
 * only describing it in a comment) is what makes CLAUDE.md's rule — any such reorder needs a real,
 * tested migration, not just an assumption that the coercion helpers will handle it — a checked
 * fact instead of an easy-to-forget aside. If this test ever starts failing because `fromRow`
 * became column-name-aware instead of positional, that's a real improvement — update this test
 * (and CLAUDE.md's rule) to match, don't just delete it.
 */
test('a reordered column is silently misread, not caught — no automatic protection exists', () => {
  const header = TAB_HEADERS.NPCs
  const correct = ['npc-002', 'Bram', 'The harbor watch captain.', 'friendly', 'alive', 5, '', '', '', '', '', 0, false]
  // Swap `relationship` and `status` — an existing-column reorder, not an append.
  const relationshipIdx = header.indexOf('relationship')
  const statusIdx = header.indexOf('status')
  const reordered = [...correct]
  ;[reordered[relationshipIdx], reordered[statusIdx]] = [reordered[statusIdx], reordered[relationshipIdx]]

  const [decoded] = decodeTab<{ relationship: string; status: string }>('NPCs', [header, reordered])

  // The values landed in the wrong fields — 'alive' where a relationship string was expected, and
  // 'friendly' where a status was expected. No enum validation catches this either: `status`'s
  // codec is `str(c[4]) || 'unknown'`, which only falls back on an empty/undefined cell — any
  // truthy string, including one from the wrong column entirely, is accepted as-is.
  expect(decoded.relationship).toBe('alive')
  expect(decoded.status).toBe('friendly')
})
