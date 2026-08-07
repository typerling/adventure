import type { TtsProvider } from './types'
import {
  describeModelDownloadProgress,
  requestPersistentStorage,
  type ModelDownloadProgress,
} from '@/lib/modelDownloadProgress'
import {
  CACHE_NAMES,
  DEFAULT_VOICE,
  KOKORO_DTYPE_SUFFIX,
  MAX_CHUNK_CHARS,
  PREVIEW_TEXT,
  PROGRESS_LABEL,
  type KokoroDevice,
} from './kokoroConstants'
import type {
  KokoroWorkerRequest,
  KokoroWorkerRequestInit,
  KokoroWorkerResponse,
  KokoroWorkerVoice,
} from './kokoroWorkerProtocol'

/**
 * Kokoro (kokoro-js) — a small, high-quality on-device TTS model, replacing the noticeably
 * robotic default browser SpeechSynthesis voices. No key, no server; runs fully in-browser, on
 * WASM by default (broadly compatible — unlike the local Gemma text model, this doesn't *need*
 * WebGPU, so unlike isLocalModelSupported() there is no hard support gate).
 *
 * **WebGPU backend (opt-in, issue #51).** WebGPU is now a selectable, better-when-available
 * alternative to the default WASM backend — mirroring the local text models' per-model "Run on:
 * GPU / CPU" Settings toggle (`localModel.ts`'s getLocalModelDevice/setLocalModelDevice), but as a
 * single global preference rather than one keyed by model id, since Kokoro is exactly one model.
 * `getKokoroDevice`/`setKokoroDevice` below are that preference's main-thread face;
 * `kokoroTts.worker.ts` is where the actual WebGPU-vs-WASM dtype choice and the
 * device-lost/no-adapter fallback live — see that file's doc comment. Default stays `wasm`,
 * preserving the no-hard-gate guarantee above: a player who never opens Settings, or whose browser
 * has no WebGPU at all, is unaffected.
 *
 * Caveat this default-guarantee doesn't get for free, unlike the local text models: those are only
 * *usable* once a player deliberately opts into 'local' AI mode in Settings, so there's no risk of
 * silently defaulting someone into a slow WebGPU load. Kokoro TTS can be selected from Settings the
 * same way — the WebGPU option there is opt-in, not opt-out, precisely to avoid that.
 *
 * **Model loading and generation run in a dedicated Worker** (`kokoroTts.worker.ts`), mirroring
 * `src/lib/ai/localModel.worker.ts`'s split for the local text models — see that file's doc
 * comment for why. This module is only the main-thread face of it: the public API, load-progress
 * state/listeners, and the Cache Storage-backed downloaded/remove helpers, talking to the worker
 * over the typed protocol in `kokoroWorkerProtocol.ts`. `kokoro-js` itself is imported *only* by
 * the worker (plus one narrow exception, `splitIntoSpeakableChunks` below, which needs none of the
 * model) and by that worker dynamically, only when Kokoro TTS is actually used.
 *
 * Playback is one continuous clip per turn, matching `elevenLabsTts.ts`'s one-request/one-blob/
 * one-play model exactly (issue #44): `speak()` asks the worker to generate every chunk from
 * `splitIntoSpeakableChunks` and stitch them into one clip *before* any playback starts, trading
 * "starts speaking after the first chunk" for gapless audio and no possibility of a mid-turn stall
 * waiting on the next chunk (the risk the old generate-ahead-then-play loop carried — see this
 * module's git history / issue #44 for that architecture, since removed).
 *
 * **Backgrounding, revisited (originally flagged in #39/PR #43):** the specific risk that comment
 * described — a currently-*playing* clip surviving Chrome's background-tab throttling while the
 * *next* chunk's `tts.generate()` call, running on the main thread, might not, leaving a real
 * mid-turn gap once playback caught up to an unready chunk — no longer applies, and this time
 * that's structural, not just measured: there is no "next chunk" moment anymore, since every chunk
 * finishes generating *before* playback of the single stitched clip ever starts. What replaces it
 * is a narrower question — does pre-generation *itself* keep making progress if the player
 * backgrounds the tab immediately after starting a turn, before playback has begun — and this PR
 * does not claim to have verified that on a real device either, same limitation the original
 * comment had. What's true in general on the web platform: a dedicated Worker's own execution
 * isn't subject to the same background-tab *timer* throttling that affects `setTimeout`/
 * `setInterval`/rAF on the main thread, which is a good sign; but Chrome's coarser tab *freezing*
 * (suspending a hidden tab's JS entirely after several minutes) applies to workers too and would
 * still delay when playback can start. If that turns out to matter in practice, it's a much
 * smaller, better-understood problem than the old one (bounded to "pre-generation may pause while
 * hidden," not "audio may silently stall mid-turn") — measuring it for real is future work, not
 * done here.
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
 * Cache Storage is shared per-origin between the main thread and a Worker, so this is unaffected
 * by the download itself happening inside kokoroTts.worker.ts.
 */

