/**
 * The message contract between localModel.ts (main thread) and localModel.worker.ts.
 *
 * Kept in its own module so both sides import the same types and neither imports the other — the
 * worker importing localModel.ts would recursively spawn workers, since that module's job is to
 * construct one.
 *
 * `requestId` correlates a reply with its request. Progress is the deliberate exception: it is
 * addressed by `modelId` rather than `requestId`, because several callers can be waiting on one
 * load (Settings' download card and a campaign's first turn, say) and all of them want the
 * updates. Fanning out to per-model listeners is the main thread's job.
 */

import type { LocalModelId } from '@/types/campaign'
import type { ModelDownloadProgress } from '@/lib/modelDownloadProgress'
import type { LocalModelDevice } from './localModelCatalog'

export type WorkerRequest =
  | { kind: 'load'; requestId: number; modelId: LocalModelId; device: LocalModelDevice }
  | { kind: 'generate'; requestId: number; modelId: LocalModelId; prompt: string; device: LocalModelDevice }
  | { kind: 'evict'; requestId: number; modelId: LocalModelId }

/**
 * A request minus the `requestId`, which the sender assigns. Written as a distributive conditional
 * rather than `Omit<WorkerRequest, 'requestId'>`: a plain `Omit` over a union collapses it to the
 * keys every member shares, which would silently drop `prompt` and `device`.
 */
export type WorkerRequestInit = WorkerRequest extends infer T
  ? T extends { requestId: number }
    ? Omit<T, 'requestId'>
    : never
  : never

export type WorkerResponse =
  | { kind: 'progress'; modelId: LocalModelId; progress: ModelDownloadProgress }
  /** The accumulated reply so far, not just the newest token — the preview renders the whole
   * string, and sending it whole means a dropped or reordered message can't corrupt it. */
  | { kind: 'token'; requestId: number; text: string }
  /** Which backend a model actually ended up on, whenever that is decided or changes. Lets the UI
   * explain a sudden slowdown, and lets the main thread remember a device that can't sustain
   * WebGPU instead of rediscovering it every turn. */
  | { kind: 'backend'; modelId: LocalModelId; device: LocalModelDevice }
  | { kind: 'done'; requestId: number; reply?: string }
  | { kind: 'error'; requestId: number; message: string; deviceLost: boolean }
