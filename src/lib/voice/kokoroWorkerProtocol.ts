/**
 * The message contract between kokoroTts.ts (main thread) and kokoroTts.worker.ts.
 *
 * Mirrors localModelWorkerProtocol.ts's shape and reasoning for the local text models: kept in its
 * own module so both sides import the same types and neither imports the other, `requestId`
 * correlates a reply with its request, and `progress` (model download) is the deliberate
 * exception — addressed to every listener at once rather than to one requestId, since several
 * callers can be waiting on the same load. Unlike localModelWorkerProtocol.ts, there is no modelId
 * dimension anywhere here: Kokoro is exactly one model, not a catalog to pick from.
 */

import type { ModelDownloadProgress } from '@/lib/modelDownloadProgress'
import type { KokoroDevice } from './kokoroConstants'

/** One entry from the loaded model's own voice catalog (`tts.voices`) — kept as a plain
 * structured-clonable object so it can cross the worker boundary; see KokoroVoice in kokoroTts.ts
 * for the identical main-thread-facing shape. */
export interface KokoroWorkerVoice {
  id: string
  name: string
  language: string
  gender: string
  traits?: string
}

export type KokoroWorkerRequest =
  /** `device` is the caller's *preferred* backend, not a guarantee — see kokoroTts.worker.ts's
   * loadWithFallback: 'webgpu' silently falls back to 'wasm' (reported via a 'backend' response)
   * if no adapter is available at all, same posture as a mid-generation device loss. */
  | { kind: 'load'; requestId: number; device: KokoroDevice }
  | { kind: 'listVoices'; requestId: number; device: KokoroDevice }
  /** Generates every chunk and stitches them into one continuous clip, replying with a single
   * final 'audio' — see kokoroTts.worker.ts's `speak()`. Used only by generateKokoroPreview() for
   * its short, fixed-text (almost always one-chunk) clip, where there's nothing to gain from
   * streaming. `chunks` are pre-split by splitIntoSpeakableChunks on the main thread (pure string
   * processing, no model needed — that function is unaffected by the worker split). `voice` may be
   * empty/unrecognized; the worker falls back to DEFAULT_VOICE. */
  | { kind: 'speak'; requestId: number; chunks: string[]; voice: string; device: KokoroDevice }
  /** Like 'speak', but replies with one 'chunkAudio' per chunk *as soon as that chunk finishes
   * generating* instead of waiting for the whole job and stitching a final blob — see
   * kokoroTts.worker.ts's `speakStream()`/`doSpeakStream()` (issue #62). Used by
   * createKokoroTtsProvider's real turn-narration speak(), which schedules each chunk's raw audio
   * for playback the moment it arrives rather than waiting on every chunk. Same `chunks`/`voice`/
   * `device` shape as 'speak' — only the response shape differs. */
  | { kind: 'speakStream'; requestId: number; chunks: string[]; voice: string; device: KokoroDevice }
  /** Drops every loaded backend's reference (both wasm and webgpu, if either is resident) — see
   * kokoroTts.worker.ts's 'evict' handler for why a single global evict is enough for a
   * single-model app, unlike localModelWorkerProtocol.ts's per-modelId evict. */
  | { kind: 'evict'; requestId: number }

/**
 * A request minus the `requestId`, which the sender assigns. Written as a distributive conditional
 * rather than `Omit<KokoroWorkerRequest, 'requestId'>` — see localModelWorkerProtocol.ts's
 * identical WorkerRequestInit for why a plain Omit over a union would silently drop `chunks`/`voice`.
 */
export type KokoroWorkerRequestInit = KokoroWorkerRequest extends infer T
  ? T extends { requestId: number }
    ? Omit<T, 'requestId'>
    : never
  : never

export type KokoroWorkerResponse =
  | { kind: 'progress'; progress: ModelDownloadProgress }
  /** Posted whenever the worker fell back from 'webgpu' to 'wasm' — either because no WebGPU
   * adapter was available at all when a load was attempted, or because the device was lost
   * mid-generation. Mirrors localModelWorkerProtocol.ts's identical 'backend' response; kokoroTts.ts
   * remembers this the same way so later loads start on 'wasm' directly instead of rediscovering
   * the failure on every turn. Not addressed to a requestId, same reasoning as 'progress': it
   * describes a backend-wide fact, not one request's result. */
  | { kind: 'backend'; device: KokoroDevice }
  /** Posted once per finished chunk during a 'speakStream' job (issue #62) — carries that chunk's
   * *raw* samples (not yet WAV-encoded; see kokoroTts.ts's playback engine, which builds an
   * AudioBuffer straight from these rather than decoding an encoded file) so the caller can start
   * playing it immediately instead of waiting for the whole turn. `index` is 0-based and, together
   * with `total`, doubles as this job's progress reporting (see kokoroTts.ts's onGenerateProgress)
   * — a dedicated 'chunkProgress' response existed before this shipped but is redundant with this
   * one now that every progress tick already carries a chunk's audio. `index` also lets the caller
   * de-duplicate a chunk resent after a WebGPU-fallback restart (kokoroTts.worker.ts's doSpeak/
   * doSpeakStream restart generation from chunk 0 on the fallback backend rather than resuming —
   * see that file's doc comment — so a chunk already accepted once must not be scheduled again).
   * `audio`'s underlying buffer is transferred, not cloned (see kokoroTts.worker.ts's postChunk) —
   * nothing on the worker side reads it again after posting. */
  | { kind: 'chunkAudio'; requestId: number; index: number; total: number; audio: Float32Array; samplingRate: number }
  | { kind: 'voices'; requestId: number; voices: KokoroWorkerVoice[] }
  /** The stitched (or, for a single-chunk preview, lone) clip — one continuous audio/wav Blob.
   * Blobs are structured-clonable across a worker boundary with no manual transfer needed. Only
   * ever sent for a 'speak' request (generateKokoroPreview) — a 'speakStream' job's completion is
   * signalled by 'done' instead, since it has no single blob to hand back. */
  | { kind: 'audio'; requestId: number; blob: Blob }
  /** Signals a request is finished with nothing further coming — either a genuinely completed
   * 'speakStream' job (every chunk already delivered via 'chunkAudio'), or any request (either
   * kind) that turned out to be superseded before/while running — see kokoroTts.worker.ts's
   * doSpeak/doSpeakStream for why 'done' doubles as the safe "nothing to report" reply in the
   * superseded case. */
  | { kind: 'done'; requestId: number }
  | { kind: 'error'; requestId: number; message: string }
