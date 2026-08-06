import { appendRows, updateRow } from './sheetsApi'
import { rowCodecs } from './sheetSchema'
import { appendNpcDetail } from './npcDetailFile'
import type { SheetSnapshot } from '@/lib/ai/promptBuilder'
import type { StateDelta } from '@/types/turn'
import type { CharacterRow, InventoryItem, MapNode, Monster, Npc, NpcAttribute, Quest } from '@/types/sheets'

function rowNumberOf<T>(rows: T[], predicate: (r: T) => boolean): number | null {
  const idx = rows.findIndex(predicate)
  return idx === -1 ? null : idx + 2 // +1 for 0-index, +1 for header row
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const newId = () => crypto.randomUUID().slice(0, 8)

/** Applies an already-validated StateDelta as a batch of Sheets writes. Mutates the passed
 * snapshot in place so callers can re-render immediately without another round trip.
 * `campaignFolderId` is needed only for NPC `notes_add` — appending to that NPC's
 * world/npcs/<slug>.md detail file (see npcDetailFile.ts). */
export async function applyStateDelta(
  spreadsheetId: string,
  delta: StateDelta,
  snapshot: SheetSnapshot,
  turnNumber: number,
  campaignFolderId: string,
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

  // NPCs — update existing (by name) or append new. Profile fields (voice/secrets/attributes/
  // notes_add) are optional per the AI's own profile-depth judgment (see contract.ts's
  // "real interaction" gate) — a background NPC mentioned in passing carries none of them and
  // stays name+description only, exactly like before this ticket.
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
    }
    snapshot.NPCs[rowNum - 2] = merged
    await updateRow(spreadsheetId, 'NPCs', rowNum, rowCodecs.NPCs.toRow(merged))
    await upsertNpcAttributes(spreadsheetId, snapshot, merged.id, update.attributes)
  }
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
    }
    if (n.notes_add) {
      created.detailFile = await appendNpcDetail(campaignFolderId, created, turnNumber, n.notes_add)
    }
    await appendRows(spreadsheetId, 'NPCs', [rowCodecs.NPCs.toRow(created)])
    snapshot.NPCs.push(created)
    await upsertNpcAttributes(spreadsheetId, snapshot, created.id, n.attributes)
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
