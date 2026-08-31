import { appendRows, updateRow } from './sheetsApi'
import { rowCodecs } from './sheetSchema'
import { appendNpcDetail } from './npcDetailFile'
import { namesFromSnapshot, playerNameFromSnapshot, type SheetSnapshot } from '@/lib/ai/promptBuilder'
import { extractSpeakingNames } from '@/lib/ai/turnBlocks'
import { isKnownKokoroVoiceId } from '@/lib/voice/kokoroVoiceCatalog'
import { deterministicFallbackVoiceId, isValidVoiceSpeed } from '@/lib/voice/voiceCasting'
import type { StateDelta } from '@/types/turn'
import type { CharacterRow, InventoryItem, MapNode, Monster, Npc, NpcAttribute, Quest, Thread } from '@/types/sheets'

/** Coerces an AI-supplied `voiceId` to either itself (if it's a real catalog id) or `undefined` —
 * an unrecognized id is silently discarded rather than ever reaching the sheet, defense-in-depth
 * alongside validate.ts's warning (a warning alone doesn't block the write). */
function coerceVoiceId(voiceId: string | undefined): string | undefined {
  return isKnownKokoroVoiceId(voiceId) ? voiceId : undefined
}

/** Same defense-in-depth coercion for `voiceSpeed` — see coerceVoiceId's doc comment. */
function coerceVoiceSpeed(voiceSpeed: number | undefined): number | undefined {
  return isValidVoiceSpeed(voiceSpeed) ? voiceSpeed : undefined
}

/** How this app decides an NPC's gender for the deterministic voice-casting fallback (issue #98):
 * a free-form "Gender" fact in NPCAttributes, if the AI (or a player editing the sheet by hand) has
 * ever recorded one — never a hard-coded field on Npc itself, per CLAUDE.md's "Genre-agnostic by
 * design" rule. Absent or unrecognized simply means "cast from the whole catalog," not an error. */
function genderForNpc(npcId: string, attributes: NpcAttribute[]): 'Male' | 'Female' | undefined {
  const raw = attributes
    .find((a) => a.npcId === npcId && a.key.trim().toLowerCase() === 'gender')
    ?.value.trim()
    .toLowerCase()
  if (raw === 'male' || raw === 'm') return 'Male'
  if (raw === 'female' || raw === 'f') return 'Female'
  return undefined
}

