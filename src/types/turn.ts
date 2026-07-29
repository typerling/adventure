import type { EntityStatus, MapNodeState } from './sheets'

/** The structured JSON block every AI reply must end with. See DESIGN.md §5. */
export interface StateDelta {
  inventory_add?: { name: string; qty?: number; note?: string }[]
  inventory_remove?: { name: string; qty?: number }[]
  stat_changes?: Record<string, number | string>
  status_add?: string[]
  status_remove?: string[]
  new_npcs?: { name: string; description: string; status?: EntityStatus }[]
  npc_updates?: { name: string; status?: EntityStatus; relationship?: string }[]
  new_monsters?: { name: string; description: string; threatNotes?: string }[]
  new_locations?: { name: string; connects_to?: string; description?: string; state?: MapNodeState }[]
  events?: { title: string; summary: string; tags?: string }[]
  quest_updates?: { title: string; status?: 'active' | 'completed' | 'failed'; description?: string }[]
  new_lore?: { name: string; type?: string; summary: string; tags?: string }[]
}

/** Full parsed shape of one AI reply, after the fenced ```state block is extracted. */
export interface ParsedTurnReply {
  narrative: string
  state_delta: StateDelta
  summary_update?: string
  options: string[]
}

/** One turn as archived in story/log/*.md. */
export interface TurnRecord {
  turn: number
  timestamp: string
  playerAction: string
  narrative: string
  optionsOffered: string[]
}

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssue {
  severity: ValidationSeverity
  message: string
  path: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}
