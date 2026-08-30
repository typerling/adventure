import {
  AI_MODES,
  CLAUDE_MODELS,
  LOCAL_MODEL_IDS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  type AiMode,
  type ClaudeModel,
  type LocalModelId,
  type SttProvider,
  type TtsProvider,
} from '@/types/campaign'

/**
 * Global, device-scoped AI/voice preferences (issue #77) — everything that used to live in
 * `CampaignSettings`/`settings.md` except `summarizationCadence` (see that type's own doc comment
 * for why that one field stayed per-campaign). Stored in `localStorage`, one JSON blob, mirroring
 * the existing pattern in `claudeKey.ts`: a preference the player shouldn't have to re-enter per
 * campaign, but that deliberately does **not** sync across devices signed into the same Google
 * account — the same real, explicit trade-off `claudeKey.ts` already accepts for the same reason
 * (never written to Drive, since Drive is shared/synced storage and an API key/local preference is
 * this-browser-only). For this app's stated single-device use case that trade-off is the right
 * call, but it is a real cost worth naming plainly: switching devices (or browsers) means
 * re-picking these once, not "everywhere you're signed in."
 */
export interface GlobalSettings {
  aiMode: AiMode
  claudeModel: ClaudeModel
  localModelId: LocalModelId
  sttProvider: SttProvider
  ttsProvider: TtsProvider
  /** Which Kokoro voice to use for on-device TTS — see kokoroTts.ts's `listKokoroVoices()`/
   * `DEFAULT_VOICE`. Undefined means "use DEFAULT_VOICE ('af_heart')". */
  kokoroVoiceId?: string
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  aiMode: 'manual',
  claudeModel: 'claude-sonnet-5',
  localModelId: 'onnx-community/gemma-3-1b-it-ONNX',
  sttProvider: 'browser',
  ttsProvider: 'browser',
}

const STORAGE_KEY = 'adventure:global-settings'
/** Set once the first time any settings.md is ever read post-upgrade (whether or not it actually
 * had anything usable to seed from) — see `seedGlobalSettingsFromLegacyIfNeeded`'s doc comment.
 * Kept as its own key (rather than inferring "already migrated" from STORAGE_KEY existing) so a
 * legacy campaign with genuinely nothing to seed doesn't get re-checked on every single
 * settings.md load for the rest of the session. */
const MIGRATED_KEY = 'adventure:global-settings-migrated'

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
}

/** Coerces a `GlobalSettings` value's `sttProvider`/`ttsProvider` onto the CURRENT `STT_PROVIDERS`/
 * `TTS_PROVIDERS` unions, falling back to `DEFAULT_GLOBAL_SETTINGS`' value for either field that
 * names a provider no longer supported (concretely, today: `'elevenlabs'`, removed in issue #97).
 *
 * This exists for a gap issue #97 introduced that's easy to miss: `pickLegacyGlobalFields` below
 * already guards a PRE-#77 `settings.md` for free — an unrecognized `sttProvider`/`ttsProvider`
 * value there simply fails its `isOneOf` check and is skipped, so `DEFAULT_GLOBAL_SETTINGS` fills
 * in exactly as it would for a field missing entirely. But a build shipped AFTER #77 (global
 * settings already exist) and BEFORE #97 (ElevenLabs still a valid choice) could have written a
 * real `adventure:global-settings` blob directly naming `'elevenlabs'` — and `getGlobalSettings`'s
 * `{ ...DEFAULT_GLOBAL_SETTINGS, ...parsed }` merge only fills in *missing* keys, so a *present*
 * `'elevenlabs'` value survives that merge completely untouched. Without this step, such a player
 * would open the app post-upgrade to `getSttProvider`/`getTtsProvider` silently resolving `null`
 * forever — the mic button and read-aloud toggle just vanish, with no error and no obvious cause.
 * Applied unconditionally at the end of `getGlobalSettings`, so it also cleans up after itself: the
 * next `setGlobalSettings` call (e.g. Settings' "Save settings") persists the coerced value, so
 * this only ever does real work once per affected device. */
function coerceLegacyVoiceProviders(settings: GlobalSettings): GlobalSettings {
  const sttProvider = isOneOf(STT_PROVIDERS, settings.sttProvider)
    ? settings.sttProvider
    : DEFAULT_GLOBAL_SETTINGS.sttProvider
  const ttsProvider = isOneOf(TTS_PROVIDERS, settings.ttsProvider)
    ? settings.ttsProvider
    : DEFAULT_GLOBAL_SETTINGS.ttsProvider
  if (sttProvider === settings.sttProvider && ttsProvider === settings.ttsProvider) return settings
  return { ...settings, sttProvider, ttsProvider }
}