export { DEFAULT_VOICE }
export type { KokoroDevice }

export type KokoroLoadProgress = ModelDownloadProgress

/**
 * Which backend Kokoro TTS runs on, remembered across reloads — mirrors localModel.ts's identical
 * BACKEND_STORAGE_KEY/preferredDevice/rememberDevice trio, minus the per-model-id map: Kokoro is
 * exactly one model, so this is a single stored value rather than a `Record<modelId, device>`.
 * Kept in localStorage rather than settings.md for the same reason as that file: it describes this
 * *device's* capability, not the campaign, so the same campaign opened on a desktop should still
 * get WebGPU there even if a phone fell back to WASM.
 */
const DEVICE_STORAGE_KEY = 'adventure:kokoro-backend'

function readDevice(): KokoroDevice {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY) === 'webgpu' ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

function rememberDevice(device: KokoroDevice): void {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, device)
  } catch {
    // A full or unavailable localStorage only costs the optimisation, not correctness.
  }
}

/** Which backend Kokoro will use for its next load/generate — whether chosen deliberately in
 * Settings or arrived at by an automatic fallback (kokoroTts.worker.ts's loadWithFallback/doSpeak,
 * reported back via a 'backend' response, see getWorker()'s message handler below). */
export function getKokoroDevice(): KokoroDevice {
  return readDevice()
}

/**
 * Pins Kokoro to a backend from Settings — see localModel.ts's setLocalModelDevice for the
 * identical reasoning, minus the modelId parameter. Drops any loaded copy on both sides: the two
 * backends are different builds (different dtype, different file), so a session created for one
 * cannot serve the other, and the in-memory "ready" state has to be re-earned by the next load.
 * Downloads already on disk for either build are untouched — Cache Storage isn't cleared here.
 */
export async function setKokoroDevice(device: KokoroDevice): Promise<void> {
  if (readDevice() === device) return
  rememberDevice(device)
  isReady = false
  loadPromise = null
  lastProgress = null
  if (worker) await send({ kind: 'evict' })
}

// ---- Worker bridge — mirrors localModel.ts's getWorker()/send() pattern. Kokoro has exactly one
// model, so (unlike localModel.ts) none of this needs to be keyed by a model id. ----

let worker: Worker | null = null
let nextRequestId = 1

interface PendingRequest {
  resolve: (message: KokoroWorkerResponse) => void
  reject: (err: Error) => void
  onChunkProgress?: (completed: number, total: number) => void
}
const pending = new Map<number, PendingRequest>()

let isReady = false
let loadPromise: Promise<void> | null = null
// See localModel.ts's identical pattern for why this exists: a load is a module-level singleton
// that can outlive the component that started it, so a newly (re-)attached listener needs the
// latest known state replayed immediately rather than sitting blank until the next real update.
let lastProgress: KokoroLoadProgress | null = null
const progressListeners = new Set<(p: KokoroLoadProgress) => void>()

/** Constructed lazily and then kept for the page's lifetime: it holds the loaded model, so
 * terminating it between turns would throw away the very thing that makes a second turn fast. */
