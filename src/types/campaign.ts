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

export const STT_PROVIDERS = ['browser', 'elevenlabs'] as const
export type SttProvider = (typeof STT_PROVIDERS)[number]

export const TTS_PROVIDERS = ['browser', 'elevenlabs', 'huggingface-local'] as const
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

/** Frontmatter of campaigns/<slug>/settings.md */
export interface CampaignSettings {
  aiMode: AiMode
  claudeModel: ClaudeModel
  localModelId: LocalModelId
  sttProvider: SttProvider
  ttsProvider: TtsProvider
  elevenLabsVoiceId?: string
  summarizationCadence: number
  /** Auto-narrates each newly-applied turn (and, when the latest turn offers options, chains
   * straight into speaking those too) — see useTtsPlayback. Off by default since it's an opt-in
   * audiobook-style mode, not everyone wants turns spoken without asking. */
  autoReadAloud: boolean
}

export const DEFAULT_SETTINGS: CampaignSettings = {
  aiMode: 'manual',
  claudeModel: 'claude-sonnet-5',
  localModelId: 'onnx-community/gemma-3-1b-it-ONNX',
  sttProvider: 'browser',
  ttsProvider: 'browser',
  summarizationCadence: 15,
  autoReadAloud: false,
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
