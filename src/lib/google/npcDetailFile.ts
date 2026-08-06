/** Per-NPC append-only detail history: world/npcs/<slug>.md — mirrors the *intent* of
 * LoreEntry.detailFile (world/lore/<slug>.md), but built for real here (that Lore field is a
 * dead stub — nothing reads/writes it yet). Structurally modeled on storyLog.ts's
 * folder-per-purpose, ensure-then-append pattern, without the turn-count chunking that file
 * needs for a campaign-wide log — one NPC's history never gets that large. */
import { ensureFolder, ensureTextFile, findFile, getTextFile, updateTextFile } from './driveApi'
import type { Npc } from '@/types/sheets'

/** Turns an NPC name into a filesystem-safe slug — lowercase, non-alphanumerics collapsed to
 * single hyphens, trimmed. Falls back to the NPC id if the name slugifies to nothing (e.g. a
 * name that's entirely punctuation/emoji), so the file always has a stable, non-empty name. */
export function slugifyNpcName(npc: Pick<Npc, 'id' | 'name'>): string {
  const slug = npc.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || npc.id
}

async function getNpcsFolder(campaignFolderId: string) {
  const world = await ensureFolder('world', campaignFolderId)
  return ensureFolder('npcs', world.id)
}

/** The relative Drive path this file is stored at, suitable for the NPCs tab's `detailFile`
 * pointer column (human-readable for anyone inspecting the sheet directly). */
export function npcDetailFilePath(npc: Pick<Npc, 'id' | 'name'>): string {
  return `world/npcs/${slugifyNpcName(npc)}.md`
}

/** Appends a turn-numbered entry to an NPC's detail file (created on first use), and returns the
 * `detailFile` pointer to persist on the NPCs row. Deterministic, app-side — not an extra AI
 * call: the app decides when to write, using the text the AI already produced this turn. */
export async function appendNpcDetail(
  campaignFolderId: string,
  npc: Pick<Npc, 'id' | 'name'>,
  turnNumber: number,
  text: string,
): Promise<string> {
  const folder = await getNpcsFolder(campaignFolderId)
  const name = `${slugifyNpcName(npc)}.md`
  const { file, created } = await ensureTextFile(folder.id, name, '')
  const existing = created ? '' : await getTextFile(file.id)
  const entry = `## Turn ${turnNumber}\n${text.trim()}\n`
  const next = existing.trim() ? `${existing.trim()}\n\n${entry}` : entry
  await updateTextFile(file.id, next)
  return npcDetailFilePath(npc)
}

/** Reads the full content of an NPC's detail file, given the `detailFile` pointer stored on its
 * NPCs row. Looked up by traversing world/npcs/ rather than a stored file id, since the sheet
 * only keeps the human-readable path. Returns '' if the file can't be found (e.g. the pointer is
 * stale) rather than throwing — a missing detail file shouldn't block prompt building, and a
 * plain lookup (not ensureTextFile) avoids creating an empty file as a side effect of reading. */
export async function getNpcDetailContent(
  campaignFolderId: string,
  detailFile: string,
): Promise<string> {
  const fileName = detailFile.split('/').at(-1)
  if (!fileName) return ''
  const folder = await getNpcsFolder(campaignFolderId)
  const file = await findFile(folder.id, fileName)
  if (!file) return ''
  return getTextFile(file.id)
}