function rowNumberOf<T>(rows: T[], predicate: (r: T) => boolean): number | null {
  const idx = rows.findIndex(predicate)
  return idx === -1 ? null : idx + 2 // +1 for 0-index, +1 for header row
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const newId = () => crypto.randomUUID().slice(0, 8)

/** Clamps a thread's clock fill into [0, progressMax] — progressMax <= 0 means "not using a
 * clock," so only the lower bound applies in that case. Defense-in-depth: validate.ts already
 * warns on an out-of-range value, but a warning doesn't block the write. */
function clampProgress(progress: number | undefined, progressMax: number): number {
  const p = progress ?? 0
  if (progressMax <= 0) return Math.max(0, p)
  return Math.min(Math.max(0, p), progressMax)
}

/** Narrator/player voice context for the deterministic voice-casting fallback (issue #98) — see
 * applyStateDelta's own doc comment for how it's used. */
export interface VoiceCastingContext {
  narratorVoiceId?: string
  playerVoiceId?: string
}

/** Applies an already-validated StateDelta as a batch of Sheets writes. Mutates the passed
 * snapshot in place so callers can re-render immediately without another round trip.
 * `campaignFolderId` is needed only for NPC `notes_add` — appending to that NPC's
 * world/npcs/<slug>.md detail file (see npcDetailFile.ts). `narrative` and `voiceCasting` are
 * issue #98's addition: `narrative` is this turn's raw prose (including any `{{v:Name}}` speaker
 * tokens), used purely to figure out which known NPCs actually spoke this turn so a deterministic
 * fallback voice can be assigned to anyone who spoke but the AI didn't cast — see the "Voice
 * casting fallback" block at the end of this function. Both are optional so any existing/future
 * caller that doesn't care about voice casting (e.g. a test exercising unrelated delta fields)
 * doesn't have to thread them through. */
export async function applyStateDelta(
  spreadsheetId: string,
  delta: StateDelta,
  snapshot: SheetSnapshot,
  turnNumber: number,
  campaignFolderId: string,
  narrative = '',
  voiceCasting: VoiceCastingContext = {},
): Promise<void> {
  // Inventory removals — decrement qty, or deactivate the row rather than deleting it (keeps history).
  for (const removal of delta.inventory_remove ?? []) {
    const rowNum = rowNumberOf(snapshot.Inventory, (i) => sameName(i.name, removal.name))
    if (rowNum === null) continue
    const item = snapshot.Inventory[rowNum - 2]
    const qty = removal.qty ?? 1
    const updated: InventoryItem = { ...item, qty: Math.max(0, item.qty - qty) }
    updated.active = updated.qty > 0
    snapshot.Inventory[rowNum - 2] = updated
    await updateRow(spreadsheetId, 'Inventory', rowNum, rowCodecs.Inventory.toRow(updated))
  }

  // Inventory additions.
  const newItems: InventoryItem[] = (delta.inventory_add ?? [])
    .filter((a) => a.name?.trim())
    .map((a) => ({
      id: newId(),
      name: a.name,
      qty: a.qty ?? 1,
      description: a.note ?? '',
      tags: '',
      acquiredTurn: turnNumber,
      active: true,
    }))
  if (newItems.length) {
    await appendRows(spreadsheetId, 'Inventory', newItems.map(rowCodecs.Inventory.toRow))
    snapshot.Inventory.push(...newItems)
  }

  // Numeric/string stat changes, plus status effects stored under the "statusEffects" key.
  for (const [key, value] of Object.entries(delta.stat_changes ?? {})) {
    await upsertCharacterStat(spreadsheetId, snapshot, key, (current) => {
      const currentNum = current !== undefined ? Number(current) : undefined
      if (typeof value === 'number' && currentNum !== undefined && !Number.isNaN(currentNum)) {
        return String(currentNum + value)
      }
      return String(value)
    })
  }
  if (delta.status_add?.length || delta.status_remove?.length) {
    await upsertCharacterStat(spreadsheetId, snapshot, 'statusEffects', (current) => {
      const set = new Set((current ?? '').split(',').map((s) => s.trim()).filter(Boolean))
      for (const s of delta.status_add ?? []) set.add(s)
      for (const s of delta.status_remove ?? []) set.delete(s)
      return [...set].join(', ')
    })
  }

  // NPCs — append new, then update existing (by name), same upsert-by-name pattern as
  // Quests/Threads below. new_npcs runs first so a same-turn new_npcs + npc_updates pair for the
  // same name (the AI introduces an NPC and immediately gives them a status/relationship update
  // in the same turn) lands the create's full description/voice/secrets before the update merges
  // its fields on top, rather than the update finding no row, creating a bare stub, and the
  // create then silently no-op'ing because the name "already exists" — same bug shape as issue
  // #83/PR #85's Threads fix (commit a66b457), found for NPCs in independent review of that PR
  // (issue #86). Profile fields (voice/secrets/attributes/notes_add) are optional per the AI's
  // own profile-depth judgment (see contract.ts's "real interaction" gate) — a background NPC
  // mentioned in passing carries none of them and stays name+description only, exactly like
  // before this ticket.
  for (const n of delta.new_npcs ?? []) {
    if (!n.name?.trim() || snapshot.NPCs.some((existing) => sameName(existing.name, n.name))) continue
    const created: Npc = {
      id: newId(),
      name: n.name,
      description: n.description ?? '',
      relationship: '',
      status: n.status ?? 'alive',
      lastSeenTurn: turnNumber,
      voice: n.voice ?? '',
      secrets: n.secrets ?? '',
      notes: n.notes_add ?? '',
      detailFile: undefined,
      voiceId: coerceVoiceId(n.voiceId) ?? '',
      voiceSpeed: coerceVoiceSpeed(n.voiceSpeed) ?? 0,
      voiceLocked: false,
    }
    if (n.notes_add) {
      created.detailFile = await appendNpcDetail(campaignFolderId, created, turnNumber, n.notes_add)
    }
    await appendRows(spreadsheetId, 'NPCs', [rowCodecs.NPCs.toRow(created)])
    snapshot.NPCs.push(created)
    await upsertNpcAttributes(spreadsheetId, snapshot, created.id, n.attributes)
  }
  for (const update of delta.npc_updates ?? []) {
    const rowNum = rowNumberOf(snapshot.NPCs, (n) => sameName(n.name, update.name))
    if (rowNum === null) {
      const created: Npc = {
        id: newId(),
        name: update.name,
        description: '',
        relationship: update.relationship ?? '',
        status: update.status ?? 'unknown',
        lastSeenTurn: turnNumber,
        voice: update.voice ?? '',
        secrets: update.secrets ?? '',
        notes: update.notes_add ?? '',
        detailFile: undefined,
        voiceId: coerceVoiceId(update.voiceId) ?? '',
        voiceSpeed: coerceVoiceSpeed(update.voiceSpeed) ?? 0,
        voiceLocked: false,
      }
      if (update.notes_add) {
        created.detailFile = await appendNpcDetail(campaignFolderId, created, turnNumber, update.notes_add)
      }
      await appendRows(spreadsheetId, 'NPCs', [rowCodecs.NPCs.toRow(created)])
      snapshot.NPCs.push(created)
      await upsertNpcAttributes(spreadsheetId, snapshot, created.id, update.attributes)
      continue
    }
    const existing = snapshot.NPCs[rowNum - 2]
    let detailFile = existing.detailFile
    if (update.notes_add) {
      detailFile = await appendNpcDetail(campaignFolderId, existing, turnNumber, update.notes_add)
    }
    const merged: Npc = {
      ...existing,
      status: update.status ?? existing.status,
      relationship: update.relationship ?? existing.relationship,
      lastSeenTurn: turnNumber,
      voice: update.voice ?? existing.voice,
      secrets: update.secrets ?? existing.secrets,
      // "notes" is a condensed running summary rewritten in place on each update, same pattern
      // as the campaign-wide rolling summary — notes_add doubles as both the fresh condensed
      // value here and the permanent entry appended to the detail file above.
      notes: update.notes_add ?? existing.notes,
      detailFile,
      // A voiceLocked NPC's cast voice/speed must never change regardless of what the AI sent —
      // issue #98's explicit requirement (see tests/voice-casting.spec.ts's lock-protection test).
      // An unlocked NPC merges a valid new voiceId/voiceSpeed the same `?? existing` pattern as
      // every other field above; an invalid one (already discarded by coerceVoiceId/
      // coerceVoiceSpeed, defense-in-depth alongside validate.ts's warning) keeps the existing
      // value instead of ever landing on the sheet.
      voiceId: existing.voiceLocked ? existing.voiceId : (coerceVoiceId(update.voiceId) ?? existing.voiceId),
      voiceSpeed: existing.voiceLocked
        ? existing.voiceSpeed
        : (coerceVoiceSpeed(update.voiceSpeed) ?? existing.voiceSpeed),
    }
    snapshot.NPCs[rowNum - 2] = merged
    await updateRow(spreadsheetId, 'NPCs', rowNum, rowCodecs.NPCs.toRow(merged))
    await upsertNpcAttributes(spreadsheetId, snapshot, merged.id, update.attributes)
  }

  // Voice casting fallback (issue #98) — runs after every NPC create/update above has landed, so
  // it sees this turn's freshly-created/updated rows too. Any known NPC who spoke this turn (per
  // #96's speaker tokens, or the heuristic fallback for a weaker backend/manual paste that never
  // used them — see turnBlocks.ts's extractSpeakingNames) but still has no voiceId after
  // everything above (the AI just didn't cast one) gets a deterministic one now, so a later
  // playback ticket (#66) always has something to switch to. voiceLocked NPCs are skipped
  // entirely — they already have a voice, by construction (nothing sets voiceLocked without also
  // setting voiceId today), and even if not, locking means "don't touch this NPC's casting."
  if (narrative) {
    const knownNames = namesFromSnapshot(snapshot)
    const speakingNames = extractSpeakingNames(narrative, knownNames)
    if (speakingNames.size > 0) {
      const playerName = playerNameFromSnapshot(snapshot)
      const reservedVoiceIds = [voiceCasting.narratorVoiceId, voiceCasting.playerVoiceId]
      for (const speaker of speakingNames) {
        if (playerName && sameName(speaker, playerName)) continue // the player has their own field, not an NPC row
        const rowNum = rowNumberOf(snapshot.NPCs, (n) => sameName(n.name, speaker))
        if (rowNum === null) continue // spoke per the heuristic but isn't a documented NPC — nothing to write to
        const npc = snapshot.NPCs[rowNum - 2]
        if (npc.voiceId || npc.voiceLocked) continue
        const inUseVoiceIds = snapshot.NPCs.filter((n) => n.id !== npc.id && n.voiceId).map((n) => n.voiceId)
        const fallbackVoiceId = deterministicFallbackVoiceId(npc.name, {
          reservedVoiceIds,
          inUseVoiceIds,
          gender: genderForNpc(npc.id, snapshot.NPCAttributes),
        })
        const updated: Npc = { ...npc, voiceId: fallbackVoiceId }
        snapshot.NPCs[rowNum - 2] = updated
        await updateRow(spreadsheetId, 'NPCs', rowNum, rowCodecs.NPCs.toRow(updated))
      }
    }
  }

  // Monsters.
  const newMonsters: Monster[] = (delta.new_monsters ?? [])
    .filter((m) => m.name?.trim())
    .map((m) => ({
      id: newId(),
      name: m.name,
      description: m.description ?? '',
      threatNotes: m.threatNotes ?? '',
      status: 'alive',
      lastEncounteredTurn: turnNumber,
    }))
  if (newMonsters.length) {
    await appendRows(spreadsheetId, 'Monsters', newMonsters.map(rowCodecs.Monsters.toRow))
    snapshot.Monsters.push(...newMonsters)
  }

  // Locations.
  const newLocations: MapNode[] = (delta.new_locations ?? [])
    .filter((l) => l.name?.trim())
    .map((l) => ({
      id: newId(),
      name: l.name,
      type: 'location',
      state: l.state ?? 'discovered',
      connectsTo: l.connects_to ?? '',
      description: l.description ?? '',
    }))
  if (newLocations.length) {
    await appendRows(spreadsheetId, 'Map', newLocations.map(rowCodecs.Map.toRow))
    snapshot.Map.push(...newLocations)
  }

  // Timeline events.
  if (delta.events?.length) {
    const rows = delta.events
      .filter((e) => e.title?.trim())
      .map((e) => ({ turn: turnNumber, title: e.title, summary: e.summary ?? '', tags: e.tags ?? '' }))
    await appendRows(spreadsheetId, 'Timeline', rows.map(rowCodecs.Timeline.toRow))
    snapshot.Timeline.push(...rows)
  }

  // Quests — update existing (by title) or append new.
  for (const update of delta.quest_updates ?? []) {
    const rowNum = rowNumberOf(snapshot.Quests, (q) => sameName(q.title, update.title))
    if (rowNum === null) {
      const created: Quest = {
        id: newId(),
        title: update.title,
        status: update.status ?? 'active',
        description: update.description ?? '',
        updatedTurn: turnNumber,
      }
      await appendRows(spreadsheetId, 'Quests', [rowCodecs.Quests.toRow(created)])
      snapshot.Quests.push(created)
      continue
    }
    const existing = snapshot.Quests[rowNum - 2]
    const merged: Quest = {
      ...existing,
      status: update.status ?? existing.status,
      description: update.description ?? existing.description,
      updatedTurn: turnNumber,
    }
    snapshot.Quests[rowNum - 2] = merged
    await updateRow(spreadsheetId, 'Quests', rowNum, rowCodecs.Quests.toRow(merged))
  }

  // Story threads (issue #83) — append new, then update existing (by title), same upsert-by-name
  // pattern as Quests just above. new_threads runs first so a same-turn new_threads +
  // thread_updates pair for the same title (the AI plants a thread and immediately advances it
  // in one turn) lands the create's full description/progressMax before the update merges its
  // fields on top, rather than the update finding no row, creating a bare stub, and the create
  // then silently no-op'ing because the title "already exists" — found in independent review of
  // PR #85. `progress` is clamped into [0, progressMax] defensively even though validate.ts
  // already warns on an out-of-range value — a warning doesn't block the write, so this is what
  // actually keeps a bad value out of the sheet.
  for (const t of delta.new_threads ?? []) {
    if (!t.title?.trim() || snapshot.Threads.some((existing) => sameName(existing.title, t.title))) continue
    const progressMax = t.progressMax ?? 0
    const created: Thread = {
      id: newId(),
      title: t.title,
      description: t.description ?? '',
      status: t.status ?? 'dormant',
      revealed: t.revealed ?? false,
      progress: clampProgress(t.progress, progressMax),
      progressMax,
      createdTurn: turnNumber,
      updatedTurn: turnNumber,
    }
    await appendRows(spreadsheetId, 'Threads', [rowCodecs.Threads.toRow(created)])
    snapshot.Threads.push(created)
  }
  for (const update of delta.thread_updates ?? []) {
    const rowNum = rowNumberOf(snapshot.Threads, (t) => sameName(t.title, update.title))
    if (rowNum === null) {
      const progressMax = update.progressMax ?? 0
      const created: Thread = {
        id: newId(),
        title: update.title,
        description: update.description ?? '',
        status: update.status ?? 'dormant',
        revealed: update.revealed ?? false,
        progress: clampProgress(update.progress, progressMax),
        progressMax,
        createdTurn: turnNumber,
        updatedTurn: turnNumber,
      }
      await appendRows(spreadsheetId, 'Threads', [rowCodecs.Threads.toRow(created)])
      snapshot.Threads.push(created)
      continue
    }
    const existing = snapshot.Threads[rowNum - 2]
    const progressMax = update.progressMax ?? existing.progressMax
    const merged: Thread = {
      ...existing,
      description: update.description ?? existing.description,
      status: update.status ?? existing.status,
      revealed: update.revealed ?? existing.revealed,
      progress: update.progress !== undefined ? clampProgress(update.progress, progressMax) : existing.progress,
      progressMax,
      updatedTurn: turnNumber,
    }
    snapshot.Threads[rowNum - 2] = merged
    await updateRow(spreadsheetId, 'Threads', rowNum, rowCodecs.Threads.toRow(merged))
  }

  // Lore.
  const newLore = (delta.new_lore ?? [])
    .filter((l) => l.name?.trim())
    .map((l) => ({
      id: newId(),
      type: l.type ?? 'lore',
      name: l.name,
      summary: l.summary ?? '',
      tags: l.tags ?? '',
      discovered: true,
      detailFile: undefined,
    }))
  if (newLore.length) {
    await appendRows(spreadsheetId, 'Lore', newLore.map(rowCodecs.Lore.toRow))
    snapshot.Lore.push(...newLore)
  }
}

/** Writes an NPC's free-form attributes (a clan allegiance, cybernetic augments, ...) into the
 * NPCAttributes tab — appends a new (npcId, key) row, or updates the existing one's value in
 * place. Same upsert-by-key shape as upsertCharacterStat, just scoped per-NPC. */
async function upsertNpcAttributes(
  spreadsheetId: string,
  snapshot: SheetSnapshot,
  npcId: string,
  attributes: Record<string, string> | undefined,
): Promise<void> {
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const rowNum = rowNumberOf(
      snapshot.NPCAttributes,
      (a) => a.npcId === npcId && sameName(a.key, key),
    )
    if (rowNum === null) {
      const created: NpcAttribute = { npcId, key, value }
      await appendRows(spreadsheetId, 'NPCAttributes', [rowCodecs.NPCAttributes.toRow(created)])
      snapshot.NPCAttributes.push(created)
      continue
    }
    const existing = snapshot.NPCAttributes[rowNum - 2]
    const updated: NpcAttribute = { npcId, key: existing.key, value }
    snapshot.NPCAttributes[rowNum - 2] = updated
    await updateRow(spreadsheetId, 'NPCAttributes', rowNum, rowCodecs.NPCAttributes.toRow(updated))
  }
}

async function upsertCharacterStat(
  spreadsheetId: string,
  snapshot: SheetSnapshot,
  key: string,
  next: (current: string | undefined) => string,
): Promise<void> {
  const rowNum = rowNumberOf(snapshot.Character, (c) => sameName(c.key, key))
  if (rowNum === null) {
    const created: CharacterRow = { key, value: next(undefined) }
    await appendRows(spreadsheetId, 'Character', [rowCodecs.Character.toRow(created)])
    snapshot.Character.push(created)
    return
  }
  const existing = snapshot.Character[rowNum - 2]
  const updated: CharacterRow = { key: existing.key, value: next(existing.value) }
  snapshot.Character[rowNum - 2] = updated
  await updateRow(spreadsheetId, 'Character', rowNum, rowCodecs.Character.toRow(updated))
}
