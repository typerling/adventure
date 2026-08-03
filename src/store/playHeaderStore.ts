import { create } from 'zustand'
import type { TtsPlaybackState } from '@/hooks/useTtsPlayback'

export interface CampaignHeaderContext {
  campaignId: string
  campaignName: string
  /** "Turn N · <location>" — only Play.tsx sets this (null on Codex/Settings). Shown as a small
   * icon button (a dialog on click) instead of as page body text. */
  turnLabel: string | null
}

export interface TtsHeaderControl {
  status: TtsPlaybackState
  /** idle → play the latest turn; playing → pause; paused → resume; loading → the header button
   * disables itself, so this is never called in that state. */
  toggle: () => void
}

interface PlayHeaderState {
  context: CampaignHeaderContext | null
  setContext: (context: CampaignHeaderContext | null) => void
  /** The header's single master play/pause control — only Play.tsx sets this (and only while a
   * TTS provider is actually available), null otherwise, which is what hides the button. */
  ttsControl: TtsHeaderControl | null
  setTtsControl: (control: TtsHeaderControl | null) => void
}

/**
 * Lets the persistent top-bar header (src/App.tsx) show campaign-aware navigation (title, Codex
 * link, the TTS master play/pause control) even though it's a sibling of the routed page
 * components, not their parent — plain props/React Context can't carry state between siblings.
 * Play/Codex each register their own context on mount and clear it on unmount, so the header only
 * shows campaign chrome while one of those is actually the active route. The global Settings link
 * doesn't need any of this — it's the same `/settings` link everywhere (see App.tsx).
 */
export const usePlayHeaderStore = create<PlayHeaderState>((set) => ({
  context: null,
  setContext: (context) => set({ context }),
  ttsControl: null,
  setTtsControl: (ttsControl) => set({ ttsControl }),
}))
