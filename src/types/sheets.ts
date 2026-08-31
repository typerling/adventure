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
  /** The machine-resolvable Kokoro voice id (e.g. "bm_george") this NPC has been cast with —
   * issue #98, epic #36's voice-casting groundwork. Distinct from `voice` above (a human-readable
   * spoken-style descriptor the AI has always written): this is what a future playback ticket
   * (#66) will actually pass to Kokoro. Empty string means "not cast yet." Appended, not
   * repurposing `voice` — see CLAUDE.md's schema-change rules on why that distinction matters. */
  voiceId: string
  /** This NPC's Kokoro `speed` multiplier (see kokoro-js's `generate(text, {voice, speed})`).
   * 0 (the coerced default for a blank/legacy row) means "use Kokoro's own default (1)," mirroring
   * how a blank `kokoroVoiceId` elsewhere in this app falls back to `DEFAULT_VOICE`. */
  voiceSpeed: number
  /** Set via the Codex override (#100) — when true, the AI must never recast this NPC's `voiceId`
   * (see contract.ts/applyDelta.ts). Added here, ahead of that ticket, so this tab's schema
   * changes once rather than twice. */
  voiceLocked: boolean
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

export type ThreadStatus = 'dormant' | 'active' | 'resolved'

/** A GM-only foreshadowed plot thread or ticking threat — the story-level equivalent of an NPC's
 * `secrets` field, extended with a numeric "clock" so it can escalate turn to turn independent of
 * whether the player is engaging with it directly (the "fronts/clocks" pattern from Blades in the
 * Dark / Apocalypse World, plus Chekhov's-gun foreshadowing discipline — see issue #83's research
 * and DESIGN.md §5). Distinct from `Quests` (always player-visible, no clock, no hidden state) and
 * `Timeline` (a log of what already happened, not a live thread that can advance off-screen) — see
 * DESIGN.md §4. */
export interface Thread {
  id: string
  title: string
  /** GM-only ground truth: the actual plot detail/threat. This is what `revealed` gates — must
   * never appear in any player-facing render (Play narrative/options, Codex) while `revealed` is
   * false, same discipline as `Npc.secrets`. */
  description: string
  status: ThreadStatus
  /** Whether the player has been shown any part of this thread yet. False means it's pure GM-only
   * foreshadowing that must not leak into narrative/options. */
  revealed: boolean
  /** Current clock fill, 0..progressMax — how close this thread is to firing/resolving. Advances
   * turn to turn, including on turns where the player isn't directly engaging with it. */
  progress: number
  /** Clock size. Free-form, not fixed to any particular segment count — different threads can use
   * different-sized clocks (a 4-clock for something imminent, an 8-clock for something distant),
   * matching TTRPG "fronts/clocks" convention rather than mandating one fixed scale. 0 means this
   * thread isn't using a clock at all, just a status. */
  progressMax: number
  createdTurn: number
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
  'Threads',
  'Map',
  'Lore',
] as const
export type SheetTab = (typeof SHEET_TABS)[number]