function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./kokoroTts.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<KokoroWorkerResponse>) => {
    const message = event.data
    switch (message.kind) {
      case 'progress':
        lastProgress = message.progress
        for (const listener of progressListeners) listener(message.progress)
        break
      case 'backend':
        // The worker fell back from 'webgpu' to 'wasm' — no adapter available, or the device was
        // lost mid-generation. Remembered so the *next* load starts on 'wasm' directly instead of
        // paying for the same failed WebGPU attempt on every turn (same reasoning as
        // localModel.ts's identical 'backend' handling for the text models).
        rememberDevice(message.device)
        break
      case 'chunkProgress':
        pending.get(message.requestId)?.onChunkProgress?.(message.completed, message.total)
        break
      case 'voices':
      case 'audio':
      case 'done': {
        const entry = pending.get(message.requestId)
        pending.delete(message.requestId)
        entry?.resolve(message)
        break
      }
      case 'error': {
        const entry = pending.get(message.requestId)
        pending.delete(message.requestId)
        entry?.reject(new Error(message.message))
        break
      }
    }
  })
  // A worker that dies outright (an OOM kill, most likely) would otherwise leave every caller
  // awaiting a reply that can never arrive.
  worker.addEventListener('error', (event) => {
    const err = new Error(event.message || 'The Kokoro voice worker stopped unexpectedly.')
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
    worker = null
    // Describes the dead worker's memory, not this one's — a replacement starts empty, so leaving
    // this set would report the model as ready/loading when nothing actually holds it.
    isReady = false
    loadPromise = null
    lastProgress = null
  })
  return worker
}

function send(request: KokoroWorkerRequestInit, onChunkProgress?: (completed: number, total: number) => void) {
  const requestId = nextRequestId++
  return new Promise<KokoroWorkerResponse>((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onChunkProgress })
    getWorker().postMessage({ ...request, requestId } as KokoroWorkerRequest)
  })
}

/** Lets Settings show whether the voice model still needs downloading, without triggering it. */
export function getKokoroLoadState(): 'unloaded' | 'loading' | 'ready' {
  if (isReady) return 'ready'
  return loadPromise ? 'loading' : 'unloaded'
}

