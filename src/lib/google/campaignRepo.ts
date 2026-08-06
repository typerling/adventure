import { ensureFolder, ensureTextFile, getTextFile, listChildren, updateTextFile } from './driveApi'
import { createSpreadsheet, batchGetTabs, appendRows } from './sheetsApi'
import { TAB_HEADERS, rowCodecs, decodeTab } from './sheetSchema'
import { parseFrontmatter, stringifyFrontmatter } from '@/lib/markdown/frontmatter'
import { SHEET_TABS } from '@/types/sheets'
import type {
  CampaignFile,
  CampaignMeta,
  CampaignSettings,
  CampaignSummary,
  Difficulty,
} from '@/types/campaign'
import { DEFAULT_SETTINGS } from '@/types/campaign'
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
  TimelineEvent,
} from '@/types/sheets'

export const ROOT_FOLDER_NAME = 'Adventure'

export interface Library {
  rootId: string
  campaignsFolderId: string
}

export async function bootstrapLibrary(rootFolderName = ROOT_FOLDER_NAME): Promise<Library> {
  const root = await ensureFolder(rootFolderName)
  const campaigns = await ensureFolder('campaigns', root.id)
  return { rootId: root.id, campaignsFolderId: campaigns.id }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'campaign'}-${Date.now().toString(36)}`
}

export async function listCampaigns(campaignsFolderId: string): Promise<CampaignSummary[]> {
  const folders = await listChildren(campaignsFolderId, 'application/vnd.google-apps.folder')
  const summaries = await Promise.all(
    folders.map(async (folder): Promise<CampaignSummary | null> => {
      try {
        const md = await getTextFile((await mustFind(folder.id, 'campaign.md')).id)
        const { data } = parseFrontmatter(md)
        return {
          slug: String(data.slug ?? folder.name),
          folderId: folder.id,
          name: String(data.name ?? folder.name),
          difficulty: (data.difficulty as Difficulty) ?? 'Standard',
          currentTurn: Number(data.currentTurn ?? 0),
          updatedAt: folder.modifiedTime ?? '',
        }
      } catch {
        return null
      }
    }),
  )
  return summaries.filter((s): s is CampaignSummary => s !== null)
}

async function mustFind(parentId: string, name: string) {
  const children = await listChildren(parentId)
  const found = children.find((c) => c.name === name)
  if (!found) throw new Error(`Expected file "${name}" not found in folder ${parentId}`)
  return found
}

export interface NewCampaignInput {
  name: string
  genre: string
  difficulty: Difficulty
  houseRules?: string
  /** Prose: world/scenario setup + player expectations. */
  worldPrompt: string
  character: { key: string; value: string }[]
  inventory: { name: string; qty: number; description: string; tags: string }[]
  startingLocation: string
}

export interface CampaignHandle {
  folderId: string
  spreadsheetId: string
}

export async function createCampaign(
  campaignsFolderId: string,
  input: NewCampaignInput,
): Promise<CampaignHandle> {
  const slug = slugify(input.name)
  const folder = await ensureFolder(slug, campaignsFolderId)

  const spreadsheetTitle = `${input.name} — Data`
  const { spreadsheetId } = await createSpreadsheet(
    spreadsheetTitle,
    folder.id,
    SHEET_TABS.map((title) => ({ title, headers: TAB_HEADERS[title] })),
  )

  const meta: CampaignMeta = {
    name: input.name,
    slug,
    genre: input.genre,
    difficulty: input.difficulty,
    createdAt: new Date().toISOString(),
    currentTurn: 0,
    currentLocation: input.startingLocation,
    houseRules: input.houseRules,
  }
  await ensureTextFile(
    folder.id,
    'campaign.md',
    stringifyFrontmatter({ ...meta, spreadsheetId }, input.worldPrompt),
  )
  await ensureTextFile(
    folder.id,
    'settings.md',
    stringifyFrontmatter({ ...DEFAULT_SETTINGS }, ''),
  )

  const storyFolder = await ensureFolder('story', folder.id)
  await ensureFolder('log', storyFolder.id)
  const summaryFolder = await ensureFolder('summary', storyFolder.id)
  await ensureTextFile(summaryFolder.id, 'rolling.md', '_No story yet — this campaign has not started._')

  const characterRows: CharacterRow[] = input.character.filter((r) => r.key.trim())
  if (characterRows.length) {
    await appendRows(spreadsheetId, 'Character', characterRows.map(rowCodecs.Character.toRow))
  }

  const inventoryRows: InventoryItem[] = input.inventory
    .filter((i) => i.name.trim())
    .map((i) => ({
      id: crypto.randomUUID().slice(0, 8),
      name: i.name,
      qty: i.qty,
      description: i.description,
      tags: i.tags,
      acquiredTurn: 0,
      active: true,
    }))
  if (inventoryRows.length) {
    await appendRows(spreadsheetId, 'Inventory', inventoryRows.map(rowCodecs.Inventory.toRow))
  }

  if (input.startingLocation.trim()) {
    const startNode: MapNode = {
      id: crypto.randomUUID().slice(0, 8),
      name: input.startingLocation,
      type: 'location',
      state: 'discovered',
      connectsTo: '',
      description: 'Where the story begins.',
    }
    await appendRows(spreadsheetId, 'Map', [rowCodecs.Map.toRow(startNode)])
  }

  return { folderId: folder.id, spreadsheetId }
}

export async function loadCampaignFile(folderId: string): Promise<CampaignFile & { spreadsheetId: string }> {
  const file = await mustFind(folderId, 'campaign.md')
  const raw = await getTextFile(file.id)
  const { data, body } = parseFrontmatter(raw)
  return {
    meta: {
      name: String(data.name ?? ''),
      slug: String(data.slug ?? ''),
      genre: String(data.genre ?? ''),
      difficulty: (data.difficulty as Difficulty) ?? 'Standard',
      createdAt: String(data.createdAt ?? ''),
      currentTurn: Number(data.currentTurn ?? 0),
      currentLocation: String(data.currentLocation ?? ''),
      houseRules: data.houseRules ? String(data.houseRules) : undefined,
    },
    body,
    spreadsheetId: String(data.spreadsheetId ?? ''),
  }
}

export async function saveCampaignFile(
  folderId: string,
  meta: CampaignMeta & { spreadsheetId: string },
  body: string,
): Promise<void> {
  const file = await mustFind(folderId, 'campaign.md')
  await updateTextFile(file.id, stringifyFrontmatter(meta, body))
}

export async function loadSettings(folderId: string): Promise<CampaignSettings> {
  const file = await mustFind(folderId, 'settings.md')
  const raw = await getTextFile(file.id)
  const { data } = parseFrontmatter(raw)
  return { ...DEFAULT_SETTINGS, ...(data as unknown as Partial<CampaignSettings>) }
}

export async function saveSettings(folderId: string, settings: CampaignSettings): Promise<void> {
  const file = await mustFind(folderId, 'settings.md')
  await updateTextFile(file.id, stringifyFrontmatter(settings, ''))
}

export async function readRollingSummary(folderId: string): Promise<string> {
  const storyFolder = await mustFind(folderId, 'story')
  const summaryFolder = await mustFind(storyFolder.id, 'summary')
  const file = await mustFind(summaryFolder.id, 'rolling.md')
  return getTextFile(file.id)
}

export async function writeRollingSummary(folderId: string, text: string): Promise<void> {
  const storyFolder = await mustFind(folderId, 'story')
  const summaryFolder = await mustFind(storyFolder.id, 'summary')
  const file = await mustFind(summaryFolder.id, 'rolling.md')
  await updateTextFile(file.id, text)
}

/** Full read of every sheet tab in one batch call, decoded into typed rows. */
export async function loadSheetSnapshot(spreadsheetId: string) {
  const raw = await batchGetTabs(spreadsheetId, [...SHEET_TABS])
  return {
    Character: decodeTab<CharacterRow>('Character', raw.Character),
    Inventory: decodeTab<InventoryItem>('Inventory', raw.Inventory),
    Skills: decodeTab<Skill>('Skills', raw.Skills),
    NPCs: decodeTab<Npc>('NPCs', raw.NPCs),
    NPCAttributes: decodeTab<NpcAttribute>('NPCAttributes', raw.NPCAttributes),
    Monsters: decodeTab<Monster>('Monsters', raw.Monsters),
    Timeline: decodeTab<TimelineEvent>('Timeline', raw.Timeline),
    Quests: decodeTab<Quest>('Quests', raw.Quests),
    Map: decodeTab<MapNode>('Map', raw.Map),
    Lore: decodeTab<LoreEntry>('Lore', raw.Lore),
  }
}
