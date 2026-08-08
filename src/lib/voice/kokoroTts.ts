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
  KOKORO_PLAYBACK_BUFFER_CHUNKS,
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
 * **Streaming playback (issue #62).** Real turn narration plays continuously as it generates,
 * rather than waiting for the whole turn: `speak()` asks the worker (kokoroTts.worker.ts's
 * `speakStream()`) to generate every chunk from `splitIntoSpeakableChunks`, and schedules each
 * chunk's raw audio for playback (via the Web Audio API — see "Playback engine" below) the instant
 * it arrives, rather than waiting for a final stitched blob. This replaces #44's one-clip-per-turn
 * design, which traded "starts speaking after the first chunk" for gapless audio and no possibility
 * of a mid-turn stall waiting on the next chunk — see this module's git history / issue #44 for
 * that architecture and why it existed, and issue #62 for why the trade was revisited: #44's stall
 * risk was specifically about generation racing background-tab *timer* throttling on the *main
 * thread*, which no longer applies now that generation runs in a dedicated Worker (see
 * kokoroTts.worker.ts's doc comment, and "Backgrounding" below). `generateKokoroPreview()` (used
 * only by Settings' short, fixed voice-preview clip) still uses the original one-blob 'speak'
 * request — there's nothing to gain from streaming a single short clip, so it wasn't touched.
 *
 * **Playback engine.** Each chunk arrives as *raw* PCM samples (a `Float32Array` + sample rate),
 * not an encoded file — kokoroTts.worker.ts skips WAV-encoding entirely for the streaming path (see
 * its doc comment), since nothing here needs to decode a file, only to schedule already-decoded
 * samples. This uses the Web Audio API (`AudioContext`/`AudioBuffer`/`AudioBufferSourceNode`)
 * rather than sequential `HTMLAudioElement`s: an `AudioBufferSourceNode` can be scheduled to start
 * at a sample-accurate future time on the *same* `AudioContext` clock another node is already
 * playing against (`source.start(when)`), so consecutive chunks can be queued back-to-back with no
 * gap from the scheduling itself — unlike sequential `<audio>` elements, which reliably gap (each
 * one's `play()` call incurs its own decode/output-pipeline startup latency, and nothing schedules
 * element B to begin at the exact sample element A ends on). `speak()`'s `onChunkAudio` callback
 * below tracks a running `nextStartTime` cursor (the `AudioContext` clock time the *next* chunk
 * should begin at)
 * and clamps it to `max(ctx.currentTime, cursor)`, so a chunk that arrives late (playback caught up
 * to generation — see "Falling behind" below) still starts as soon as possible instead of trying to
 * schedule in the past. What this can't fix is any gap or click *baked into the audio itself* —
 * silence Kokoro renders at a chunk's start/end, independent of scheduling — the same caveat the
 * issue flagged ("does not have to be as gapless as the current single stitched clip"). This is
 * genuinely verified, not assumed: `tests/kokoro-streaming-playback.spec.ts` schedules real chunks
 * through a real (unfaked) `AudioContext` — confirmed to work headlessly in this sandbox, including
 * `AudioBufferSourceNode.onended` firing at essentially the buffer's exact scheduled duration (see
 * that spec's own doc comment for the measurement) — and asserts consecutive chunks' actual
 * `start()` times land exactly at the sample-accurate boundary the scheduling math computes, i.e.
 * that *this code's own scheduling logic* introduces zero gap. What that test cannot verify is
 * whether a *real* device's audio output hardware/driver reproduces that scheduling gaplessly in
 * practice — no more possible to check in this sandbox than the WebGPU-audio-quality question
 * `kokoroConstants.ts` already documents as unverified here for the same underlying reason (no real
 * audio/GPU hardware in this container).
 *
 * **Falling behind.** If playback catches up to a chunk that hasn't finished generating yet — the
 * literal stall #44 was written to avoid — `nextStartTime` simply falls behind `ctx.currentTime`
 * until the next chunk arrives and gets scheduled at "now" instead of the (already-past) cursor:
 * an audible gap, not a crash or a stuck spinner. Nothing here claims this never happens: unlike
 * `localModel.worker.ts`'s streamed *text* generation (measured token-by-token against a slower
 * TTS-narration playback rate elsewhere in this app), no equivalent per-chunk timing comparison for
 * Kokoro audio generation vs. its own playback duration has been measured in this sandbox (no real
 * audio hardware to play a chunk's duration against in real time — see "Playback engine" above) —
 * so whether generation reliably stays ahead once "warmed up" by one chunk, the way the issue
 * speculates it might, is left unverified rather than assumed true.
 *
 * **Startup playback buffer (issue #68).** Reported audio artifacts led to investigating exactly
 * this "falling behind" risk more concretely. Two things were newly verified for that investigation
 * (real, unfaked Kokoro CPU inference via kokoro-js's Node build — `onnxruntime-node`'s `cpu`
 * device, the same "conservative lower bound on in-browser WASM" caveat kokoroTts.worker.ts's doc
 * comment already documents for its own timing measurement, not literally in-browser WASM):
 * - Real generated chunk audio has a clean, near-silent taper at *both* ends already (measured:
 *   sub-percent-of-full-scale RMS in the first/last 10ms of every generated chunk, and essentially
 *   zero sample-value jump between one chunk's last sample and the next chunk's first) — ruling
 *   *out* "Kokoro's own boundary lacks a silence taper" as a real cause here: there is no padding to
 *   trim, and a mathematically gapless scheduling boundary between two already-near-silent edges
 *   should not itself produce an audible click. This directly weakens the case for a padding-trim
 *   fix (`splitIntoSpeakableChunks`/generation side) — there's nothing to trim.
 * - Generation speed measured at only ~0.7x of each chunk's own audio duration — a ~30% margin over
 *   real-time even on the conservative-lower-bound backend above. That margin doesn't exist at all
 *   for the *first* chunk (nothing has generated yet when playback would start), and 30% is not much
 *   margin to survive a slower device, a less-favorable (real in-browser WASM, possibly
 *   single-threaded if cross-origin isolation didn't take) backend, or a busy tab — exactly the
 *   conditions under which "falling behind" (this section, above) would produce a real, audible gap
 *   a player could describe as an "artifact."
 *
 * Given the first finding leaves no other in-code-explicable cause standing (see kokoroTts.worker.ts
 * and the issue itself for the full reasoning, including what's still genuinely unverifiable in this
 * sandbox — real audio hardware gaplessness), `speak()` below now buffers the first
 * `KOKORO_PLAYBACK_BUFFER_CHUNKS` chunks (generated, held, not yet scheduled) before starting
 * playback, rather than scheduling chunk 0 the instant it arrives — see that constant's own doc
 * comment for why 2, and the measured per-chunk generation time (~1.3-1.8s in this sandbox) that
 * bounds how much startup latency this actually costs: nowhere near #44's tens-of-seconds full-turn
 * wait, a small, deliberate trade of a little more up-front latency for a real margin against falling
 * behind on chunk 2 once chunk 0 starts playing. A turn with fewer total chunks than the buffer size
 * still plays as soon as all of it is ready, same as before (see `flushPending`'s doc comment for how
 * this collapses correctly for a 1-chunk turn). If *generation itself* fails before the buffer ever
 * fills (a real error, not a supersession), whatever chunks did complete are flushed and played
 * rather than silently discarded — mirroring the existing "don't cut off audio already generated"
 * behavior below for a failure after the buffer has already flushed once.
 *
 * **De-duplication after a WebGPU-fallback restart.** kokoroTts.worker.ts's device-lost/no-adapter
 * fallback restarts the *whole* job from chunk 0 on WASM (not just the failed chunk) — see that
 * file's doc comment for why. Streaming means some of chunks 0..N-1 may already have been scheduled
 * (and be audibly playing) by the time chunk N fails and the restart re-sends chunk 0's audio all
 * over again. `speak()` tracks `nextExpectedChunkIndex` — the next chunk index it's actually willing
 * to schedule — and simply ignores a `chunkAudio` message whose `index` doesn't match it: the first
 * pass's already-accepted chunks 0..N-1 arrive a second time (from the WASM restart) with indices
 * the tracker has already moved past, so they're silently dropped; only the genuinely-new chunk N
 * onward (which now arrives at the index the tracker is still waiting on, once the restart reaches
 * it) gets accepted and scheduled. This needs no special-casing for *which* pass a chunk came from —
 * ordinary in-order chunk delivery with no restart at all satisfies the exact same check trivially.
 * `tests/kokoro-webgpu-backend.spec.ts`'s device-lost test asserts on this directly: the number of
 * chunks actually scheduled for playback equals the turn's real chunk count, not that count plus
 * however many were redundantly regenerated on the fallback backend.
 *
 * **Backgrounding, revisited (originally flagged in #39/PR #43, revisited again by #44 above).**
 * The risk #39 described — a currently-*playing* clip surviving Chrome's background-tab throttling
 * while the *next* chunk's `tts.generate()` call, running on the main thread at the time, might
 * not, leaving a real mid-turn gap once playback caught up to an unready chunk — doesn't apply here
 * either, but for a different reason than #44's fix: generation now runs in a dedicated Worker (see
 * kokoroTts.worker.ts's doc comment), so it isn't subject to the same background-tab *timer*
 * throttling that affects `setTimeout`/`setInterval`/rAF on the main thread. Chrome's coarser tab
 * *freezing* (suspending a hidden tab's JS entirely after several minutes) still applies to workers
 * too, and would still pause generation — with streaming playback, that now means "playback falls
 * behind and gaps," the "Falling behind" case above, rather than #44's "nothing plays until the
 * freeze ends." Verifying either the freeze behavior itself, or how gracefully falling behind reads
 * to a real listener, needs a real device/tab-visibility test this sandbox can't run — left
 * documented as unverified, not assumed fine.
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
  /** Fires once per 'chunkAudio' response for this request — the streaming 'speakStream' path's
   * only per-chunk callback (issue #62); replaces the old 'chunkProgress'-only onChunkProgress,
   * since every progress tick now also carries that chunk's audio. Unused by a plain 'speak'
   * request (generateKokoroPreview), which has nothing to stream. */
  onChunkAudio?: (index: number, total: number, audio: Float32Array, samplingRate: number) => void
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
      case 'chunkAudio':
        pending
          .get(message.requestId)
          ?.onChunkAudio?.(message.index, message.total, message.audio, message.samplingRate)
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

function send(request: KokoroWorkerRequestInit) {
  const requestId = nextRequestId++
  return new Promise<KokoroWorkerResponse>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    getWorker().postMessage({ ...request, requestId } as KokoroWorkerRequest)
  })
}

/** Like send(), but for a 'speakStream' request: `onChunkAudio` fires once per chunk as it
 * arrives (issue #62), and the returned promise settles once the worker reports 'done' — meaning
 * *generation* finished, not playback. createKokoroTtsProvider's speak() deliberately does not
 * resolve its own returned promise from this one; see its own comments for why playback completing
 * is a separate, later event this function knows nothing about. */
function sendStream(
  request: Extract<KokoroWorkerRequestInit, { kind: 'speakStream' }>,
  onChunkAudio: (index: number, total: number, audio: Float32Array, samplingRate: number) => void,
): Promise<void> {
  const requestId = nextRequestId++
  return new Promise<void>((resolve, reject) => {
    pending.set(requestId, { resolve: () => resolve(), reject, onChunkAudio })
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
 * describeKokoroProgress (model download), reused for per-turn generation: playback now starts as
 * soon as the first chunk is ready (issue #62), so this describes generation progress that overlaps
 * with — rather than strictly precedes — playback. `completed`/`total` are chunk counts, not
 * bytes/percent — for a single-chunk job (e.g. a voice preview) this reads as a plain "Generating…"
 * rather than a redundant "part 1 of 1". */
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
 * as speak() does. Goes through the worker's original (non-streaming) 'speak' request — issue #62's
 * streaming path exists for real turn narration, where starting playback sooner actually matters;
 * a preview is one short, fixed clip with nothing to gain from that, so it still just waits for the
 * (almost always one-chunk) result and plays it as a single Blob, the same shape kokoroTts.worker.ts
 * uses for that request either way. A preview can still be superseded (worker-side `'done'` instead
 * of `'audio'`, see kokoroTts.worker.ts's doSpeak()) by a newer preview or a real turn starting
 * playback while this one is still generating — both share the same shared model instance/queue on
 * the worker side, see its doc comment — not just by kokoroPreviewTokenRef's own staleness check in
 * Settings.tsx (which still runs after this resolves — this rejection is the same "not current
 * anymore" case, caught there and correctly not toasted for a choice the player has already moved
 * past).
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
 * download, so the splitting is verifiable on its own. The chunks it produces are simply what gets
 * generated — see this module's doc comment for what happens to each one after that (streamed to
 * playback as it's ready for a real turn, issue #62; generated fully and stitched for a preview).
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
  /** Called once per chunk as it finishes generating (issue #62: this now overlaps with playback
   * of earlier chunks rather than strictly preceding it — Play.tsx's status line just keeps
   * describing "how much of this turn has been generated so far," which stays meaningful either
   * way). Pass completed/total to describeKokoroGenerateProgress for a ready-made label, the same
   * convention describeKokoroProgress already establishes for download progress. */
  onGenerateProgress?: (completed: number, total: number) => void
}

export function createKokoroTtsProvider(opts: KokoroTtsOptions = {}): TtsProvider {
  /** Bumped by stop() and by each new speak(), so anything belonging to a superseded call — a
   * still-in-flight worker generation, a late 'chunkAudio' message, code about to schedule a node —
   * can tell it's been superseded and bail out instead of acting on behalf of a call that's no
   * longer current. Generation already under way in the worker when that happens isn't cancelled
   * (kokoro-js has no abort primitive for a `generate()` call in flight, and neither does
   * localModel.worker.ts's equivalent) — its result just arrives and is discarded once isStale()
   * is true. */
  let playToken = 0
  /** Settles the current speak() call's promise when stop() interrupts it. Needed independent of
   * any AudioBufferSourceNode's own 'ended' event because stop() can land before the very first
   * chunk has even been scheduled (still generating) — there may be no node to fire 'ended' at all
   * yet. Mirrors the pre-#62 single-clip provider's identical settleCurrent, generalized to not
   * depend on one specific node existing. */
  let settleCurrent: (() => void) | null = null

  /** Lazily constructed, then kept for this provider instance's lifetime — Play.tsx caches one
   * provider instance per provider *kind* (see its ttsProviderRef comment), so this AudioContext
   * is reused across every turn's playback rather than rebuilt each time; browsers also cap how
   * many AudioContexts can exist at once, another reason not to churn through them. */
  let audioCtx: AudioContext | null = null
  function getAudioContext(): AudioContext {
    if (!audioCtx) audioCtx = new AudioContext()
    return audioCtx
  }

  /** Every AudioBufferSourceNode scheduled by the current (or a not-yet-superseded) speak() call,
   * in schedule order — stop() (and a fresh speak() superseding an old one) iterates this to
   * silence everything immediately, including a node scheduled to start in the future that hasn't
   * actually begun sounding yet. Reset at the start of each speak() call. */
  let scheduledSources: AudioBufferSourceNode[] = []

  /** Immediately silences every node this provider currently has scheduled/playing and forgets
   * them — called both by stop() and by a new speak() call superseding whatever came before it
   * (mirroring the old single-clip provider's `currentAudio?.pause()` at the top of speak()). */
  function stopScheduledSources(): void {
    for (const source of scheduledSources) {
      // Always safe to call, even on a node whose scheduled time hasn't arrived yet or that has
      // already ended on its own: per the Web Audio API spec, AudioScheduledSourceNode.stop() is a
      // no-op (not an error) once a node has already stopped, and start() having already been
      // called (see speak()'s onChunkAudio callback below — every node here had start() called the
      // instant it was created, even for a future startTime) means stop() is always valid to call,
      // never "hasn't started yet." A stale assumption here would mean this throwing instead of
      // silencing playback, so this was checked against the spec, not assumed.
      source.stop()
    }
    scheduledSources = []
  }

  return {
    async speak(text, speakOpts) {
      const token = ++playToken
      const isStale = () => token !== playToken
      stopScheduledSources()
      // A new speak() call supersedes whatever call preceded it, same as stop() — settle that
      // older call's own returned promise now. Without this, an old call's onChunkAudio callback
      // just bails out via isStale() on every future chunk without ever reaching the resolve()
      // that would otherwise settle it (that only happens for the *last* chunk, and only when not
      // stale), leaving the promise pending forever whenever one turn's playback is superseded by
      // another before its last chunk starts — the routine case for switching turns or
      // auto-narrating a new turn over one still playing (found in independent review of #62).
      settleCurrent?.()
      settleCurrent = null

      await loadKokoro(opts.onLoadProgress)
      if (isStale()) return

      // See splitIntoSpeakableChunks — generating the whole narrative in one call would silently
      // truncate it at the model's 512-token context.
      const chunks = await splitIntoSpeakableChunks(text)
      if (isStale() || chunks.length === 0) return

      const ctx = getAudioContext()
      // A fresh (or long-idle) AudioContext can start/settle 'suspended' pending a user gesture on
      // some browsers (notably Safari) — resume() is a harmless no-op if it's already running.
      // speak() is only ever reached from a click handler (Play.tsx's play/read-aloud controls), so
      // there's always a gesture available here for resume() to use.
      if (ctx.state === 'suspended') await ctx.resume()
      if (isStale()) return

      // See this module's doc comment ("De-duplication after a WebGPU-fallback restart") for why a
      // 'chunkAudio' message whose index doesn't match this is dropped rather than scheduled again.
      let nextExpectedChunkIndex = 0
      // The AudioContext-clock time the next scheduled chunk should begin at — see "Playback
      // engine" above. Clamped against ctx.currentTime on every chunk (not just initialized once),
      // so a chunk that arrives late doesn't try to schedule in the past (see "Falling behind").
      let nextStartTime = ctx.currentTime
      // See "Startup playback buffer" above: chunks arriving before playback has started are held
      // here instead of scheduled immediately, so generation gets a head start over playback rather
      // than starting the race exactly tied. Cleared for good the first time flushPending runs.
      const pendingBuffer: { index: number; audio: Float32Array; samplingRate: number }[] = []
      let started = false

      await new Promise<void>((resolve, reject) => {
        settleCurrent = resolve

        // createBuffer's sampleRate need not match ctx's own hardware rate — the Web Audio API
        // resamples during playback automatically (verified against the spec: AudioBuffer's
        // sampleRate is independent of its BaseAudioContext's), so no manual resampling here.
        function scheduleChunk(index: number, total: number, audio: Float32Array, samplingRate: number): void {
          const buffer = ctx.createBuffer(1, audio.length, samplingRate)
          // getChannelData(0).set(...) rather than copyToChannel(audio, 0) — equivalent for a
          // single-channel buffer, but avoids a strict-typed-array generic mismatch
          // (Float32Array<ArrayBufferLike> vs. the DOM lib's Float32Array<ArrayBuffer>) that
          // copyToChannel's stricter parameter type doesn't accept without an unsafe cast.
          buffer.getChannelData(0).set(audio)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          const startTime = Math.max(ctx.currentTime, nextStartTime)
          nextStartTime = startTime + buffer.duration
          scheduledSources.push(source)
          if (index === total - 1) {
            // The last chunk's natural end is this speak() call's natural end too. A concurrent
            // stop() also resolves this same promise (via settleCurrent) — whichever fires
            // first wins; resolving an already-settled promise a second time is a no-op, so
            // there's no race to guard against here.
            source.onended = () => resolve()
          }
          source.start(startTime)
        }

        // Schedules every chunk buffered so far, back-to-back, and switches to scheduling each
        // future chunk immediately as it arrives — the one-time transition out of "still buffering."
        // A turn with fewer total chunks than KOKORO_PLAYBACK_BUFFER_CHUNKS never has a chance to
        // reach that count; onChunkAudio below flushes as soon as every chunk of a short turn has
        // arrived instead, so a short turn still plays the moment it's actually fully ready, same as
        // before this buffer existed.
        function flushPending(): void {
          started = true
          for (const chunk of pendingBuffer) scheduleChunk(chunk.index, totalChunks, chunk.audio, chunk.samplingRate)
          pendingBuffer.length = 0
        }

        // Set on the first message and unchanged after (the worker sends the same chunks.length on
        // every message for one job) — needed by the error path below, which flushPending can't
        // reach via a chunkAudio callback's own `total` parameter once generation has already failed.
        let totalChunks = 0

        sendStream(
          { kind: 'speakStream', chunks, voice: speakOpts?.voice ?? '', device: readDevice() },
          (index, total, audio, samplingRate) => {
            if (isStale()) return
            totalChunks = total
            // Reported even for a chunk about to be dropped as a duplicate below — a long
            // WebGPU-fallback restart (kokoroTts.worker.ts's doSpeakStream) re-generates chunks
            // 0..N-1 for real before reaching the genuinely new chunk N, and the player should see
            // that work reflected as progress, not a status line stuck on the pre-restart count.
            opts.onGenerateProgress?.(index + 1, total)
            if (index !== nextExpectedChunkIndex) return // duplicate resend — see doc comment above
            nextExpectedChunkIndex++

            if (!started) {
              pendingBuffer.push({ index, audio, samplingRate })
              // Flush once the buffer target is reached, or once every chunk of a shorter-than-the-
              // buffer turn has arrived (min(...)) — see flushPending's doc comment.
              if (pendingBuffer.length < Math.min(KOKORO_PLAYBACK_BUFFER_CHUNKS, total)) return
              flushPending()
              return
            }
            scheduleChunk(index, total, audio, samplingRate)
          },
        ).catch((err: unknown) => {
          // A genuine generation failure (not a supersession) after some chunks already played:
          // deliberately does *not* stop those already-scheduled chunks — cutting off audio mid-
          // sentence over an error the player may not even need to see reads worse than just
          // letting whatever narration exists finish, at the cost of the "Stop playback" UI state
          // reverting slightly before the audio actually stops (Play.tsx's speakText.finally runs
          // on this rejection). Rejecting still surfaces the error as a toast either way.
          if (!isStale()) {
            // The same "let whatever narration exists finish" reasoning applies to chunks still
            // held in the startup buffer when generation fails before ever reaching it — without
            // this, a turn that fails on (say) chunk 3 while still buffering chunks 0-1 would play
            // nothing at all, even though chunk 0 and 1 generated successfully.
            if (!started && pendingBuffer.length > 0) flushPending()
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      }).finally(() => {
        settleCurrent = null
      })
    },
    stop() {
      playToken++
      stopScheduledSources()
      // Resolve (not reject) the in-flight call: a deliberate stop isn't a failure, and callers
      // treat a rejection as an error worth toasting.
      settleCurrent?.()
      settleCurrent = null
    },
  }
}
