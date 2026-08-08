import { create } from 'zustand'

export interface CampaignHeaderContext {
  campaignId: string
  campaignName: string
  /** Only Play.tsx sets this true (and only when a TTS provider is actually available) — Codex
   * and Settings share the same campaign-title/nav context but never show the toggle. */
  showReadAloudToggle: boolean
  /** "Turn N · <location>" — only Play.tsx sets this (null on Codex/Settings). Shown as a small
   * icon button (a toast on click) instead of as page body text. */
  turnLabel: string | null
  /** A short excerpt of the rolling summary (see src/lib/recap.ts's buildRecapSummary), for the
   * "quick recap" info dialog (issue #24). Only Play.tsx sets this non-null — Codex/Settings have
   * nothing to show it against since their turnLabel is also null, which is what actually gates
   * whether the dialog renders at all (see Header.tsx). */
  recapSummary: string | null
  /** Currently-active (not completed/failed) quests, for the same recap dialog — see
   * src/lib/recap.ts's getActiveQuests. Always [] on Codex/Settings, same reasoning as above. */
  activeQuests: { id: string; title: string }[]
}

interface PlayHeaderState {
  context: CampaignHeaderContext | null
  setContext: (context: CampaignHeaderContext | null) => void
  readAloud: boolean
  toggleReadAloud: () => void
}

/**
 * Lets the persistent top-bar header (src/App.tsx) show campaign-aware navigation (title, Codex
 * link, Settings link, the Read-aloud toggle) even though it's a sibling of the routed page
 * components, not their parent — plain props/React Context can't carry state between siblings.
 * Play/Codex/Settings each register their own context on mount and clear it on unmount, so the
 * header only shows campaign chrome while one of those three is actually the active route.
 */
export const usePlayHeaderStore = create<PlayHeaderState>((set) => ({
  context: null,
  setContext: (context) => set({ context }),
  readAloud: false,
  toggleReadAloud: () => set((s) => ({ readAloud: !s.readAloud })),
}))
