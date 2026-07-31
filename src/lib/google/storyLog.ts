import { ensureFolder, ensureTextFile, getTextFile, updateTextFile } from './driveApi'
import type { TurnRecord } from '@/types/turn'

const TURNS_PER_CHUNK = 50

function chunkFileName(turnNumber: number): string {
  const chunkIndex = Math.floor((Math.max(turnNumber, 1) - 1) / TURNS_PER_CHUNK) + 1
  return `${String(chunkIndex).padStart(4, '0')}.md`
}

async function getLogFolder(campaignFolderId: string) {
  const story = await ensureFolder('story', campaignFolderId)
  return ensureFolder('log', story.id)
}

/** Separates suggested-options text from narrative in the log — a middle dot, since option
 * phrases can themselves contain commas/semicolons but essentially never this character. */
const OPTIONS_PREFIX = '**Suggested next:** '
const OPTIONS_SEPARATOR = ' · '

function formatTurn(turn: TurnRecord): string {
  const optionsLine = turn.optionsOffered.length
    ? `\n\n${OPTIONS_PREFIX}${turn.optionsOffered.join(OPTIONS_SEPARATOR)}`
    : ''
  return `## Turn ${turn.turn}\n**You:** ${turn.playerAction}\n\n${turn.narrative.trim()}${optionsLine}\n`
}

/** Splits a captured turn body back into narrative + suggested options — the inverse of the
 * optionsLine appended by formatTurn. Logs written before this existed simply have no options
 * line, which falls back to an empty options list exactly like before. */
function splitNarrativeAndOptions(raw: string): { narrative: string; options: string[] } {
  const trimmed = raw.trim()
  const markerIndex = trimmed.lastIndexOf(`\n${OPTIONS_PREFIX}`)
  if (markerIndex === -1) {
    if (trimmed.startsWith(OPTIONS_PREFIX)) {
      return {
        narrative: '',
        options: trimmed
          .slice(OPTIONS_PREFIX.length)
          .split(OPTIONS_SEPARATOR)
          .map((s) => s.trim())
          .filter(Boolean),
      }
    }
    return { narrative: trimmed, options: [] }
  }
  return {
    narrative: trimmed.slice(0, markerIndex).trim(),
    options: trimmed
      .slice(markerIndex + 1 + OPTIONS_PREFIX.length)
      .split(OPTIONS_SEPARATOR)
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

export async function appendTurnToLog(campaignFolderId: string, turn: TurnRecord): Promise<void> {
  const folder = await getLogFolder(campaignFolderId)
  const name = chunkFileName(turn.turn)
  const { file, created } = await ensureTextFile(folder.id, name, '')
  const existing = created ? '' : await getTextFile(file.id)
  const next = existing.trim() ? `${existing.trim()}\n\n${formatTurn(turn)}` : formatTurn(turn)
  await updateTextFile(file.id, next)
}

// The lookahead's end-of-input branch must be `(?![\s\S])` (true end of string), not `\s*$`:
// under the /m flag, `$` matches at *every* line ending, so a lazy `[\s\S]*?` would stop right
// after the narrative's first line instead of capturing the full turn body (including the
// options line appended below).
const TURN_HEADER_RE = /^## Turn (\d+)\n\*\*You:\*\* (.*)\n\n([\s\S]*?)(?=\n## Turn \d+\n|(?![\s\S]))/gm

function parseTurns(content: string): TurnRecord[] {
  const out: TurnRecord[] = []
  for (const match of content.matchAll(TURN_HEADER_RE)) {
    const { narrative, options } = splitNarrativeAndOptions(match[3])
    out.push({
      turn: Number(match[1]),
      timestamp: '',
      playerAction: match[2].trim(),
      narrative,
      optionsOffered: options,
    })
  }
  return out
}

/** Reads the last `count` turns, pulling from the previous chunk file too if the current
 * chunk doesn't have enough yet (e.g. right after a chunk boundary). */
export async function readRecentTurns(
  campaignFolderId: string,
  currentTurn: number,
  count = 6,
): Promise<TurnRecord[]> {
  if (currentTurn <= 0) return []
  const folder = await getLogFolder(campaignFolderId)
  const currentChunk = chunkFileName(currentTurn)
  let turns: TurnRecord[] = []

  const { file, created } = await ensureTextFile(folder.id, currentChunk, '')
  if (!created) {
    turns = parseTurns(await getTextFile(file.id))
  }

  if (turns.length < count && currentTurn > TURNS_PER_CHUNK) {
    const prevChunk = chunkFileName(currentTurn - TURNS_PER_CHUNK)
    if (prevChunk !== currentChunk) {
      const { file: prevFile, created: prevCreated } = await ensureTextFile(folder.id, prevChunk, '')
      if (!prevCreated) {
        turns = [...parseTurns(await getTextFile(prevFile.id)), ...turns]
      }
    }
  }

  return turns.slice(-count)
}
