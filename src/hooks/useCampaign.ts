import { useCallback, useEffect, useState } from 'react'
import {
  loadCampaignFile,
  loadSettings,
  loadSheetSnapshot,
  readRollingSummary,
  saveCampaignFile,
  setNpcVoiceOverride,
  stripRollingSummaryPlaceholder,
  writeRollingSummary,
} from '@/lib/google/campaignRepo'
import { appendTurnToLog, readRecentTurns } from '@/lib/google/storyLog'
import { applyStateDelta } from '@/lib/google/applyDelta'
import { getNpcDetailContent } from '@/lib/google/npcDetailFile'
import { buildTurnPrompt, findMentionedNpcs, type NpcDetailLookup, type SheetSnapshot } from '@/lib/ai/promptBuilder'
import { parseTurnReply } from '@/lib/ai/parseReply'
import { validateStateDelta } from '@/lib/ai/validate'
import { getGlobalSettings } from '@/lib/settings/globalSettings'
import { getCachedCampaign, setCachedCampaign, type CachedCampaignData } from './campaignCache'
import type { CampaignFile, CampaignSettings } from '@/types/campaign'
import type { TurnOption, TurnRecord, ValidationIssue } from '@/types/turn'

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
  // `options` carries the just-parsed turn's full {label, manus?} shape — richer than what
  // `recentTurns`/`TurnRecord.optionsOffered` retains (plain labels only, see the two call sites
  // below), so a caller that wants manus-accurate speech for the turn it just applied has to
  // capture it from here; by the next render, only the label survives. `turn` identifies which
  // turn these options belong to, so a caller can tell a fresh result apart from a stale one.
  | { ok: true; turn: number; options: TurnOption[] }
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
    async (playerAction: string): Promise<string | null> => {
      if (!data.campaign || !data.snapshot || !folderId) return null

      // Only pull a detail-file's content into the prompt when the player's action actually
      // names that NPC (see findMentionedNpcs) — cheap for the common case (no match, no Drive
      // read at all), and best-effort: a missing/unreadable file shouldn't block the turn.
      const mentioned = findMentionedNpcs(data.snapshot.NPCs, playerAction)
      const npcDetails: NpcDetailLookup = {}
      await Promise.all(
        mentioned.map(async (npc) => {
          try {
            npcDetails[npc.name] = await getNpcDetailContent(folderId, npc.detailFile!)
          } catch {
            // Best-effort — leave this NPC out of npcDetails rather than failing the whole turn.
          }
        }),
      )

      return buildTurnPrompt({
        campaign: data.campaign,
        snapshot: data.snapshot,
        rollingSummary: data.rollingSummary,
        recentTurns: data.recentTurns,
        playerAction,
        turnNumber: data.campaign.meta.currentTurn + 1,
        npcDetails,
        // Issue #98: the narrator's voice is device-global (GlobalSettings, #77), the player's is
        // per-campaign (CampaignSettings.playerVoiceId, this ticket) — see that field's doc
        // comment for why. Read fresh each call rather than cached in state since Settings can
        // change either between turns without this hook re-mounting.
        narratorVoiceId: getGlobalSettings().kokoroVoiceId,
        playerVoiceId: data.settings?.playerVoiceId,
      })
    },
    [data, folderId],
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
        await applyStateDelta(
          data.spreadsheetId,
          parsed.reply.state_delta,
          snapshotCopy,
          nextTurn,
          folderId,
          parsed.reply.narrative,
          {
            narratorVoiceId: getGlobalSettings().kokoroVoiceId,
            playerVoiceId: data.settings?.playerVoiceId,
          },
        )

        await appendTurnToLog(folderId, {
          turn: nextTurn,
          timestamp: new Date().toISOString(),
          playerAction,
          narrative: parsed.reply.narrative,
          // story/log/*.md keeps storing plain option label strings — the richer {label, manus}
          // shape is a live/in-memory-only concept (see ParsedTurnReply), not a persisted one.
          optionsOffered: parsed.reply.options.map((o) => o.label),
        })

        // Strip a leading placeholder (see stripRollingSummaryPlaceholder's doc comment) before
        // appending, rather than always appending onto whatever's already there — otherwise
        // "_No story yet..._" stays a permanent leading prefix on every campaign's rolling
        // summary forever (issue #70). This both starts a brand-new campaign's summary fresh on
        // its first real update, and self-heals a campaign whose stored rolling.md already
        // carries the placeholder from before this fix (issue #70's backward-compatibility case)
        // the next time it submits a turn.
        const nextSummary = parsed.reply.summary_update
          ? `${stripRollingSummaryPlaceholder(data.rollingSummary)} ${parsed.reply.summary_update}`.trim()
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
            optionsOffered: parsed.reply.options.map((o) => o.label),
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

        return { ok: true, turn: nextTurn, options: parsed.reply.options }
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

  // The Codex's player-facing NPC voice override (issue #100) — see setNpcVoiceOverride's own
  // doc comment for why this is a small dedicated write rather than a submitReply-shaped flow.
  // Reconciles the in-memory snapshot (and campaignCache) with the *actual* written row only
  // after the write confirms, per CLAUDE.md's "cache with optimistic writes reconciled against
  // API responses" pattern — nothing here renders a change ahead of the write landing, so a
  // failed write simply leaves the snapshot (and therefore whatever UI reads it) exactly as it
  // was; there's no separate "revert" step because nothing was changed ahead of confirmation.
  const setNpcVoice = useCallback(
    async (npcId: string, voiceId: string | null) => {
      if (!folderId || !data.snapshot) throw new Error('Campaign not loaded yet.')
      const merged = await setNpcVoiceOverride(data.spreadsheetId, data.snapshot.NPCs, npcId, voiceId)
      setData((d) => {
        if (!d.snapshot) return d
        const nextSnapshot = {
          ...d.snapshot,
          NPCs: d.snapshot.NPCs.map((n) => (n.id === npcId ? merged : n)),
        }
        if (d.settings && d.campaign) {
          setCachedCampaign(folderId, {
            campaign: d.campaign,
            spreadsheetId: d.spreadsheetId,
            settings: d.settings,
            snapshot: nextSnapshot,
            rollingSummary: d.rollingSummary,
            recentTurns: d.recentTurns,
          })
        }
        return { ...d, snapshot: nextSnapshot }
      })
      return merged
    },
    [folderId, data],
  )

  return { ...data, refresh, buildPromptForAction, submitReply, setNpcVoice }
}
