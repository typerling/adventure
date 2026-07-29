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
  'Monsters',
  'Timeline',
  'Quests',
  'Map',
  'Lore',
] as const
export type SheetTab = (typeof SHEET_TABS)[number]
