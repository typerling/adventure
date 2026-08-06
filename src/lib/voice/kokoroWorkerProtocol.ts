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
  | { kind: 'load'; requestId: number }
  | { kind: 'listVoices'; requestId: number }
  /** Generates every chunk and stitches them into one continuous clip — see kokoroTts.worker.ts's
   * `speak()`. Also how generateKokoroPreview() gets its (single-chunk) clip, rather than a
   * separate 'preview' message kind. `chunks` are pre-split by splitIntoSpeakableChunks on the
   * main thread (pure string processing, no model needed — that function is unaffected by the
   * worker split). `voice` may be empty/unrecognized; the worker falls back to DEFAULT_VOICE. */
  | { kind: 'speak'; requestId: number; chunks: string[]; voice: string }
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
  /** Posted after each chunk finishes generating during a 'speak' job, so the caller can show real
   * progress instead of a frozen "Generating…" for however long the whole turn's pre-generation
   * takes — see kokoroTts.ts's onGenerateProgress. */
  | { kind: 'chunkProgress'; requestId: number; completed: number; total: number }
  | { kind: 'voices'; requestId: number; voices: KokoroWorkerVoice[] }
  /** The stitched (or, for a single-chunk preview, lone) clip — one continuous audio/wav Blob.
   * Blobs are structured-clonable across a worker boundary with no manual transfer needed. */
  | { kind: 'audio'; requestId: number; blob: Blob }
  | { kind: 'done'; requestId: number }
  | { kind: 'error'; requestId: number; message: string }
