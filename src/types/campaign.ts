/** Difficulty scale — a prompt-level instruction, not a hidden dice engine. See DESIGN.md §7. */
export const DIFFICULTIES = ['Story', 'Easy', 'Standard', 'Hard', 'Brutal'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

export const AI_MODES = ['manual', 'api'] as const
export type AiMode = (typeof AI_MODES)[number]

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
  sttProvider: SttProvider
  ttsProvider: TtsProvider
  elevenLabsVoiceId?: string
  summarizationCadence: number
}

export const DEFAULT_SETTINGS: CampaignSettings = {
  aiMode: 'manual',
  sttProvider: 'browser',
  ttsProvider: 'browser',
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
