import type { TtsProvider } from './types'
import {
  createProgressAggregator,
  describeModelDownloadProgress,
  requestPersistentStorage,
  type ModelDownloadProgress,
} from '@/lib/modelDownloadProgress'

/**
 * Kokoro (kokoro-js) — a small, high-quality on-device TTS model, replacing the noticeably
 * robotic default browser SpeechSynthesis voices. No key, no server; runs fully in-browser via
 * WASM (broadly compatible — unlike the local Gemma text model, this doesn't need WebGPU, so
 * there's no hard support gate the way isLocalModelSupported() has for that).
 *
 * `kokoro-js` is dynamically imported (only when this TTS provider is actually used) — it bundles
 * its own copy of @huggingface/transformers and a full ONNX runtime, too heavy for the main app
 * bundle.
 *
 * Caching caveat: kokoro-js depends on @huggingface/transformers v3, a different major version
 * than this app's own v4, so npm keeps them as two separate installs with two separate `env`
 * objects. That means the IndexedDB cache + resumable fetch we install on *our* env
 * (src/lib/ai/localModel.ts) does not apply here, and kokoro-js exposes only `wasmPaths` from its
 * copy's env — not `customCache` — so it can't be redirected without a fragile deep import into
 * its nested node_modules. Kokoro therefore uses its transformers copy's default Cache Storage
 * caching, which needs a secure context: over HTTPS/localhost the download is cached normally,
 * but on a plain-HTTP LAN address `caches` is absent, `useBrowserCache` computes to false, and it
 * re-downloads per page load rather than failing (verified against the installed v3.8.1 source).
 */

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
/** Exported so Settings can mark this voice as the fallback in the picker without duplicating the
 * literal, and so createKokoroTtsProvider's own fallback (below) stays the single source of truth. */
export const DEFAULT_VOICE = 'af_heart'
const PROGRESS_LABEL = 'voice model'
/** Fixed phrase for Settings' per-voice preview button — short enough to generate quickly, long
 * enough to actually hear the voice's character. */
const PREVIEW_TEXT = 'Hello, this is a preview of my voice.'

/**
 * Safety net for a single sentence long enough to still blow the model's token budget on its own
 * (see splitIntoSpeakableChunks). Kokoro's context is 512 tokens — 510 usable phoneme tokens plus
 * two specials, which is what the hardcoded `509` style-vector cap in its `generate_from_ids`
 * reflects. Phoneme count per character varies, and truncation past that point is *silent*, so
 * this budget is deliberately well under the ~470 English characters measured to hit the limit.
 */
const MAX_CHUNK_CHARS = 320

/** Cache Storage buckets kokoro-js and its bundled transformers write into — cleared together by
 * removeKokoroModel(). 'kokoro-voices' is kokoro's own hardcoded per-voice cache; the other is
 * its transformers copy's default model cache (env.cacheKey). */
const CACHE_NAMES = ['kokoro-voices', 'transformers-cache']

export type KokoroLoadProgress = ModelDownloadProgress

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadPromise: Promise<any> | null = null
let isReady = false
// See localModel.ts's identical pattern for why this exists: a load is a module-level singleton
// that can outlive the component that started it, so a newly (re-)attached listener needs the
// latest known state replayed immediately rather than sitting blank until the next real update.
let lastProgress: KokoroLoadProgress | null = null
const progressListeners = new Set<(p: KokoroLoadProgress) => void>()

function broadcastProgress(p: KokoroLoadProgress): void {
  lastProgress = p
  for (const listener of progressListeners) listener(p)
}

/** Lets Settings show whether the voice model still needs downloading, without triggering it. */
export function getKokoroLoadState(): 'unloaded' | 'loading' | 'ready' {
  if (isReady) return 'ready'
  return loadPromise ? 'loading' : 'unloaded'
}

function loadKokoro(onProgress?: (p: KokoroLoadProgress) => void) {
  if (onProgress) {
    progressListeners.add(onProgress)
    if (lastProgress) onProgress(lastProgress)
  }
  if (!loadPromise) {
    requestPersistentStorage()
    loadPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js')
      // KokoroTTS.from_pretrained() internally makes two concurrent from_pretrained() calls (model
      // weights + tokenizer) sharing one progress_callback, so the same per-file-progress-resets
      // problem localModel.ts has applies here — see createProgressAggregator's doc comment.
      return KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: createProgressAggregator(broadcastProgress),
      })
    })()
    loadPromise.then(
      () => {
        isReady = true
        progressListeners.clear()
      },
      // Don't cache a failed load — let the next attempt retry cleanly.
      () => {
        loadPromise = null
        isReady = false
        lastProgress = null
        progressListeners.clear()
      },
    )
  }
  return loadPromise
}

/** Downloads and initializes the voice model ahead of time (e.g. from Settings), so the first
 * spoken turn doesn't have to wait on it. Safe to call repeatedly — a load already in flight or
 * done is reused, same as the provider's own use of loadKokoro. */
export async function preloadKokoroModel(onProgress?: (p: KokoroLoadProgress) => void): Promise<void> {
  await loadKokoro(onProgress)
}

