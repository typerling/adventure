import type { SttProvider as SttProviderKind, TtsProvider as TtsProviderKind } from '@/types/campaign'
import type { SttProvider, TtsProvider } from './types'
import { createBrowserSttProvider, isBrowserSttSupported } from './browserStt'
import { createBrowserTtsProvider, isBrowserTtsSupported } from './browserTts'
import { createElevenLabsSttProvider, isElevenLabsSttSupported } from './elevenLabsStt'
import { createElevenLabsTtsProvider } from './elevenLabsTts'
import { createKokoroTtsProvider, type KokoroLoadProgress } from './kokoroTts'

/** Whether the chosen STT provider can run in this browser at all — independent of whether an
 * API key has been entered (that's checked, and surfaced as an error, when actually used). */
export function isSttProviderAvailable(kind: SttProviderKind): boolean {
  if (kind === 'browser') return isBrowserSttSupported()
  if (kind === 'elevenlabs') return isElevenLabsSttSupported()
  return false
}

/** Same as isSttProviderAvailable, for TTS. ElevenLabs TTS only needs fetch + <audio>, both
 * universally available, so it's never gated here. Kokoro runs via WASM (no WebGPU requirement),
 * so it's not gated either — a genuine load/generation failure surfaces at speak() time instead. */
export function isTtsProviderAvailable(kind: TtsProviderKind): boolean {
  if (kind === 'browser') return isBrowserTtsSupported()
  if (kind === 'elevenlabs') return true
  if (kind === 'huggingface-local') return true
  return false
}

/** Resolves a campaign's chosen STT provider to a working implementation, or null if it isn't
 * implemented yet (huggingface-local has no STT at all) or isn't supported by this browser. */
export function getSttProvider(kind: SttProviderKind): SttProvider | null {
  if (kind === 'browser') return isBrowserSttSupported() ? createBrowserSttProvider() : null
  if (kind === 'elevenlabs') return isElevenLabsSttSupported() ? createElevenLabsSttProvider() : null
  return null
}

export interface GetTtsProviderOptions {
  /** Only Kokoro reports load progress — it's the one TTS provider that downloads a model. The
   * other two either use a built-in browser voice or a remote API, so nothing to report. */
  onKokoroLoadProgress?: (p: KokoroLoadProgress) => void
}

/** Same as getSttProvider, for TTS. */
export function getTtsProvider(kind: TtsProviderKind, opts: GetTtsProviderOptions = {}): TtsProvider | null {
  if (kind === 'browser') return isBrowserTtsSupported() ? createBrowserTtsProvider() : null
  if (kind === 'elevenlabs') return createElevenLabsTtsProvider()
  if (kind === 'huggingface-local') {
    return createKokoroTtsProvider({ onLoadProgress: opts.onKokoroLoadProgress })
  }
  return null
}
