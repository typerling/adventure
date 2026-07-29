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

function formatTurn(turn: TurnRecord): string {
  return `## Turn ${turn.turn}\n**You:** ${turn.playerAction}\n\n${turn.narrative.trim()}\n`
}

export async function appendTurnToLog(campaignFolderId: string, turn: TurnRecord): Promise<void> {
  const folder = await getLogFolder(campaignFolderId)
  const name = chunkFileName(turn.turn)
  const { file, created } = await ensureTextFile(folder.id, name, '')
  const existing = created ? '' : await getTextFile(file.id)
  const next = existing.trim() ? `${existing.trim()}\n\n${formatTurn(turn)}` : formatTurn(turn)
  await updateTextFile(file.id, next)
}

const TURN_HEADER_RE = /^## Turn (\d+)\n\*\*You:\*\* (.*)\n\n([\s\S]*?)(?=\n## Turn \d+\n|\s*$)/gm

function parseTurns(content: string): TurnRecord[] {
  const out: TurnRecord[] = []
  for (const match of content.matchAll(TURN_HEADER_RE)) {
    out.push({
      turn: Number(match[1]),
      timestamp: '',
      playerAction: match[2].trim(),
      narrative: match[3].trim(),
      optionsOffered: [],
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
