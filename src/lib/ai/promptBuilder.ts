import type { CampaignFile } from '@/types/campaign'
import type { TurnRecord } from '@/types/turn'
import { stripRollingSummaryPlaceholder } from '@/lib/google/campaignRepo'
import type {
  CharacterRow,
  InventoryItem,
  LoreEntry,
  MapNode,
  Monster,
  Npc,
  NpcAttribute,
  Quest,
  Skill,
  Thread,
  TimelineEvent,
} from '@/types/sheets'
import { DIFFICULTY_INSTRUCTIONS } from './difficultyInstructions'
import { STATE_CONTRACT_INSTRUCTIONS } from './contract'
import { renderKokoroVoiceCatalog } from '@/lib/voice/kokoroVoiceCatalog'

export interface SheetSnapshot {
  Character: CharacterRow[]
  Inventory: InventoryItem[]
  Skills: Skill[]
  NPCs: Npc[]
  NPCAttributes: NpcAttribute[]
  Monsters: Monster[]
  Timeline: TimelineEvent[]
  Quests: Quest[]
  Threads: Thread[]
  Map: MapNode[]
  Lore: LoreEntry[]
}

const RECENT_TURNS_INCLUDED = 6

function renderSnapshot(snapshot: SheetSnapshot): string {
  const lines: string[] = []

  if (snapshot.Character.length) {
    lines.push('Character:')
    for (const r of snapshot.Character) lines.push(`- ${r.key}: ${r.value}`)
  }

  const activeItems = snapshot.Inventory.filter((i) => i.active)
  lines.push('', `Inventory (${activeItems.length} item(s)):`)
  for (const i of activeItems) {
    lines.push(`- ${i.name} x${i.qty}${i.description ? ` — ${i.description}` : ''}`)
  }

  if (snapshot.Skills.length) {
    lines.push('', 'Skills:')
    for (const s of snapshot.Skills) lines.push(`- ${s.name} (${s.rank})${s.description ? `: ${s.description}` : ''}`)
  }

  const knownNpcs = snapshot.NPCs.filter((n) => n.status !== 'unknown')
  if (knownNpcs.length) {
    lines.push('', 'Known NPCs:')
    for (const n of knownNpcs) {
      lines.push(`- ${n.name} [${n.status}${n.relationship ? `, ${n.relationship}` : ''}]: ${n.description}`)
      // Secrets DO need to reach the model — that's the whole point of tracking them (so the AI
      // can behave consistently around something an NPC is hiding, and reveal it at the right
      // moment) — so this is deliberately included in the prompt for every mode, not just
      // API/local. The tradeoff: manual mode shows the whole built prompt to the player for
      // copy/pasting (see buildTurnPrompt's own doc comment), so a secret genuinely can be
      // visible there if the player reads closely. That's an accepted, pre-existing property of
      // manual mode (it can't hide *anything* in the prompt from the player who's relaying it),
      // not a new leak this introduces — see DESIGN.md §5. What secrets must never do is appear
      // in the *narrative*, *options*, or Codex — i.e. what the AI writes back and what gets
      // rendered as the story, not the DM-facing input that produces it.
      if (n.secrets) lines.push(`  Secrets (do not reveal unless the story naturally does): ${n.secrets}`)
      if (n.voice) lines.push(`  Voice: ${n.voice}`)
      // Machine-castable voice id/speed/lock (issue #98) — kept separate from the human-readable
      // "Voice:" descriptor line above, which the AI has always written and #99 will enrich.
      if (n.voiceId || n.voiceLocked) {
        const speed = n.voiceSpeed ? ` @${n.voiceSpeed}x` : ''
        const locked = n.voiceLocked ? ' [locked — do not recast]' : ''
        lines.push(`  Cast voice: ${n.voiceId || '(unset)'}${speed}${locked}`)
      }
      if (n.notes) lines.push(`  Notes: ${n.notes}`)
      const attrs = snapshot.NPCAttributes.filter((a) => a.npcId === n.id)
      if (attrs.length) lines.push(`  Attributes: ${attrs.map((a) => `${a.key}: ${a.value}`).join('; ')}`)
    }
  }

  const knownMonsters = snapshot.Monsters.filter((m) => m.status !== 'unknown')
  if (knownMonsters.length) {
    lines.push('', 'Known creatures/monsters:')
    for (const m of knownMonsters) lines.push(`- ${m.name} [${m.status}]: ${m.description}`)
  }

  const activeQuests = snapshot.Quests.filter((q) => q.status === 'active')
  if (activeQuests.length) {
    lines.push('', 'Active quests:')
    for (const q of activeQuests) lines.push(`- ${q.title}: ${q.description}`)
  }

  // Story threads (issue #83) — the plot-level equivalent of NPC secrets: GM-only ground truth
  // that must never appear in the *narrative*/*options* until revealed. Unlike secrets, these are
  // deliberately always included here regardless of whether the player's action touches them, so
  // the DM is reminded every turn to keep an active thread moving (including off-screen) rather
  // than only when the player happens to poke at it. Resolved threads are dropped — they're done,
  // no need to keep feeding them back forever (same bounded-context reasoning as "Active quests"
  // only showing status === 'active' above).
  const unresolvedThreads = snapshot.Threads.filter((t) => t.status !== 'resolved')
  if (unresolvedThreads.length) {
    lines.push(
      '',
      "Story threads (GM-only — advance or escalate these turn to turn, including on turns where " +
        'the player is not directly engaging with them; see the reply-format instructions below ' +
        'for the rule on revealed vs. unrevealed content):',
    )
    for (const t of unresolvedThreads) {
      const clock = t.progressMax > 0 ? `, clock: ${t.progress}/${t.progressMax}` : ''
      lines.push(
        `- "${t.title}" [status: ${t.status}, revealed: ${t.revealed ? 'yes' : 'no'}${clock}]: ${t.description}`,
      )
    }
  }

  const discoveredNodes = snapshot.Map.filter((m) => m.state === 'discovered')
  if (discoveredNodes.length) {
    lines.push('', 'Discovered locations:')
    for (const m of discoveredNodes) {
      lines.push(`- ${m.name} (${m.type})${m.connectsTo ? `, connects to: ${m.connectsTo}` : ''}`)
    }
  }

  const discoveredLore = snapshot.Lore.filter((l) => l.discovered)
  if (discoveredLore.length) {
    lines.push('', 'Known lore:')
    for (const l of discoveredLore) lines.push(`- ${l.name} (${l.type}): ${l.summary}`)
  }

  return lines.join('\n')
}

