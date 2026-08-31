import type { EntityStatus, MapNodeState } from './sheets'

/** The structured JSON block every AI reply must end with. See DESIGN.md §5. */
export interface StateDelta {
  inventory_add?: { name: string; qty?: number; note?: string }[]
  inventory_remove?: { name: string; qty?: number }[]
  stat_changes?: Record<string, number | string>
  status_add?: string[]
  status_remove?: string[]
  new_npcs?: {
    name: string
    description: string
    status?: EntityStatus
    /** A voice descriptor, e.g. "gravelly, clipped sentences". Only for NPCs meeting the
     * "real interaction" bar — see contract.ts's profile-depth gate. */
    voice?: string
    /** GM-only ground truth — never surfaced to the player. */
    secrets?: string
    /** Free-form genre-specific facts, e.g. {"Clan": "Ashfall"} or {"Augments": "ocular HUD"}. */
    attributes?: Record<string, string>
    /** New notable detail worth recording permanently. Doubles as this NPC's fresh condensed
     * `notes` value and as the entry appended to its world/npcs/<slug>.md history. */
    notes_add?: string
    /** A Kokoro voice id from the catalog rendered in the prompt (e.g. "bm_george") — issue #98,
     * epic #36. Same "real interaction" gate as `voice`/`secrets`/`attributes`. An unrecognized id
     * is a coercing warning, never a blocking error — see validate.ts/applyDelta.ts. */
    voiceId?: string
    /** This character's Kokoro delivery speed multiplier — see contract.ts's instructions for the
     * valid range. Out-of-range values coerce rather than block, same as `voiceId`. */
    voiceSpeed?: number
  }[]
  npc_updates?: {
    name: string
    status?: EntityStatus
    relationship?: string
    voice?: string
    secrets?: string
    attributes?: Record<string, string>
    notes_add?: string
    /** See `new_npcs[].voiceId` above — additionally, applyDelta.ts must never let this overwrite
     * a `voiceLocked` NPC's cast voice, regardless of what's sent here. */
    voiceId?: string
    voiceSpeed?: number
  }[]
  new_monsters?: { name: string; description: string; threatNotes?: string }[]
  new_locations?: { name: string; connects_to?: string; description?: string; state?: MapNodeState }[]
  events?: { title: string; summary: string; tags?: string }[]
  quest_updates?: { title: string; status?: 'active' | 'completed' | 'failed'; description?: string }[]
  /** Plants a new GM-only foreshadowed thread/ticking threat — the story-level equivalent of an
   * NPC's `secrets` (issue #83). See contract.ts's "Story threads" instructions for the
   * revealed/status/progress semantics. */
  new_threads?: {
    title: string
    description: string
    status?: 'dormant' | 'active' | 'resolved'
    revealed?: boolean
    progress?: number
    progressMax?: number
  }[]
  /** Advances/escalates an existing thread, matched by `title` (same upsert-by-name pattern as
   * `quest_updates`) — including on a turn where the player didn't directly engage it, so a
   * thread can tick down off-screen. `progress` is the new absolute clock fill, not a delta. */
  thread_updates?: {
    title: string
    description?: string
    status?: 'dormant' | 'active' | 'resolved'
    revealed?: boolean
    progress?: number
    progressMax?: number
  }[]
  new_lore?: { name: string; type?: string; summary: string; tags?: string }[]
}

/** One suggested next action. `manus` is the text spoken aloud for this option — it defaults to
 * `label` when the AI doesn't need it to read differently than it displays (most options). See
 * DESIGN.md §5 and `src/lib/ai/contract.ts`. */
export interface TurnOption {
  label: string
  manus?: string
}

/** Full parsed shape of one AI reply, after the fenced ```state block is extracted. `options` is
 * always normalized to `TurnOption[]` by parseReply.ts, even when the AI (or a manual paste from
 * a chat UI that hasn't picked up the new contract) sent the legacy `string[]` shape. */
export interface ParsedTurnReply {
  narrative: string
  state_delta: StateDelta
  summary_update?: string
  options: TurnOption[]
}

/** One piece of a turn's rendered content, in sequence. A union so future block types (a
 * dice-roll result, an item card, ...) can be added without restructuring `TurnContent` or the
 * spoken-script builder — see turnBlocks.ts and src/components/TurnContent.tsx. */
export type TurnBlock =
  | { type: 'prose'; markdown: string }
  | { type: 'options'; items: { label: string; manus: string }[] }

/** One piece of a turn's *spoken* content, in the order it should be read — the per-speaker
 * counterpart to `TurnBlock` (issue #96, part of the multi-voice-narration epic #36). A prose
 * block with no `{{v:Name}}...{{/v}}` tags in it (today's only shape) always collapses to exactly
 * one segment with `speaker: null` — see turnBlocks.ts's `buildSpokenSegments` doc comment for why
 * that equivalence is load-bearing. `speaker: null` means narration (no character voiced it);
 * a non-null `speaker` names a character exactly as it appears in the sheet snapshot (an NPC's
 * `name`, or the player character's own name) for a future ticket to map to a distinct voice —
 * this ticket only produces the split, it doesn't change playback. */
export interface SpokenSegment {
  text: string
  speaker: string | null
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
