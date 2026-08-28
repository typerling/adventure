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
}

/** Builds the full, self-contained text block for one turn — what gets copied into
 * claude.ai/chatgpt.com in manual-bridge mode, or sent as-is to an API provider in Phase 3. */
export function buildTurnPrompt(input: BuildPromptInput): string {
  const { campaign, snapshot, rollingSummary, recentTurns, playerAction, turnNumber, npcDetails } = input

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

## This turn
Turn number: ${turnNumber}
Current location: ${campaign.meta.currentLocation}
The player's action: ${playerAction}

${STATE_CONTRACT_INSTRUCTIONS}`
}