/** Whether the model's files are already cached, regardless of whether this page session has
 * loaded them into memory yet — so Settings shows accurate "downloaded" state on a fresh load.
 * Returns false where Cache Storage is unavailable (plain HTTP), which is accurate: nothing is
 * cached there, see the caching caveat above. */
export async function hasDownloadedKokoroModel(): Promise<boolean> {
  if (isReady) return true
  if (typeof caches === 'undefined') return false
  try {
    const cache = await caches.open('transformers-cache')
    const entries = await cache.keys()
    return entries.some((request) => request.url.includes('Kokoro'))
  } catch {
    return false
  }
}

/** Removes the downloaded voice model from this device, and resets in-memory state so the next
 * use re-downloads from scratch rather than reusing a stale reference. */
export async function removeKokoroModel(): Promise<void> {
  if (typeof caches !== 'undefined') {
    await Promise.all(
      CACHE_NAMES.map(async (name) => {
        try {
          const cache = await caches.open(name)
          const entries = await cache.keys()
          // Only drop this model's own entries — 'transformers-cache' is shared with anything else
          // using the same default cache key, so deleting the whole bucket would overreach.
          await Promise.all(
            entries
              .filter((request) => request.url.includes('Kokoro') || request.url.includes('/voices/'))
              .map((request) => cache.delete(request)),
          )
        } catch {
          // Cache unavailable (plain HTTP, storage disabled) — nothing was cached to remove.
        }
      }),
    )
  }
  loadPromise = null
  isReady = false
}

/** Shared with Settings' manual "download now" button so both places describe load progress
 * (and eventual failures) the same way. */
export function describeKokoroProgress(p: KokoroLoadProgress): string {
  return describeModelDownloadProgress(p, PROGRESS_LABEL)
}

/** One entry from the loaded model's own voice catalog (`tts.voices`) — kokoro-js's per-voice
 * metadata varies by voice (e.g. `traits` is only present on some), so everything but the id/name/
 * language/gender is optional here rather than assumed. */
export interface KokoroVoice {
  id: string
  name: string
  language: string
  gender: string
  traits?: string
}

/**
 * Lists the voices the model actually ships with, read from the loaded model's own `voices`
 * getter rather than a hardcoded catalog here — kokoro-js bundles that catalog as a plain object
 * (not exported from the package on its own), so getting at it means going through a real
 * `KokoroTTS` instance, and `KokoroTTS.from_pretrained()` only returns once loading finishes.
 * Concretely: this triggers the same load-or-reuse path speak() already uses (loadKokoro), so
 * calling it for the first time in a session downloads the model — Settings surfaces that via
 * `onProgress`, the same progress plumbing/format as the "download voice model now" card.
 */
export async function listKokoroVoices(onProgress?: (p: KokoroLoadProgress) => void): Promise<KokoroVoice[]> {
  const tts = await loadKokoro(onProgress)
  return Object.entries(tts.voices).map(([id, voice]) => {
    const v = voice as { name: string; language: string; gender: string; traits?: string }
    return { id, name: v.name, language: v.language, gender: v.gender, traits: v.traits }
  })
}

/**
 * Generates a short, fixed preview clip for one voice — used by Settings' per-voice preview
 * button. Loads the model first if it isn't already resident (same load-or-reuse path as speak()/
 * listKokoroVoices, so a model already loaded to populate the voice list is reused rather than
 * loaded twice). An unrecognized voice id falls back to DEFAULT_VOICE, same as speak() does.
 */
export async function generateKokoroPreview(
  voiceId: string,
  onProgress?: (p: KokoroLoadProgress) => void,
): Promise<Blob> {
  const tts = await loadKokoro(onProgress)
  const voice = voiceId in tts.voices ? voiceId : DEFAULT_VOICE
  const audio = await tts.generate(PREVIEW_TEXT, { voice })
  return audio.toBlob()
}

/** Splits one long sentence on word boundaries when it alone would exceed the token budget. */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_CHARS) return [sentence]
  const parts: string[] = []
  let current = ''
  for (const word of sentence.split(/\s+/)) {
    // A single "word" longer than the budget can't be split any further without mangling it —
    // emit it alone and accept that one pathological case rather than slicing mid-word.
    if (current && `${current} ${word}`.length > MAX_CHUNK_CHARS) {
      parts.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) parts.push(current)
  return parts
}

/**
 * Breaks narration into per-sentence chunks small enough for Kokoro to speak in full.
 *
 * This exists because `KokoroTTS.generate()` tokenizes with `truncation: true` against a 512-token
 * context, so anything longer is **silently cut off mid-sentence** with no error — a whole turn's
 * narrative reliably trips this (measured: audio stopped ~470 characters into a 687-character
 * turn). Splitting first and generating per chunk is the fix.
 *
 * Uses kokoro-js's own `TextSplitterStream` for the sentence boundaries (it handles abbreviations,
 * decimals, quotes and brackets), driven synchronously: `push()` then spreading runs its internal
 * `flush()`, so the trailing partial sentence is included. Note this deliberately does *not* use
 * `KokoroTTS.stream()`, which builds a `TextSplitterStream` internally but never `close()`s it —
 * its async iterator would then block forever waiting for input that never comes.
 *
 * Exported for tests: this runs with no model download, so the splitting is verifiable on its own.
 */
