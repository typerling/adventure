import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi } from './mocks/webSpeech'
import { seedLegacyCampaign } from './fixtures/backward-compat/seedLegacyCampaign'
import {
  PHASE1_SETTINGS_MD,
  PRE_GLOBAL_SETTINGS_SETTINGS_MD,
  PRE_PLAYER_VOICE_SETTINGS_MD,
} from './fixtures/backward-compat/legacySettingsMd'
import {
  CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
} from './fixtures/backward-compat/legacyCampaignMd'

/**
 * Frontmatter-*field* half of the backward-compatibility suite (see
 * tests/fixtures/backward-compat/README.md for the whole suite) — tab-*presence* coverage lives
 * in backward-compat-sheet-tabs.spec.ts, row-*shape* coverage in
 * backward-compat-row-shapes.spec.ts. Covers `CampaignSettings`/`CampaignMeta`
 * (`src/types/campaign.ts`), read via `campaignRepo.ts`'s `loadSettings`/`loadCampaignFile` — and,
 * since issue #77, the one-time legacy-settings.md -> global-settings migration those reads can
 * trigger (`src/lib/settings/globalSettings.ts`'s `seedGlobalSettingsFromLegacyIfNeeded`).
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
  // Loading this campaign's settings.md (aiMode: 'manual', present in the fixture) must not throw
  // or produce an unusable settings object — if it had, Play would never reach this ready state.
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // claudeModel/localModelId/kokoroVoiceId aren't in the fixture at all, and this fixture's
  // aiMode/sttProvider/ttsProvider values happen to already equal DEFAULT_GLOBAL_SETTINGS — so
  // the *global* AI & voice settings (issue #77 — no longer per campaign) must show today's real
  // defaults for every field, not just "didn't crash". Each field's select/input is only mounted
  // once its gating provider is selected, so switch modes (global, saved to localStorage) to read
  // what the app actually produced for each.
  await page.goto('/settings')
  const triggers = page.locator('[data-testid="global-settings"] [data-slot="select-trigger"]')

  // AI mode (0), Speech-to-text (1), Text-to-speech (2) while aiMode is 'manual'.
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

test('a pre-#98 settings.md (missing playerVoiceId entirely) loads with a sane default', async ({ page }) => {
  const store = await installGoogleApiMock(page)
  const { folderId } = seedLegacyCampaign(store, {
    slug: 'pre-player-voice',
    campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
    settingsMd: PRE_PLAYER_VOICE_SETTINGS_MD,
  })

  await page.goto(`/play/${folderId}`)
  await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

  // The rest of the fixture's shape (summarizationCadence: 25, non-default) came through fine —
  // proves the missing playerVoiceId key degraded in isolation, not that the whole parse fell
  // back to every field's default.
  await page.goto(`/settings/${folderId}`)
  await expect(page.locator('#cadence')).toHaveValue('25')

  // playerVoiceId itself: undefined, not a thrown error or some stray coerced value. Its field is
  // only mounted once TTS is switched to Kokoro (same gating the narrator's own kokoroVoiceId
  // field already uses).
  const triggers = page.locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
  await triggers.nth(2).click()
  await page.getByRole('option', { name: 'Kokoro (on-device, runs locally)' }).click()
  await expect(page.locator('#playerVoiceId')).toHaveValue('')
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

test.describe('issue #77: legacy settings.md seeds the global settings store on first load', () => {
  test("a pre-#77 settings.md's non-default aiMode/model/voice values are migrated into the global store, but its since-removed ElevenLabs sttProvider/ttsProvider values (issue #97) are skipped in favor of working defaults", async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    const { folderId } = seedLegacyCampaign(store, {
      slug: 'pre-global-settings',
      campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
      settingsMd: PRE_GLOBAL_SETTINGS_SETTINGS_MD,
    })

    // Reading this campaign's settings.md (via Play's normal load path) is what triggers the
    // one-time migration — nothing Settings-specific about the trigger.
    await page.goto(`/play/${folderId}`)
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    await page.goto('/settings')
    const triggers = page.locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
    // aiMode (api) migrated -> claudeModel select is mounted, showing the migrated Opus 5, not
    // the DEFAULT_GLOBAL_SETTINGS Sonnet 5 default.
    await expect(triggers.first()).toContainText('Direct API key (Claude)')
    await expect(triggers.nth(1)).toContainText('Opus 5')

    // The fixture's sttProvider/ttsProvider are both the since-removed 'elevenlabs' (issue #97) —
    // `pickLegacyGlobalFields`' `isOneOf` checks against the now-narrowed STT_PROVIDERS/
    // TTS_PROVIDERS unions fail for that value exactly like any other unrecognized/missing field,
    // so it's skipped here and DEFAULT_GLOBAL_SETTINGS' 'browser'/'browser' apply instead — a
    // *working* fallback, not a null/dead provider. Trigger order here is [aiMode, claudeModel,
    // sttProvider, ttsProvider] — the migrated aiMode 'api' inserts the Claude-model select before
    // STT/TTS, unlike the 'manual' trigger order ([aiMode, sttProvider, ttsProvider]) other tests
    // assume.
    await expect(triggers.nth(2)).toContainText('Browser (Web Speech API)')
    await expect(triggers.nth(3)).toContainText('Browser (SpeechSynthesis)')
    // There's no ElevenLabs voice ID field to migrate into any more — CampaignSettings/
    // GlobalSettings' elevenLabsVoiceId field was removed along with the provider (issue #97).
    await expect(page.locator('#voiceId')).toHaveCount(0)

    // The independent kokoroVoiceId field still migrates correctly regardless — it's a free
    // string, not validated against an enum, so ElevenLabs' removal doesn't touch it. Switch to
    // Kokoro to read it.
    await triggers.nth(3).click()
    await page.getByRole('option', { name: 'Kokoro (on-device, runs locally)' }).click()
    await expect(page.locator('#kokoroVoiceId')).toHaveValue('legacy-kokoro-voice-id')
  })

  test('issue #97: that same pre-#77, ElevenLabs-picking settings.md still resolves to a genuinely working mic button and read-aloud toggle on Play, not just a non-throwing load', async ({
    page,
  }) => {
    // Guarantees isSttProviderAvailable('browser')/isTtsProviderAvailable('browser') resolve true
    // in this headless run — without it, whether the coerced/defaulted providers are genuinely
    // "available" would depend on whatever (un)supported Web Speech API headless Chromium happens
    // to ship, making the assertions below flaky rather than a real proof this lands on *working*
    // providers.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    const store = await installGoogleApiMock(page)
    const { folderId } = seedLegacyCampaign(store, {
      slug: 'pre-global-settings-elevenlabs-play',
      campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
      settingsMd: PRE_GLOBAL_SETTINGS_SETTINGS_MD,
    })

    await page.goto(`/play/${folderId}`)
    await expect(page.getByText("Couldn't load this campaign", { exact: false })).toHaveCount(0)
    // The mic button only renders when isSttProviderAvailable(globalSettings.sttProvider) is true
    // (Play.tsx's sttAvailable) — for the fixture's literal `sttProvider: elevenlabs`,
    // isSttProviderAvailable now returns false unconditionally (the case removed), so this button
    // would be entirely absent without the fallback onto 'browser'.
    await expect(page.getByRole('button', { name: 'Speak your action' })).toBeVisible()
    // Same reasoning for the header's read-aloud toggle (Play.tsx's showReadAloudToggle ties
    // directly to ttsAvailable) — the fixture's literal `ttsProvider: elevenlabs` would otherwise
    // leave it permanently hidden, not just defaulted to off.
    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toBeVisible()
  })

  test('only the first campaign whose settings.md is ever read seeds the global store — a second, differently-configured legacy campaign does not overwrite it', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    const first = seedLegacyCampaign(store, {
      slug: 'first-legacy',
      campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
      settingsMd: PRE_GLOBAL_SETTINGS_SETTINGS_MD,
    })
    const second = seedLegacyCampaign(store, {
      slug: 'second-legacy',
      campaignMd: CAMPAIGN_MD_MISSING_CURRENT_LOCATION,
      settingsMd: PHASE1_SETTINGS_MD,
    })

    // Load the first campaign first — its (non-default) values win the migration.
    await page.goto(`/play/${first.folderId}`)
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    // Loading a second, differently-configured legacy campaign afterward must not re-run the
    // migration and clobber what's already there.
    await page.goto(`/play/${second.folderId}`)
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    await page.goto('/settings')
    const triggers = page.locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
    await expect(triggers.first()).toContainText('Direct API key (Claude)')
    await expect(triggers.nth(1)).toContainText('Opus 5')
  })
})
