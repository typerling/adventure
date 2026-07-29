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

export function useCampaign(folderId: string | undefined) {
  const [data, setData] = useState<CampaignData>({
    status: 'loading',
    errorMessage: null,
    campaign: null,
    spreadsheetId: '',
    settings: null,
    snapshot: null,
    rollingSummary: '',
    recentTurns: [],
  })

  const refresh = useCallback(async () => {
    if (!folderId) return
    setData((d) => ({ ...d, status: 'loading', errorMessage: null }))
    try {
      const campaignFile = await loadCampaignFile(folderId)
      const [settings, snapshot, rollingSummary, recentTurns] = await Promise.all([
        loadSettings(folderId),
        loadSheetSnapshot(campaignFile.spreadsheetId),
        readRollingSummary(folderId),
        readRecentTurns(folderId, campaignFile.meta.currentTurn),
      ])
      setData({
        status: 'ready',
        errorMessage: null,
        campaign: { meta: campaignFile.meta, body: campaignFile.body },
        spreadsheetId: campaignFile.spreadsheetId,
        settings,
        snapshot,
        rollingSummary,
        recentTurns,
      })
    } catch (err) {
      setData((d) => ({
        ...d,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [folderId])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

      setData((d) => ({
        ...d,
        campaign: d.campaign ? { ...d.campaign, meta: nextMeta } : d.campaign,
        snapshot: snapshotCopy,
        rollingSummary: nextSummary,
        recentTurns: [
          ...d.recentTurns,
          {
            turn: nextTurn,
            timestamp: new Date().toISOString(),
            playerAction,
            narrative: parsed.reply.narrative,
            optionsOffered: parsed.reply.options,
          },
        ].slice(-6),
      }))

      return { ok: true }
    },
    [folderId, data],
  )

  return { ...data, refresh, buildPromptForAction, submitReply }
}
