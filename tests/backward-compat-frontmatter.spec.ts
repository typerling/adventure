import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { seedLegacyCampaign } from './fixtures/backward-compat/seedLegacyCampaign'
import { PHASE1_SETTINGS_MD } from './fixtures/backward-compat/legacySettingsMd'
import {
  CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
} from './fixtures/backward-compat/legacyCampaignMd'

/**
 * Frontmatter-*field* half of the backward-compatibility suite (see
 * tests/fixtures/backward-compat/README.md for the whole suite) — tab-*presence* coverage lives
 * in backward-compat-sheet-tabs.spec.ts, row-*shape* coverage in
 * backward-compat-row-shapes.spec.ts. Covers `CampaignSettings`/`CampaignMeta`
 * (`src/types/campaign.ts`), read via `campaignRepo.ts`'s `loadSettings`/`loadCampaignFile`.
 */

test('a real Phase-1 settings.md (missing claudeModel/localModelId/kokoroVoiceId entirely) loads with correct defaults', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  const { folderId } = seedLegacyCampaign(store, {
    slug: 'phase1-settings',
    campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
    settingsMd: PHASE1_SETTINGS_MD,
  })

  await page.goto(`/play/${folderId}`)
  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  // aiMode: 'manual' (present in the fixture) drives the manual copy/paste UI — if loadSettings'
  // default-merge had instead thrown or silently produced an unusable settings object, Play would
  // never reach this ready state at all.
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // claudeModel/localModelId/kokoroVoiceId aren't in the fixture at all — DEFAULT_SETTINGS must
  // have filled them in with the *right* defaults (not just "didn't crash"). Each field's select/
  // input is only mounted once its gating provider is selected, so switch modes (in-memory only,
  // never saved) to read what loadSettings actually produced for each. Trigger order shifts as
  // aiMode-gated selects appear (aiMode is always first; localModelId/claudeModel insert right
  // after it only while aiMode is 'local'/'api'), so the ttsProvider switch below is done first,
  // while aiMode is still the fixture's 'manual' and the trigger order is simply
  // [aiMode, sttProvider, ttsProvider] — the same assumption tests/helpers.ts's
  // setCampaignVoiceProviders/setCampaignAiMode make for manual mode.
  await page.goto(`/settings/${folderId}`)
  const triggers = page.locator('[data-testid="campaign-settings"] [data-slot="select-trigger"]')

  await triggers.nth(2).click()
  await page.getByRole('option', { name: 'Kokoro (on-device, runs locally)' }).click()
  // kokoroVoiceId is optional and absent from the fixture — should be undefined, not throw or
  // coerce to some stray value, rendered here as an empty free-text input.
  await expect(page.locator('#kokoroVoiceId')).toHaveValue('')

  await triggers.first().click()
  await page.getByRole('option', { name: 'Direct API key (Claude)' }).click()
  await expect(triggers.nth(1)).toContainText('Sonnet 5')

  await triggers.first().click()
  await page.getByRole('option', { name: 'Local model (runs on this device)' }).click()
  await expect(triggers.nth(1)).toContainText('Gemma 3 1B')
})

test('a campaign.md missing a CampaignMeta field entirely still loads (synthetic — see legacyCampaignMd.ts)', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  const { folderId } = seedLegacyCampaign(store, {
    slug: 'missing-location',
    campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
    settingsMd: PHASE1_SETTINGS_MD,
  })

  await page.goto(`/play/${folderId}`)
  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  // The rest of campaign.md's frontmatter (present in the fixture) still came through correctly —
  // proves the missing field degraded in isolation, not that the whole parse silently gave up.
  // The header's turn-info button's accessible name is `Turn ${currentTurn} · ${currentLocation}`
  // (Play.tsx's turnLabel) — currentTurn came through fine, currentLocation degraded to ''.
  await expect(page.getByRole('button', { name: /^Turn 0/ })).toBeVisible()
})
