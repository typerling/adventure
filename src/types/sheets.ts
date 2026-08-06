/**
 * One row shape per tab in the "<campaign name> — Data" spreadsheet (DESIGN.md §4).
 * Column order here is also sheet column order — keep in sync with lib/google/sheetSchema.ts.
 */

export interface CharacterStat {
  key: string
  value: string
}

/** The Character tab holds one row per stat/status field, not one row per character —
 * this keeps arbitrary/genre-specific stats (no fixed HP/STR/DEX schema) a plain key/value list. */
export interface CharacterRow {
  key: string
  value: string
}

export interface InventoryItem {
  id: string
  name: string
  qty: number
  description: string
  tags: string
  acquiredTurn: number
  active: boolean
}

export interface Skill {
  id: string
  name: string
  rank: string
  description: string
}

export type EntityStatus = 'alive' | 'dead' | 'unknown' | 'ally' | 'hostile' | 'neutral'

export interface Npc {
  id: string
  name: string
  description: string
  relationship: string
  status: EntityStatus
  lastSeenTurn: number
  /** A voice descriptor (e.g. "gravelly, clipped sentences") — reserved for actual TTS
   * voice-switching in a later ticket (#36); not wired to playback yet. */
  voice: string
  /** GM-only ground truth the AI shouldn't contradict — must never appear in any player-facing
   * render (Play narrative/options, Codex). Only ever fed back into future prompts. */
  secrets: string
  /** A condensed running summary of this NPC, rewritten in place on each update — the same
   * pattern the campaign-wide rolling summary uses, just scoped per-NPC. */
  notes: string
  /** Points at world/npcs/<slug>.md for the append-only long-form history, once one exists.
   * Same optional-pointer pattern as LoreEntry.detailFile. */
  detailFile?: string
}

/** Free-form key/value fact about one NPC (a clan allegiance, cybernetic augments, an alibi —
 * whatever the genre calls for) — same shape as the Character tab's key/value list, just scoped
 * per-NPC via npcId. This is what keeps NPC facts genuinely open-ended without a schema
 * migration every time a new genre needs a new kind of fact. */
export interface NpcAttribute {
  npcId: string
  key: string
  value: string
}

export interface Monster {
  id: string
  name: string
  description: string
  threatNotes: string
  status: EntityStatus
  lastEncounteredTurn: number
}

export interface TimelineEvent {
  turn: number
  title: string
  summary: string
  tags: string
}

export type QuestStatus = 'active' | 'completed' | 'failed'

export interface Quest {
  id: string
  title: string
  status: QuestStatus
  description: string
  updatedTurn: number
}

export type MapNodeState = 'discovered' | 'rumored' | 'unexplored'

export interface MapNode {
  id: string
  name: string
  type: string
  state: MapNodeState
  connectsTo: string
  description: string
  x?: number
  y?: number
}

export interface LoreEntry {
  id: string
  type: string
  name: string
  summary: string
  tags: string
  discovered: boolean
  detailFile?: string
}

export const SHEET_TABS = [
  'Character',
  'Inventory',
  'Skills',
  'NPCs',
  'NPCAttributes',
  'Monsters',
  'Timeline',
  'Quests',
  'Map',
  'Lore',
] as const
export type SheetTab = (typeof SHEET_TABS)[number]
