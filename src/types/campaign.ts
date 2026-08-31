/** Difficulty scale — a prompt-level instruction, not a hidden dice engine. See DESIGN.md §7. */
export const DIFFICULTIES = ['Story', 'Easy', 'Standard', 'Hard', 'Brutal'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

/** 'local' runs one of several small instruction-tuned models fully on-device via WebGPU — no
 * key, no server, no cost, but noticeably weaker at long-context instruction-following than
 * 'api'. See localModel.ts's LOCAL_MODELS for the choices and their tradeoffs. */
export const AI_MODES = ['manual', 'api', 'local'] as const
export type AiMode = (typeof AI_MODES)[number]

/** Models available for the direct API mode — see DESIGN.md §11 (Phase 3). Sonnet 5 is the
 * default: a per-turn narrative call paid for out of the player's own key benefits more from a
 * cost/speed balance than from always reaching for the most capable model. */
export const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const
export type ClaudeModel = (typeof CLAUDE_MODELS)[number]

/** On-device models available for 'local' AI mode — see localModel.ts's LOCAL_MODELS for each
 * one's approximate download size and loading requirements. Ordered smallest to largest so a
 * dropdown reads as a size gradient. All are Hugging Face repo IDs of ONNX exports compatible
 * with @huggingface/transformers' from_pretrained(). */
export const LOCAL_MODEL_IDS = [
  'onnx-community/Qwen2.5-0.5B-Instruct',
  'onnx-community/gemma-3-1b-it-ONNX',
  'HuggingFaceTB/SmolLM2-1.7B-Instruct',
  'onnx-community/Llama-3.2-1B-Instruct',
  'onnx-community/Qwen2.5-1.5B-Instruct',
  'onnx-community/gemma-4-E2B-it-ONNX',
] as const
export type LocalModelId = (typeof LOCAL_MODEL_IDS)[number]

/** ElevenLabs was removed entirely (issue #97), as part of the multi-voice narration initiative
 * (epic #36) — Kokoro (`'huggingface-local'`) is now the app's only non-browser voice provider, so
 * there's one voice stack to grow per-speaker voices on rather than two to maintain in parallel.
 * See `src/lib/settings/globalSettings.ts`'s coercion of a legacy `'elevenlabs'` value already
 * sitting in a player's stored settings/`GlobalSettings` blob. */
export const STT_PROVIDERS = ['browser'] as const
export type SttProvider = (typeof STT_PROVIDERS)[number]

export const TTS_PROVIDERS = ['browser', 'huggingface-local'] as const
export type TtsProvider = (typeof TTS_PROVIDERS)[number]

/** Frontmatter of campaigns/<slug>/campaign.md — the rest of the file is free-form prose:
 * world/scenario setup and the player's stated expectations. */
export interface CampaignMeta {
  name: string
  slug: string
  genre: string
  difficulty: Difficulty
  createdAt: string
  currentTurn: number
  currentLocation: string
  houseRules?: string
}

export interface CampaignFile {
  meta: CampaignMeta
  /** Prose body: world/scenario setup + player expectations, written at creation, editable anytime. */
  body: string
}

/** Frontmatter of campaigns/<slug>/settings.md.
 *
 * Every other field that used to live here (aiMode, claudeModel, localModelId, sttProvider,
 * ttsProvider, elevenLabsVoiceId, kokoroVoiceId) moved to a single global, localStorage-backed
 * store (`src/lib/settings/globalSettings.ts`) in issue #77 — the project owner's explicit call
 * was that there's no real difference between "per-campaign" and "global" for a device/provider
 * preference like an AI mode or a TTS voice, so re-picking one per campaign was friction, not a
 * feature. `summarizationCadence` is the one field that stayed here: unlike the others, it's a
 * narrative-pacing choice tied to how a *particular* story is being told (a fast, event-dense
 * campaign might reasonably want a different re-summarization rhythm than a slow, dialogue-heavy
 * one), not a device/provider preference — see #77's PR description for the full reasoning.
 *
 * `playerVoiceId` (issue #98, epic #36) joins it for the same reason: the narrator's Kokoro voice
 * lives in the device-wide `GlobalSettings.kokoroVoiceId` (#77), but the *player character* — a
 * different name and personality per campaign — is exactly the kind of thing that's a property of
 * the campaign, not the device, mirroring why `summarizationCadence` itself stayed here instead of
 * moving to `GlobalSettings`. The alternative (a single device-wide player voice in
 * `GlobalSettings`) would mean every campaign on a device sharing one player voice, or a re-pick
 * every time the player switches campaigns — worse than the one extra optional field this adds to
 * the smaller, Drive-synced type. Optional and undefined by default, same coercion pattern as every
 * other optional field here — `loadSettings`'s `{ ...DEFAULT_SETTINGS, ...parsed }` merge defaults
 * a pre-#98 settings.md missing this key entirely, no extra migration step needed (see
 * tests/backward-compat-frontmatter.spec.ts's fixture proving it). */
export interface CampaignSettings {
  summarizationCadence: number
  playerVoiceId?: string
}

export const DEFAULT_SETTINGS: CampaignSettings = {
  summarizationCadence: 15,
}

/** A campaign as listed in the picked Drive folder, before its full data is loaded. */
export interface CampaignSummary {
  slug: string
  folderId: string
  name: string
  difficulty: Difficulty
  currentTurn: number
  updatedAt: string
}
