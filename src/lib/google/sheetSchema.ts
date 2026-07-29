import type { Row } from './sheetsApi'
import type {
  CharacterRow,
  InventoryItem,
  Skill,
  Npc,
  Monster,
  TimelineEvent,
  Quest,
  MapNode,
  LoreEntry,
} from '@/types/sheets'
import { SHEET_TABS } from '@/types/sheets'

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'TRUE'

export const TAB_HEADERS: Record<(typeof SHEET_TABS)[number], string[]> = {
  Character: ['key', 'value'],
  Inventory: ['id', 'name', 'qty', 'description', 'tags', 'acquiredTurn', 'active'],
  Skills: ['id', 'name', 'rank', 'description'],
  NPCs: ['id', 'name', 'description', 'relationship', 'status', 'lastSeenTurn'],
  Monsters: ['id', 'name', 'description', 'threatNotes', 'status', 'lastEncounteredTurn'],
  Timeline: ['turn', 'title', 'summary', 'tags'],
  Quests: ['id', 'title', 'status', 'description', 'updatedTurn'],
  Map: ['id', 'name', 'type', 'state', 'connectsTo', 'description', 'x', 'y'],
  Lore: ['id', 'type', 'name', 'summary', 'tags', 'discovered', 'detailFile'],
}

const newId = () => crypto.randomUUID().slice(0, 8)

export const rowCodecs = {
  Character: {
    toRow: (r: CharacterRow): Row => [r.key, r.value],
    fromRow: (c: Row): CharacterRow => ({ key: str(c[0]), value: str(c[1]) }),
  },
  Inventory: {
    toRow: (r: InventoryItem): Row => [
      r.id, r.name, r.qty, r.description, r.tags, r.acquiredTurn, r.active,
    ],
    fromRow: (c: Row): InventoryItem => ({
      id: str(c[0]) || newId(),
      name: str(c[1]),
      qty: num(c[2]),
      description: str(c[3]),
      tags: str(c[4]),
      acquiredTurn: num(c[5]),
      active: bool(c[6]),
    }),
  },
  Skills: {
    toRow: (r: Skill): Row => [r.id, r.name, r.rank, r.description],
    fromRow: (c: Row): Skill => ({
      id: str(c[0]) || newId(),
      name: str(c[1]),
      rank: str(c[2]),
      description: str(c[3]),
    }),
  },
  NPCs: {
    toRow: (r: Npc): Row => [r.id, r.name, r.description, r.relationship, r.status, r.lastSeenTurn],
    fromRow: (c: Row): Npc => ({
      id: str(c[0]) || newId(),
      name: str(c[1]),
      description: str(c[2]),
      relationship: str(c[3]),
      status: (str(c[4]) || 'unknown') as Npc['status'],
      lastSeenTurn: num(c[5]),
    }),
  },
  Monsters: {
    toRow: (r: Monster): Row => [
      r.id, r.name, r.description, r.threatNotes, r.status, r.lastEncounteredTurn,
    ],
    fromRow: (c: Row): Monster => ({
      id: str(c[0]) || newId(),
      name: str(c[1]),
      description: str(c[2]),
      threatNotes: str(c[3]),
      status: (str(c[4]) || 'unknown') as Monster['status'],
      lastEncounteredTurn: num(c[5]),
    }),
  },
  Timeline: {
    toRow: (r: TimelineEvent): Row => [r.turn, r.title, r.summary, r.tags],
    fromRow: (c: Row): TimelineEvent => ({
      turn: num(c[0]),
      title: str(c[1]),
      summary: str(c[2]),
      tags: str(c[3]),
    }),
  },
  Quests: {
    toRow: (r: Quest): Row => [r.id, r.title, r.status, r.description, r.updatedTurn],
    fromRow: (c: Row): Quest => ({
      id: str(c[0]) || newId(),
      title: str(c[1]),
      status: (str(c[2]) || 'active') as Quest['status'],
      description: str(c[3]),
      updatedTurn: num(c[4]),
    }),
  },
  Map: {
    toRow: (r: MapNode): Row => [
      r.id, r.name, r.type, r.state, r.connectsTo, r.description, r.x ?? '', r.y ?? '',
    ],
    fromRow: (c: Row): MapNode => ({
      id: str(c[0]) || newId(),
      name: str(c[1]),
      type: str(c[2]),
      state: (str(c[3]) || 'unexplored') as MapNode['state'],
      connectsTo: str(c[4]),
      description: str(c[5]),
      x: c[6] === '' || c[6] === undefined ? undefined : num(c[6]),
      y: c[7] === '' || c[7] === undefined ? undefined : num(c[7]),
    }),
  },
  Lore: {
    toRow: (r: LoreEntry): Row => [
      r.id, r.type, r.name, r.summary, r.tags, r.discovered, r.detailFile ?? '',
    ],
    fromRow: (c: Row): LoreEntry => ({
      id: str(c[0]) || newId(),
      type: str(c[1]),
      name: str(c[2]),
      summary: str(c[3]),
      tags: str(c[4]),
      discovered: bool(c[5]),
      detailFile: str(c[6]) || undefined,
    }),
  },
} as const

/** Drops the header row and maps the rest through a tab's fromRow codec. */
export function decodeTab<T>(tab: keyof typeof rowCodecs, rows: Row[]): T[] {
  const codec = rowCodecs[tab]
  return rows.slice(1).map((r) => codec.fromRow(r) as unknown as T)
}