function loadKokoro(onProgress?: (p: KokoroLoadProgress) => void): Promise<void> {
  if (onProgress) {
    progressListeners.add(onProgress)
    if (lastProgress) onProgress(lastProgress)
  }
  if (!loadPromise) {
    // Window-only API, which is part of why this stayed on the main thread.
    requestPersistentStorage()
    loadPromise = send({ kind: 'load', device: readDevice() }).then(() => undefined)
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
 * cached there, see the caching caveat above.
 *
 * Scoped to the build the *currently selected* backend needs — the WASM (`q8`,
 * `model_quantized.onnx`) and WebGPU (`fp32`, `model.onnx`) builds are different files, mirroring
 * hasDownloadedLocalModel's identical per-backend scoping. `model${suffix}.onnx` distinguishes them
 * unambiguously in a URL substring check: `'model_quantized.onnx'` does not contain the substring
 * `'model.onnx'` (there's no `.` immediately after `model`), so the WebGPU check (empty suffix)
 * can't accidentally match a WASM download and vice versa. */
export async function hasDownloadedKokoroModel(): Promise<boolean> {
  if (isReady) return true
  if (typeof caches === 'undefined') return false
  try {
    const cache = await caches.open('transformers-cache')
    const entries = await cache.keys()
    const fileName = `model${KOKORO_DTYPE_SUFFIX[readDevice()]}.onnx`
    return entries.some((request) => request.url.includes('Kokoro') && request.url.includes(fileName))
  } catch {
    return false
  }
}

/** Removes the downloaded voice model from this device (both backends' files, regardless of which
 * is currently selected — a single "Remove" nukes everything Kokoro cached here), and resets
 * in-memory state (here and in the worker) so the next use re-downloads from scratch rather than
 * reusing a stale reference. Also resets the backend preference back to the default ('wasm'): the
 * player may be removing the model specifically to start over, e.g. after an automatic
 * device-lost fallback silently pinned this device to 'wasm' — same reasoning as
 * removeLocalModel's identical reset, adapted for Kokoro's WASM-default (rather than
 * WebGPU-default) posture. */
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
  rememberDevice('wasm')
  if (worker) await send({ kind: 'evict' })
}

/** Shared with Settings' manual "download now" button so both places describe load progress
 * (and eventual failures) the same way. */
export function describeKokoroProgress(p: KokoroLoadProgress): string {
  return describeModelDownloadProgress(p, PROGRESS_LABEL)
}

/** Shared with Play.tsx's `voiceLoadMessage` — the same progress-message convention as
 * describeKokoroProgress (model download), reused for per-turn generation now that playback waits
 * for the whole clip to finish generating before it can start (issue #44). `completed`/`total` are
 * chunk counts, not bytes/percent — for a single-chunk job (e.g. a voice preview) this reads as a
 * plain "Generating…" rather than a redundant "part 1 of 1". */
export function describeKokoroGenerateProgress(completed: number, total: number): string {
  return total <= 1 ? 'Generating narration…' : `Generating narration — part ${completed} of ${total}…`
}

/** One entry from the loaded model's own voice catalog (`tts.voices`) — kokoro-js's per-voice
 * metadata varies by voice (e.g. `traits` is only present on some), so everything but the id/name/
 * language/gender is optional here rather than assumed. */
export type KokoroVoice = KokoroWorkerVoice

/**
 * Lists the voices the model actually ships with, read from the loaded model's own `voices`
 * getter in the worker rather than a hardcoded catalog here — kokoro-js bundles that catalog as a
 * plain object (not exported from the package on its own), so getting at it means going through a
 * real `KokoroTTS` instance, which only exists once loading finishes. Concretely: this triggers
 * the same load-or-reuse path speak() already uses (loadKokoro), so calling it for the first time
 * in a session downloads the model — Settings surfaces that via `onProgress`, the same progress
 * plumbing/format as the "download voice model now" card.
 */
export async function listKokoroVoices(onProgress?: (p: KokoroLoadProgress) => void): Promise<KokoroVoice[]> {
  await loadKokoro(onProgress)
  const res = await send({ kind: 'listVoices', device: readDevice() })
  if (res.kind !== 'voices') throw new Error('Unexpected response loading Kokoro voices.')
  return res.voices
}

/**
 * Generates a short, fixed preview clip for one voice — used by Settings' per-voice preview
 * button. Loads the model first if it isn't already resident (same load-or-reuse path as speak()/
 * listKokoroVoices, so a model already loaded to populate the voice list is reused rather than
 * loaded twice). An unrecognized voice id falls back to DEFAULT_VOICE, resolved worker-side, same
 * as speak() does. Goes through the same 'speak' worker request as a real turn (a one-chunk job),
 * rather than a separate code path, so there's only one place that generates and encodes audio —
 * which also means a preview can be superseded (worker-side `'done'` instead of `'audio'`, see
 * kokoroTts.worker.ts's speak()) by a newer preview or a real turn starting playback while this
 * one is still generating, not just by kokoroPreviewTokenRef's own staleness check in Settings.tsx
 * (which still runs after this resolves — this rejection is the same "not current anymore" case,
 * caught there and correctly not toasted for a choice the player has already moved past).
 */
export async function generateKokoroPreview(
  voiceId: string,
  onProgress?: (p: KokoroLoadProgress) => void,
): Promise<Blob> {
  await loadKokoro(onProgress)
  const res = await send({ kind: 'speak', chunks: [PREVIEW_TEXT], voice: voiceId, device: readDevice() })
  if (res.kind === 'done') throw new Error('Superseded by a newer request before this preview finished generating.')
  if (res.kind !== 'audio') throw new Error('Unexpected response generating a Kokoro voice preview.')
  return res.blob
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
 * turn). Splitting first and generating per chunk is the fix. This is unaffected by #44's move of
 * generation into a Worker: the chunks it produces are simply what gets generated (all up front,
 * then stitched into one clip) instead of generated-and-played one at a time.
 *
 * Uses kokoro-js's own `TextSplitterStream` for the sentence boundaries (it handles abbreviations,
 * decimals, quotes and brackets), driven synchronously: `push()` then spreading runs its internal
 * `flush()`, so the trailing partial sentence is included. Note this deliberately does *not* use
 * `KokoroTTS.stream()`, which builds a `TextSplitterStream` internally but never `close()`s it —
 * its async iterator would then block forever waiting for input that never comes.
 *
 * Runs on the main thread, not in kokoroTts.worker.ts: it's pure string processing with no model
 * involved (`TextSplitterStream` needs no `from_pretrained()` call at all), so there's nothing to
 * gain from moving it, and it's exported for tests on that basis — this runs with no model
 * download, so the splitting is verifiable on its own.
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
  /** Called while a turn's audio is generating, once per finished chunk — every speak() call
   * reports this, since playback now waits for the whole clip to finish generating before it can
   * start (issue #44). Pass completed/total to describeKokoroGenerateProgress for a ready-made
   * label, the same convention describeKokoroProgress already establishes for download progress. */
  onGenerateProgress?: (completed: number, total: number) => void
}

