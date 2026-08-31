import type { SttProvider as SttProviderKind, TtsProvider as TtsProviderKind } from '@/types/campaign'
import type { SttProvider, TtsProvider } from './types'
import { createBrowserSttProvider, isBrowserSttSupported } from './browserStt'
import { createBrowserTtsProvider, isBrowserTtsSupported } from './browserTts'
import { createKokoroTtsProvider, type KokoroLoadProgress } from './kokoroTts'

/** Whether the chosen STT provider can run in this browser at all. */
export function isSttProviderAvailable(kind: SttProviderKind): boolean {
  if (kind === 'browser') return isBrowserSttSupported()
  return false
}

/** Same as isSttProviderAvailable, for TTS. Kokoro runs via WASM (no WebGPU requirement), so
 * it's not gated either — a genuine load/generation failure surfaces at speak() time instead. */
export function isTtsProviderAvailable(kind: TtsProviderKind): boolean {
  if (kind === 'browser') return isBrowserTtsSupported()
  if (kind === 'huggingface-local') return true
  return false
}

/** Resolves a campaign's chosen STT provider to a working implementation, or null if it isn't
 * supported by this browser. */
export function getSttProvider(kind: SttProviderKind): SttProvider | null {
  if (kind === 'browser') return isBrowserSttSupported() ? createBrowserSttProvider() : null
  return null
}

export interface GetTtsProviderOptions {
  /** Only Kokoro reports load progress — it's the one TTS provider that downloads a model. The
   * browser's built-in synthesis has no equivalent wait. */
  onKokoroLoadProgress?: (p: KokoroLoadProgress) => void
  /** Only Kokoro reports generation progress — it's the one TTS provider whose speak() now waits
   * for a whole turn's audio to finish generating before playback can start (issue #44). The
   * browser's built-in synthesis has no equivalent wait. */
  onKokoroGenerateProgress?: (completed: number, total: number) => void
  /** Only Kokoro prefetches per-voice files ahead of generation (issue #66) — see kokoroTts.ts's
   * "Voice-file prefetch and 'falling behind'" doc comment. */
  onKokoroVoicePrefetchProgress?: (completed: number, total: number) => void
}

/** Same as getSttProvider, for TTS. */
export function getTtsProvider(kind: TtsProviderKind, opts: GetTtsProviderOptions = {}): TtsProvider | null {
  if (kind === 'browser') return isBrowserTtsSupported() ? createBrowserTtsProvider() : null
  if (kind === 'huggingface-local') {
    return createKokoroTtsProvider({
      onLoadProgress: opts.onKokoroLoadProgress,
      onGenerateProgress: opts.onKokoroGenerateProgress,
      onVoicePrefetchProgress: opts.onKokoroVoicePrefetchProgress,
    })
  }
  return null
}