export async function splitIntoSpeakableChunks(text: string): Promise<string[]> {
  const { TextSplitterStream } = await import('kokoro-js')
  const splitter = new TextSplitterStream()
  splitter.push(text)
  return [...splitter].flatMap(splitLongSentence).filter((chunk) => chunk.trim().length > 0)
}

export interface KokoroTtsOptions {
  /** Called while the model downloads/initializes — only ever fires on the first speak() of a
   * session (or after removeKokoroModel()), since the loaded model is reused after that. */
  onLoadProgress?: (p: KokoroLoadProgress) => void
}

export function createKokoroTtsProvider(opts: KokoroTtsOptions = {}): TtsProvider {
  let currentAudio: HTMLAudioElement | null = null
  /** Bumped by stop() and by each new speak(), so an in-flight chunk sequence can tell it's been
   * superseded and bail out instead of continuing to play over whatever replaced it. */
  let playToken = 0
  /** Settles the in-flight clip when stop() interrupts it. `pause()` fires neither 'ended' nor
   * 'error', so without this the promise never settles: the blob URL is never revoked, the chunk
   * loop never reaches its isStale() check, and its lookahead-rejection guards never run. */
  let settleCurrent: (() => void) | null = null

  function playBlob(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    return new Promise<void>((resolve, reject) => {
      settleCurrent = resolve
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('Audio playback failed.'))
      audio.play().catch(reject)
    }).finally(() => {
      settleCurrent = null
      URL.revokeObjectURL(url)
      if (currentAudio === audio) currentAudio = null
    })
  }

  return {
    async speak(text, speakOpts) {
      const token = ++playToken
      const isStale = () => token !== playToken
      currentAudio?.pause()
      currentAudio = null

      const tts = await loadKokoro(opts.onLoadProgress)
      if (isStale()) return
      const voice = speakOpts?.voice && speakOpts.voice in tts.voices ? speakOpts.voice : DEFAULT_VOICE

      // See splitIntoSpeakableChunks — generating the whole narrative in one call would silently
      // truncate it at the model's 512-token context.
      const chunks = await splitIntoSpeakableChunks(text)
      if (isStale()) return

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generate = (chunk: string): Promise<any> => tts.generate(chunk, { voice })

      // Generate one chunk ahead of playback so the next clip is usually ready the moment the
      // current one ends — otherwise every sentence boundary would stall for a full generation.
      //
      // Backgrounding note (see #39): unlike ElevenLabs' one-continuous-file-per-turn playback,
      // this generate-ahead-then-play loop depends on real work continuing to run on *this* main
      // thread between chunks — `tts.generate()` is WASM inference, not delegated to a Worker the
      // way the local text models are (see localModel.worker.ts). A currently-*playing* `<audio>`
      // clip is exempted from Chrome's background-tab throttling (that's exactly why ElevenLabs/
      // Kokoro survive backgrounding better than raw SpeechSynthesis at all — see mediaSession.ts's
      // doc comment and the Settings note next to Browser TTS), but the *next* chunk's generation
      // is ordinary main-thread JS/WASM work, which is a plausible target for whatever CPU/timer
      // deprioritization a backgrounded renderer gets. That could show up as a real gap: the
      // current clip finishes, but the next one isn't ready yet, so playback stalls mid-turn
      // instead of erroring. This is a *suspected* gap, not a confirmed one — verifying it needs a
      // real Android device (measuring generate() latency foreground vs. backgrounded), which
      // wasn't available in the environment that wrote this comment. If it does turn out to be
      // real, the fix is almost certainly moving `tts.generate()` into a Worker (mirroring
      // localModel.worker.ts) so its progress isn't tied to main-thread scheduling at all — not
      // pre-generating further ahead, which only shifts the problem and costs more memory/latency
      // up front.
      let upcoming = chunks.length > 0 ? generate(chunks[0]) : null
      for (let i = 0; i < chunks.length; i++) {
        const pending = upcoming!
        upcoming = i + 1 < chunks.length ? generate(chunks[i + 1]) : null
        let audioData
        try {
          audioData = await pending
        } catch (err) {
          upcoming?.catch(() => {}) // don't leave the lookahead as an unhandled rejection
          throw err
        }
        if (isStale()) {
          upcoming?.catch(() => {})
          return
        }
        try {
          await playBlob(audioData.toBlob())
        } catch (err) {
          upcoming?.catch(() => {})
          throw err
        }
        if (isStale()) {
          upcoming?.catch(() => {})
          return
        }
      }
    },
    stop() {
      playToken++
      currentAudio?.pause()
      currentAudio = null
      // Resolve (not reject) the in-flight clip: the chunk loop then sees isStale() and returns
      // cleanly, running its cleanup. Rejecting would surface a deliberate stop as an error.
      settleCurrent?.()
      settleCurrent = null
    },
  }
}