function renderRecentTurns(turns: TurnRecord[]): string {
  const recent = turns.slice(-RECENT_TURNS_INCLUDED)
  if (recent.length === 0) return '(this is the first turn — nothing has happened yet)'
  return recent
    .map((t) => `Turn ${t.turn} — player: ${t.playerAction}\nDM: ${t.narrative}`)
    .join('\n\n')
}

/** NPC name -> that NPC's world/npcs/<slug>.md content, pre-fetched for whichever NPCs the
 * player's action mentions this turn. See findMentionedNpcs. */
export type NpcDetailLookup = Record<string, string>

function renderNpcDetails(npcDetails: NpcDetailLookup | undefined): string {
  const entries = Object.entries(npcDetails ?? {}).filter(([, content]) => content.trim())
  if (!entries.length) return ''
  return `\n\n## Recalled history for NPCs named in this turn's action (from their detail file)
${entries.map(([name, content]) => `### ${name}\n${content.trim()}`).join('\n\n')}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Which known NPCs (with a detailFile on record) the player's action names by a simple
 * case-insensitive, word-boundary match — the same trick AI Dungeon's "World Info" system uses,
 * no embeddings or new infrastructure. Word-boundary, not a plain substring check, so a short
 * name (e.g. "Al") doesn't false-positive against unrelated text ("the alley") — flagged in
 * PR #37's review. Callers fetch each match's detailFile content and pass the result to
 * buildTurnPrompt as npcDetails. */
export function findMentionedNpcs(npcs: Npc[], playerAction: string): Npc[] {
  return npcs.filter((n) => {
    const name = n.name.trim()
    if (!n.detailFile || !name) return false
    return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(playerAction)
  })
}

/** The player character's own name, as it appears in the Character tab. The Character tab holds
 * one row per stat/status key rather than one row per character (see CharacterRow's own doc
 * comment), so "the player's name" is just whichever row's key is literally "Name" — the same key
 * NewCampaign.tsx's setup wizard seeds. Returns null if that row is missing or blank (an
 * ultra-minimal or hand-edited Character tab). */
export function playerNameFromSnapshot(snapshot: SheetSnapshot): string | null {
  const value = snapshot.Character.find((row) => row.key === 'Name')?.value?.trim()
  return value ? value : null
}

/** Every name a `{{v:Name}}` speaker token (or the heuristic fallback in turnBlocks.ts) could
 * plausibly refer to for this campaign right now: the player character's own name, plus every
 * known NPC's name — the same "name" string `npc_updates`/`new_npcs` match by (issue #96). Not
 * filtered by NPC status/relationship — even a hostile or merely-glimpsed NPC's name is a valid
 * thing for the AI to tag dialogue with, this is purely "what names could this token mean." */
export function namesFromSnapshot(snapshot: SheetSnapshot): string[] {
  const playerName = playerNameFromSnapshot(snapshot)
  const npcNames = snapshot.NPCs.map((n) => n.name.trim()).filter(Boolean)
  return playerName ? [playerName, ...npcNames] : npcNames
}

export interface BuildPromptInput {
  campaign: CampaignFile
  snapshot: SheetSnapshot
  rollingSummary: string
  recentTurns: TurnRecord[]
  playerAction: string
  turnNumber: number
  /** Pre-fetched detail-file content for NPCs the player's action names — see
   * findMentionedNpcs. Optional and pre-loaded rather than fetched here because Drive reads are
   * async and this function stays synchronous so manual-paste mode's prompt-building flow is
   * unaffected; callers that want detail recall fetch it first (see useCampaign.ts's
   * buildPromptForAction). */
  npcDetails?: NpcDetailLookup
  /** The narrator's cast Kokoro voice id — `GlobalSettings.kokoroVoiceId` (device-wide, #77).
   * Undefined means not explicitly picked yet (Kokoro's own DEFAULT_VOICE would apply at
   * playback time, but that's not the same as the AI having "cast" it). Issue #98. */
  narratorVoiceId?: string
  /** The player character's cast Kokoro voice id — `CampaignSettings.playerVoiceId` (per-campaign,
   * see that field's own doc comment for why). Issue #98. */
  playerVoiceId?: string
}

/** Renders the "Voice casting" prompt section (issue #98) — the available Kokoro catalog plus
 * who's already cast, so the AI can pick a genuinely free/fitting voice and avoid duplicate
 * casting within one scene rather than inventing an id blind. Kept as its own top-level section
 * (rather than folded only into the per-NPC "Known NPCs" lines) since the narrator and player
 * voices have nowhere else in the snapshot to live. */
function renderVoiceCasting(
  snapshot: SheetSnapshot,
  narratorVoiceId: string | undefined,
  playerVoiceId: string | undefined,
): string {
  const playerName = playerNameFromSnapshot(snapshot)
  const castNpcs = snapshot.NPCs.filter((n) => n.voiceId || n.voiceLocked)
  const lines: string[] = [
    '## Voice casting (on-device Kokoro narration)',
    'Voices you may cast from (id — name, gender, accent, quality/grade[, traits]):',
    renderKokoroVoiceCatalog(),
    '',
    'Current casting (do not recast anyone already listed here unless the story explains it, and',
    'never recast anyone marked locked):',
    `- Narrator: ${narratorVoiceId || '(unset)'}`,
    `- Player${playerName ? ` (${playerName})` : ''}: ${playerVoiceId || '(unset)'}`,
  ]
  for (const n of castNpcs) {
    const locked = n.voiceLocked ? ' [locked]' : ''
    lines.push(`- ${n.name}: ${n.voiceId || '(unset)'}${locked}`)
  }
  return lines.join('\n')
}

/** Builds the full, self-contained text block for one turn — what gets copied into
 * claude.ai/chatgpt.com in manual-bridge mode, or sent as-is to an API provider in Phase 3. */
export function buildTurnPrompt(input: BuildPromptInput): string {
  const {
    campaign,
    snapshot,
    rollingSummary,
    recentTurns,
    playerAction,
    turnNumber,
    npcDetails,
    narratorVoiceId,
    playerVoiceId,
  } = input

  return `You are the Dungeon Master and every NPC/creature in a solo, audiobook-style
adventure. The rules are inspired by tabletop RPGs but are not strictly D&D — stay consistent
with the tone and setup below rather than any specific rules system. Narrate in second person,
present tense, and never break character to talk about mechanics.

Standing principles, every turn:
- Make the world feel real and lived-in, not a stage built only for the player. Places have
  their own logic, NPCs have their own lives, and things happen elsewhere whether or not the
  player is watching. Let the player's choices genuinely change what happens, rather than
  railroading toward a fixed outcome.
- Established NPCs pursue their own goals. Don't just have them wait around to react to the
  player — someone with a stake in the scene should be seen (or heard of) advancing what they
  want, even off-screen ("word arrives that..."), consistent with whatever voice, secrets,
  attributes, or notes are documented for them below.
- Keep scenes focused. Pick a few concrete, sensory-varied focal points rather than cataloguing a
  room or describing everything present — cut to what's actually interesting and let the player
  ask about the rest.
- Vary pacing. Not every turn needs to be tense — let quieter, lower-stakes beats follow big ones
  so the intensity has somewhere to build from.
- Track the campaign's shape too, not just this turn's. Read the turn number and current
  quests/threads below as where the story sits — not a fixed act or phase. Early on, establish
  premise and stakes rather than rushing to resolve what you just introduced. Later, escalate
  rather than accumulate: deepen active quests/threads — a minor threat growing, a clock filling —
  instead of piling on unrelated new content at the same weight. When several are converging, or a
  clock nears full, build toward a real climax and let it land: resolve it, rather than stalling
  indefinitely.
- Avoid repetitive phrasing. Don't lean on the same stock openers, sentence rhythms, or
  descriptive tics turn after turn — vary sentence length and structure the way a human writer
  would.

${DIFFICULTY_INSTRUCTIONS[campaign.meta.difficulty]}

## World & scenario setup
${campaign.body.trim()}
${campaign.meta.houseRules ? `\nHouse rules: ${campaign.meta.houseRules}` : ''}

## Running summary of the story so far
${stripRollingSummaryPlaceholder(rollingSummary) || '(no summary yet)'}

## Most recent turns
${renderRecentTurns(recentTurns)}

## Current documented state (treat as ground truth — do not contradict it)
${renderSnapshot(snapshot)}${renderNpcDetails(npcDetails)}

${renderVoiceCasting(snapshot, narratorVoiceId, playerVoiceId)}

## This turn
Turn number: ${turnNumber}
Current location: ${campaign.meta.currentLocation}
The player's action: ${playerAction}

${STATE_CONTRACT_INSTRUCTIONS}`
}
