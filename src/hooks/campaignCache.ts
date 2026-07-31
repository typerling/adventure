import type { CampaignFile, CampaignSettings } from '@/types/campaign'
import type { SheetSnapshot } from '@/lib/ai/promptBuilder'
import type { TurnRecord } from '@/types/turn'

export interface CachedCampaignData {
  campaign: CampaignFile
  spreadsheetId: string
  settings: CampaignSettings
  snapshot: SheetSnapshot
  rollingSummary: string
  recentTurns: TurnRecord[]
}

/**
 * In-memory, per-page-session cache of everything a campaign's Play/Codex/Settings screens read
 * from Drive/Sheets, keyed by folder ID. React Router remounts these screens on every visit, so
 * without this, navigating Play -> Codex -> Settings -> back to Play re-fetched the campaign
 * file, sheet snapshot, rolling summary, and turn log from Drive/Sheets every single time.
 * Cleared only by a full page reload (a fresh module load) — Drive/Sheets stay the source of
 * truth there. Within a session, writes (useCampaign's submitReply, Settings' save) patch this
 * cache directly instead of invalidating it, so it never goes stale during normal use.
 */
const cache = new Map<string, CachedCampaignData>()

export function getCachedCampaign(folderId: string): CachedCampaignData | undefined {
  return cache.get(folderId)
}

export function setCachedCampaign(folderId: string, data: CachedCampaignData): void {
  cache.set(folderId, data)
}

/** Settings.tsx reads/writes settings without loading the rest of a campaign's data (loading a
 * sheet snapshot and turn log just to show the settings form would be wasteful) — this patches
 * just the settings field of an already-cached entry, if one exists from a Play/Codex visit. */
export function patchCachedCampaignSettings(folderId: string, settings: CampaignSettings): void {
  const existing = cache.get(folderId)
  if (existing) cache.set(folderId, { ...existing, settings })
}