export function createKokoroTtsProvider(opts: KokoroTtsOptions = {}): TtsProvider {
  let currentAudio: HTMLAudioElement | null = null
  /** Bumped by stop() and by each new speak(), so an in-flight generate-then-play call can tell
   * it's been superseded and bail out instead of playing over whatever replaced it. Generation
   * already under way in the worker when that happens isn't cancelled (kokoro-js has no abort
   * primitive for a `generate()` call in flight, and neither does localModel.worker.ts's
   * equivalent) — its result just arrives and is discarded once isStale() is true. */
  let playToken = 0
  /** Settles the in-flight clip when stop() interrupts it. `pause()` fires neither 'ended' nor
   * 'error', so without this the promise never settles: the blob URL is never revoked, and
   * playBlob's own isStale()-adjacent cleanup never runs. */
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

      await loadKokoro(opts.onLoadProgress)
      if (isStale()) return

      // See splitIntoSpeakableChunks — generating the whole narrative in one call would silently
      // truncate it at the model's 512-token context.
      const chunks = await splitIntoSpeakableChunks(text)
      if (isStale() || chunks.length === 0) return

      // Generate every chunk up front and stitch them into one continuous clip before any playback
      // starts, matching ElevenLabs' one-request/one-blob/one-play model (issue #44) — trading
      // "starts speaking after the first chunk" for gapless playback and no possibility of a
      // mid-turn stall waiting on the next chunk. This runs in kokoroTts.worker.ts: pre-generating
      // every chunk back-to-back is tens of seconds of unbroken WASM work for a realistic turn
      // (measured — see that worker's doc comment), which would otherwise freeze the main thread
      // for the whole wait.
      const res = await send({ kind: 'speak', chunks, voice: speakOpts?.voice ?? '', device: readDevice() }, (completed, total) => {
        // opts.onGenerateProgress is one shared callback across every speak() call on this
        // provider instance (Play.tsx reuses one instance per provider kind — see its
        // ttsProviderRef comment) — without this check, a chunkProgress message from a call
        // that's since been superseded would still overwrite the *current* call's progress text.
        if (!isStale()) opts.onGenerateProgress?.(completed, total)
      })
      if (isStale()) return
      if (res.kind !== 'audio') throw new Error('Unexpected response generating narration.')

      await playBlob(res.blob)
    },
    stop() {
      playToken++
      currentAudio?.pause()
      currentAudio = null
      // Resolve (not reject) the in-flight clip: a deliberate stop isn't a failure, and callers
      // treat a rejection as an error worth toasting.
      settleCurrent?.()
      settleCurrent = null
    },
  }
}
