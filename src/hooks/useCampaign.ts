import { useCallback, useEffect, useState } from 'react'
import {
  loadCampaignFile,
  loadSettings,
  loadSheetSnapshot,
  readRollingSummary,
  saveCampaignFile,
  writeRollingSummary,
} from '@/lib/google/campaignRepo'
import { appendTurnToLog, readRecentTurns } from '@/lib/google/storyLog'
import { applyStateDelta } from '@/lib/google/applyDelta'
import { buildTurnPrompt, type SheetSnapshot } from '@/lib/ai/promptBuilder'
import { parseTurnReply } from '@/lib/ai/parseReply'
import { validateStateDelta } from '@/lib/ai/validate'
import { getCachedCampaign, setCachedCampaign, type CachedCampaignData } from './campaignCache'
import type { CampaignFile, CampaignSettings } from '@/types/campaign'
import type { TurnRecord, ValidationIssue } from '@/types/turn'

interface CampaignData {
  status: 'loading' | 'ready' | 'error'
  errorMessage: string | null
  campaign: CampaignFile | null
  spreadsheetId: string
  settings: CampaignSettings | null
  snapshot: SheetSnapshot | null
  rollingSummary: string
  recentTurns: TurnRecord[]
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; issues: ValidationIssue[] }

// React StrictMode double-invokes mount effects in dev, so the very first visit to a campaign
// (before campaignCache has anything to short-circuit on) fires refresh() twice concurrently —
// same race libraryStore.ts's load() already guards against. Track in-flight refreshes per
// folder so the second call reuses the first's promise instead of issuing a duplicate
// Drive/Sheets read.
const inFlightRefreshes = new Map<string, Promise<void>>()

export function useCampaign(folderId: string | undefined) {
  const [data, setData] = useState<CampaignData>(() => {
    const cached = folderId ? getCachedCampaign(folderId) : undefined
    return cached
      ? { status: 'ready', errorMessage: null, ...cached }
      : {
          status: 'loading',
          errorMessage: null,
          campaign: null,
          spreadsheetId: '',
          settings: null,
          snapshot: null,
          rollingSummary: '',
          recentTurns: [],
        }
  })

  const refresh = useCallback(async () => {
    if (!folderId) return
    const existing = inFlightRefreshes.get(folderId)
    if (existing) return existing

    const promise = (async () => {
      setData((d) => ({ ...d, status: 'loading', errorMessage: null }))
      try {
        const campaignFile = await loadCampaignFile(folderId)
        const [settings, snapshot, rollingSummary, recentTurns] = await Promise.all([
          loadSettings(folderId),
          loadSheetSnapshot(campaignFile.spreadsheetId),
          readRollingSummary(folderId),
          readRecentTurns(folderId, campaignFile.meta.currentTurn),
        ])
        const next: CachedCampaignData = {
          campaign: { meta: campaignFile.meta, body: campaignFile.body },
          spreadsheetId: campaignFile.spreadsheetId,
          settings,
          snapshot,
          rollingSummary,
          recentTurns,
        }
        setCachedCampaign(folderId, next)
        setData({ status: 'ready', errorMessage: null, ...next })
      } catch (err) {
        setData((d) => ({
          ...d,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        }))
      }
    })()

    inFlightRefreshes.set(folderId, promise)
    try {
      await promise
    } finally {
      inFlightRefreshes.delete(folderId)
    }
  }, [folderId])

  // Re-checks the cache (not just on first mount) so switching folderId without a full remount —
  // e.g. a component instance reused across two different campaign IDs — still picks up whichever
  // campaign is now selected, from cache if we already have it this session.
  useEffect(() => {
    if (!folderId) return
    const cached = getCachedCampaign(folderId)
    if (cached) {
      setData({ status: 'ready', errorMessage: null, ...cached })
      return
    }
    void refresh()
  }, [folderId, refresh])

  const buildPromptForAction = useCallback(
    (playerAction: string): string | null => {
      if (!data.campaign || !data.snapshot) return null
      return buildTurnPrompt({
        campaign: data.campaign,
        snapshot: data.snapshot,
        rollingSummary: data.rollingSummary,
        recentTurns: data.recentTurns,
        playerAction,
        turnNumber: data.campaign.meta.currentTurn + 1,
      })
    },
    [data],
  )

  const submitReply = useCallback(
    async (playerAction: string, rawReply: string): Promise<SubmitOutcome> => {
      if (!folderId || !data.campaign || !data.snapshot) {
        return { ok: false, error: 'Campaign not loaded yet.' }
      }

      const parsed = parseTurnReply(rawReply)
      if (!parsed.ok) return { ok: false, error: parsed.error }

      const validation = validateStateDelta(parsed.reply.state_delta, data.snapshot)
      if (!validation.ok) return { ok: false, issues: validation.issues }

      const nextTurn = data.campaign.meta.currentTurn + 1
      const snapshotCopy: SheetSnapshot = structuredClone(data.snapshot)

      try {
        await applyStateDelta(data.spreadsheetId, parsed.reply.state_delta, snapshotCopy, nextTurn)

        await appendTurnToLog(folderId, {
          turn: nextTurn,
          timestamp: new Date().toISOString(),
          playerAction,
          narrative: parsed.reply.narrative,
          optionsOffered: parsed.reply.options,
        })

        const nextSummary = parsed.reply.summary_update
          ? `${data.rollingSummary.trim()} ${parsed.reply.summary_update}`.trim()
          : data.rollingSummary
        if (parsed.reply.summary_update) {
          await writeRollingSummary(folderId, nextSummary)
        }

        const introducedLocation = parsed.reply.state_delta.new_locations?.at(-1)?.name
        const nextMeta = {
          ...data.campaign.meta,
          currentTurn: nextTurn,
          currentLocation: introducedLocation ?? data.campaign.meta.currentLocation,
        }
        await saveCampaignFile(folderId, { ...nextMeta, spreadsheetId: data.spreadsheetId }, data.campaign.body)

        const nextCampaign = { ...data.campaign, meta: nextMeta }
        const nextRecentTurns = [
          ...data.recentTurns,
          {
            turn: nextTurn,
            timestamp: new Date().toISOString(),
            playerAction,
            narrative: parsed.reply.narrative,
            optionsOffered: parsed.reply.options,
          },
        ].slice(-6)

        // Keep the cache in sync with this write so navigating away and back doesn't show the
        // pre-turn state (or force a refetch just to catch up on what we already know locally).
        if (data.settings) {
          setCachedCampaign(folderId, {
            campaign: nextCampaign,
            spreadsheetId: data.spreadsheetId,
            settings: data.settings,
            snapshot: snapshotCopy,
            rollingSummary: nextSummary,
            recentTurns: nextRecentTurns,
          })
        }

        setData((d) => ({
          ...d,
          campaign: nextCampaign,
          snapshot: snapshotCopy,
          rollingSummary: nextSummary,
          recentTurns: nextRecentTurns,
        }))

        return { ok: true }
      } catch (err) {
        // Writes above are sequential and not transactional — an error partway through can
        // mean some of them already landed on Drive/Sheets while local state never updates.
        // Re-sync from the source of truth instead of leaving the UI silently stale.
        void refresh()
        const message = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          error: `Couldn't finish saving this turn — reloaded the latest saved state to be safe. ${message}`,
        }
      }
    },
    [folderId, data, refresh],
  )

  return { ...data, refresh, buildPromptForAction, submitReply }
}
