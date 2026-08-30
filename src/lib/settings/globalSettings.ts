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
 * the existing pattern in `claudeKey.ts`/`elevenLabsKey.ts`: a preference the player shouldn't
 * have to re-enter per campaign, but that deliberately does **not** sync across devices signed
 * into the same Google account — the same real, explicit trade-off `claudeKey.ts`/
 * `elevenLabsKey.ts` already accept for the same reason (never written to Drive, since Drive is
 * shared/synced storage and an API key/local preference is this-browser-only). For this app's
 * stated single-device use case that trade-off is the right call, but it is a real cost worth
 * naming plainly: switching devices (or browsers) means re-picking these once, not "everywhere
 * you're signed in."
 */
export interface GlobalSettings {
  aiMode: AiMode
  claudeModel: ClaudeModel
  localModelId: LocalModelId
  sttProvider: SttProvider
  ttsProvider: TtsProvider
  elevenLabsVoiceId?: string
  /** Which Kokoro voice to use for on-device TTS — see kokoroTts.ts's `listKokoroVoices()`/
   * `DEFAULT_VOICE`. Undefined means "use DEFAULT_VOICE ('af_heart')", mirroring how a blank
   * elevenLabsVoiceId falls back to ElevenLabs' own default. */
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

export function getGlobalSettings(): GlobalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_GLOBAL_SETTINGS
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>
    return { ...DEFAULT_GLOBAL_SETTINGS, ...parsed }
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
    // with it for the current page load (same reasoning as claudeKey.ts/elevenLabsKey.ts).
  }
}

/** Pulls whatever of the now-vestigial `aiMode`/`claudeModel`/`localModelId`/`sttProvider`/
 * `ttsProvider`/`elevenLabsVoiceId`/`kokoroVoiceId` fields a legacy `settings.md`'s raw parsed
 * frontmatter still has, validated against each field's known value set (an old/foreign value —
 * or a field missing entirely — is left for DEFAULT_GLOBAL_SETTINGS to fill in, exactly like
 * `loadSettings`'s old `{ ...DEFAULT_SETTINGS, ...parsed }` merge did). */
function pickLegacyGlobalFields(raw: Record<string, unknown>): Partial<GlobalSettings> {
  const picked: Partial<GlobalSettings> = {}
  if (isOneOf(AI_MODES, raw.aiMode)) picked.aiMode = raw.aiMode
  if (isOneOf(CLAUDE_MODELS, raw.claudeModel)) picked.claudeModel = raw.claudeModel
  if (isOneOf(LOCAL_MODEL_IDS, raw.localModelId)) picked.localModelId = raw.localModelId
  if (isOneOf(STT_PROVIDERS, raw.sttProvider)) picked.sttProvider = raw.sttProvider
  if (isOneOf(TTS_PROVIDERS, raw.ttsProvider)) picked.ttsProvider = raw.ttsProvider
  if (typeof raw.elevenLabsVoiceId === 'string' && raw.elevenLabsVoiceId) {
    picked.elevenLabsVoiceId = raw.elevenLabsVoiceId
  }
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
