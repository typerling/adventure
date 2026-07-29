import type { CampaignFile } from '@/types/campaign'
import type { TurnRecord } from '@/types/turn'
import type {
  CharacterRow,
  InventoryItem,
  LoreEntry,
  MapNode,
  Monster,
  Npc,
  Quest,
  Skill,
  TimelineEvent,
} from '@/types/sheets'
import { DIFFICULTY_INSTRUCTIONS } from './difficultyInstructions'
import { STATE_CONTRACT_INSTRUCTIONS } from './contract'

export interface SheetSnapshot {
  Character: CharacterRow[]
  Inventory: InventoryItem[]
  Skills: Skill[]
  NPCs: Npc[]
  Monsters: Monster[]
  Timeline: TimelineEvent[]
  Quests: Quest[]
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

export interface BuildPromptInput {
  campaign: CampaignFile
  snapshot: SheetSnapshot
  rollingSummary: string
  recentTurns: TurnRecord[]
  playerAction: string
  turnNumber: number
}

/** Builds the full, self-contained text block for one turn — what gets copied into
 * claude.ai/chatgpt.com in manual-bridge mode, or sent as-is to an API provider in Phase 3. */
export function buildTurnPrompt(input: BuildPromptInput): string {
  const { campaign, snapshot, rollingSummary, recentTurns, playerAction, turnNumber } = input

  return `You are the Dungeon Master and every NPC/creature in a solo, audiobook-style
adventure. The rules are inspired by tabletop RPGs but are not strictly D&D — stay consistent
with the tone and setup below rather than any specific rules system. Narrate in second person,
present tense. Keep the world reactive, let the player's choices matter, and never break
character to talk about mechanics.

${DIFFICULTY_INSTRUCTIONS[campaign.meta.difficulty]}

## World & scenario setup
${campaign.body.trim()}
${campaign.meta.houseRules ? `\nHouse rules: ${campaign.meta.houseRules}` : ''}

## Running summary of the story so far
${rollingSummary.trim() || '(no summary yet)'}

## Most recent turns
${renderRecentTurns(recentTurns)}

## Current documented state (treat as ground truth — do not contradict it)
${renderSnapshot(snapshot)}

## This turn
Turn number: ${turnNumber}
Current location: ${campaign.meta.currentLocation}
The player's action: ${playerAction}

${STATE_CONTRACT_INSTRUCTIONS}`
}