export function getGlobalSettings(): GlobalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_GLOBAL_SETTINGS
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>
    return coerceLegacyVoiceProviders({ ...DEFAULT_GLOBAL_SETTINGS, ...parsed })
  } catch {
    // Corrupt JSON or localStorage unavailable (private browsing, disabled storage, …) — fall
    // back to defaults rather than throwing into whatever called this.
    return DEFAULT_GLOBAL_SETTINGS
  }
}

export function setGlobalSettings(settings: GlobalSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage unavailable — the change just won't persist across reloads; callers still work
    // with it for the current page load (same reasoning as claudeKey.ts).
  }
}

/** Pulls whatever of the now-vestigial `aiMode`/`claudeModel`/`localModelId`/`sttProvider`/
 * `ttsProvider`/`kokoroVoiceId` fields a legacy `settings.md`'s raw parsed frontmatter still has,
 * validated against each field's known value set (an old/foreign value — or a field missing
 * entirely — is left for DEFAULT_GLOBAL_SETTINGS to fill in, exactly like `loadSettings`'s old
 * `{ ...DEFAULT_SETTINGS, ...parsed }` merge did). This already makes a PRE-#77 settings.md naming
 * the since-removed ElevenLabs provider (issue #97) safe for free: `sttProvider`/`ttsProvider`
 * values of `'elevenlabs'` simply fail `isOneOf` against the now-narrowed `STT_PROVIDERS`/
 * `TTS_PROVIDERS` unions and are skipped here, same as any other unrecognized/missing value — see
 * `coerceLegacyVoiceProviders` above for the *different* case this doesn't cover (a value already
 * sitting in a POST-#77 `GlobalSettings` blob, which this function never sees). A stale legacy
 * `elevenLabsVoiceId` in old frontmatter is deliberately left unpicked — it's not part of
 * `GlobalSettings` any more, so it's just an inert extra property, not worth a special case. */
function pickLegacyGlobalFields(raw: Record<string, unknown>): Partial<GlobalSettings> {
  const picked: Partial<GlobalSettings> = {}
  if (isOneOf(AI_MODES, raw.aiMode)) picked.aiMode = raw.aiMode
  if (isOneOf(CLAUDE_MODELS, raw.claudeModel)) picked.claudeModel = raw.claudeModel
  if (isOneOf(LOCAL_MODEL_IDS, raw.localModelId)) picked.localModelId = raw.localModelId
  if (isOneOf(STT_PROVIDERS, raw.sttProvider)) picked.sttProvider = raw.sttProvider
  if (isOneOf(TTS_PROVIDERS, raw.ttsProvider)) picked.ttsProvider = raw.ttsProvider
  if (typeof raw.kokoroVoiceId === 'string' && raw.kokoroVoiceId) {
    picked.kokoroVoiceId = raw.kokoroVoiceId
  }
  return picked
}

/** One-time migration for a player upgrading from the per-campaign settings.md era (issue #77).
 * Called from `campaignRepo.ts`'s `loadSettings` with that campaign's raw parsed frontmatter,
 * every time any settings.md is read — but it only actually does anything the *first* time it's
 * ever called with anything to work with, system-wide, not per campaign.
 *
 * Migration choice (documented explicitly, per the issue): seed the global store from whichever
 * campaign's settings.md happens to load first, rather than always starting fresh from
 * DEFAULT_GLOBAL_SETTINGS. Both are defensible at this app's single-user scale, but starting fresh
 * would silently reset an existing player back to manual AI mode / browser voice the moment they
 * upgrade — a real, jarring regression for anyone who'd already configured API mode, a local
 * model, or a non-default voice, discovered only the next time they tried to play. Seeding from
 * whatever's already on file preserves continuity for the common case (a player with one or a
 * handful of campaigns who set these consistently) at the cost of a coin-flip if their campaigns'
 * settings.md files genuinely disagreed with each other — judged the better trade for this app's
 * stated single-device, small-campaign-count use case. A brand-new install with zero campaigns yet
 * never has anything call this before DEFAULT_GLOBAL_SETTINGS is what a first-time player sees. */
export function seedGlobalSettingsFromLegacyIfNeeded(raw: Record<string, unknown>): void {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return // already has a real, user-owned value
    if (localStorage.getItem(MIGRATED_KEY) !== null) return // already attempted once this device
    localStorage.setItem(MIGRATED_KEY, '1')
    const legacyFields = pickLegacyGlobalFields(raw)
    if (Object.keys(legacyFields).length === 0) return // nothing usable — leave STORAGE_KEY unset,
    // so a normal DEFAULT_GLOBAL_SETTINGS applies and a later real Settings save still writes
    // STORAGE_KEY for the first time, same as a fresh install.
    setGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ...legacyFields })
  } catch {
    // localStorage unavailable — nothing to migrate into anyway.
  }
}
