/**
 * Fully on-device DM turn generation via a small instruction-tuned model, running in-browser (no
 * server, no API key, no data leaving the device) — see DESIGN.md's "no AI vendor SDK dependency"
 * note in §11: `@huggingface/transformers` is a model *runtime*, not a vendor API client, so it
 * doesn't fall under that rule the way `@anthropic-ai/sdk` would.
 *
 * This module is the main-thread face of local mode: the public API the app calls, the per-model
 * UI state (load status, download progress, listeners), and the IndexedDB-backed
 * downloaded/partial/remove helpers. The model itself lives in localModel.worker.ts — see that
 * file for why generation must not run on the main thread. `@huggingface/transformers` is
 * therefore never imported here at all; the worker is what pulls in the ONNX runtime, and it is
 * only constructed when local mode is actually used.
 *
 * Several models are offered (LOCAL_MODELS) rather than one fixed choice, since "how much can this
 * device's browser tab hold before crashing" varies enormously by device, and there's no way to
 * know ahead of time — a picker with real sizes lets a player who hits a crash retry with
 * something smaller instead of being stuck.
 */

import type { LocalModelId } from '@/types/campaign'
import {
  describeModelDownloadProgress,
  requestPersistentStorage,
  type ModelDownloadProgress,
} from '@/lib/modelDownloadProgress'
import { LOCAL_MODEL_DTYPE_SUFFIX, type LocalModelDevice } from './localModelCatalog'
import type { WorkerRequest, WorkerRequestInit, WorkerResponse } from './localModelWorkerProtocol'

export { LOCAL_MODELS, type LocalModelInfo } from './localModelCatalog'
export type { LocalModelDevice } from './localModelCatalog'

export type LocalModelLoadProgress = ModelDownloadProgress

/** Feature detection for WebGPU only. Note this is *not* the same question as "can local mode run
 * here" — see canRunLocalModel: a model pinned to the CPU backend needs no GPU at all. */
export function isLocalModelSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

/** Whether a specific model can run on this device: either the GPU is available, or the model has
 * been put on the CPU backend, which doesn't touch WebGPU. Keeping the WebGPU check tied to the
 * resolved backend rather than applied blanket-fashion is what lets a browser without WebGPU run
 * local mode at all — before the CPU backend existed, refusing outright was the whole story. */
export function canRunLocalModel(modelId: LocalModelId): boolean {
  return isLocalModelSupported() || preferredDevice(modelId) === 'wasm'
}

const NO_WEBGPU_MESSAGE =
  "This browser doesn't support WebGPU. Set this model to run on the CPU in Settings to use it anyway — " +
  'it will be a lot slower.'

/**
 * Which backend each model last settled on, remembered across reloads.
 *
 * Without this, a device whose GPU can't sustain a generation would rediscover that the expensive
 * way on *every* turn: run on WebGPU, lose the device partway, throw the partial reply away, then
 * fall back. Once a model has fallen back here, later turns start on the CPU directly. Kept in
 * localStorage rather than settings.md because it describes this device, not the campaign — the
 * same campaign opened on a desktop should still use the GPU (same reasoning as elevenLabsKey.ts,
 * for a different cause).
 */
const BACKEND_STORAGE_KEY = 'adventure:local-model-backend'

function readBackends(): Record<string, LocalModelDevice> {
  try {
    const raw = localStorage.getItem(BACKEND_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, LocalModelDevice>) : {}
  } catch {
    return {}
  }
}

function preferredDevice(modelId: LocalModelId): LocalModelDevice {
  return readBackends()[modelId] === 'wasm' ? 'wasm' : 'webgpu'
}

function rememberDevice(modelId: LocalModelId, device: LocalModelDevice): void {
  try {
    localStorage.setItem(BACKEND_STORAGE_KEY, JSON.stringify({ ...readBackends(), [modelId]: device }))
  } catch {
    // A full or unavailable localStorage only costs the optimisation, not correctness.
  }
}

/** Which backend a model will use for its next run — whether chosen deliberately in Settings or
 * arrived at by an automatic fallback. */
export function getLocalModelDevice(modelId: LocalModelId): LocalModelDevice {
  return preferredDevice(modelId)
}

/**
 * Pins a model to a backend from Settings, rather than waiting for a GPU crash to discover it the
 * expensive way. The CPU backend trades speed for not competing for GPU memory at all, which is
 * the difference between slow and unusable on a device whose GPU can't hold the model.
 *
 * Drops the loaded copy on both sides, because the two backends are genuinely different builds
 * (`_q4f16` vs `_quantized`) and a session created for one cannot serve the other — the next load
 * has to fetch and initialise the right file. Downloads already on disk are untouched, so
 * switching back to a build that was fetched before doesn't re-download it.
 */
export async function setLocalModelDevice(modelId: LocalModelId, device: LocalModelDevice): Promise<void> {
  if (preferredDevice(modelId) === device) return
  rememberDevice(modelId, device)
  modelStates.delete(modelId)
  if (worker) await send({ kind: 'evict', modelId })
}

interface ModelRuntimeState {
  loadPromise: Promise<void> | null
  isReady: boolean
  // The most recent progress update for the in-flight load, if any, and every attached listener.
  // A load outlives the component that started it (the user can leave Settings mid-download), so
  // without replaying `lastProgress` to a newly attached listener, a component mounting while a
  // load is already in flight shows nothing until the next update — which reads as "the download
  // stopped" even though it's still running.
  lastProgress: LocalModelLoadProgress | null
  progressListeners: Set<(p: LocalModelLoadProgress) => void>
}

// Keyed by model ID rather than one shared set of variables — several models can each have their
// own in-flight load, cached download, or listener at once.
const modelStates = new Map<string, ModelRuntimeState>()

function getModelState(modelId: string): ModelRuntimeState {
  let state = modelStates.get(modelId)
  if (!state) {
    state = { loadPromise: null, isReady: false, lastProgress: null, progressListeners: new Set() }
    modelStates.set(modelId, state)
  }
  return state
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<
  number,
  { resolve: (reply: string | undefined) => void; reject: (err: Error) => void; onToken?: (text: string) => void }
>()

/** Constructed lazily and then kept for the page's lifetime: it holds the loaded models, so
 * terminating it between turns would throw away the very thing that makes a second turn fast. */
function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./localModel.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    switch (message.kind) {
      case 'progress': {
        const state = getModelState(message.modelId)
        state.lastProgress = message.progress
        for (const listener of state.progressListeners) listener(message.progress)
        break
      }
      case 'backend':
        rememberDevice(message.modelId, message.device)
        break
      case 'token':
        pending.get(message.requestId)?.onToken?.(message.text)
        break
      case 'done': {
        const entry = pending.get(message.requestId)
        pending.delete(message.requestId)
        entry?.resolve(message.reply)
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
    const err = new Error(event.message || 'The local model worker stopped unexpectedly.')
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
    worker = null
    // Everything this map says about what is loaded described the dead worker's memory. A
    // replacement starts empty, so leaving it would have Settings reporting models as ready that
    // nothing actually holds. The on-disk download cache is untouched — a reload is a reload, not
    // a re-download.
    modelStates.clear()
  })
  return worker
}

function send(request: WorkerRequestInit, onToken?: (text: string) => void): Promise<string | undefined> {
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onToken })
    getWorker().postMessage({ ...request, requestId } as WorkerRequest)
  })
}

/** Lets Settings show whether a given model still needs downloading, without triggering it. */
export function getLocalModelLoadState(modelId: LocalModelId): 'unloaded' | 'loading' | 'ready' {
  const state = modelStates.get(modelId)
  if (!state) return 'unloaded'
  if (state.isReady) return 'ready'
  return state.loadPromise ? 'loading' : 'unloaded'
}

function loadModel(modelId: LocalModelId, onProgress?: (p: LocalModelLoadProgress) => void): Promise<void> {
  const state = getModelState(modelId)
  if (onProgress) {
    state.progressListeners.add(onProgress)
    if (state.lastProgress) onProgress(state.lastProgress)
  }
  if (!state.loadPromise) {
    // Window-only API, which is part of why this stayed on the main thread.
    requestPersistentStorage()
    state.loadPromise = send({ kind: 'load', modelId, device: preferredDevice(modelId) }).then(() => undefined)
    state.loadPromise.then(
      () => {
        state.isReady = true
        state.progressListeners.clear()
      },
      // Don't cache a failed load — let the next attempt retry cleanly.
      () => {
        state.loadPromise = null
        state.isReady = false
        state.lastProgress = null
        state.progressListeners.clear()
      },
    )
  }
  return state.loadPromise
}

/** Downloads and initializes a model ahead of time (e.g. from Settings), so the first real turn
 * doesn't have to wait on it. Safe to call repeatedly — a load already in flight or done is
 * reused, same as generateLocalReply's own use of loadModel. */
export async function preloadLocalModel(
  modelId: LocalModelId,
  onProgress?: (p: LocalModelLoadProgress) => void,
): Promise<void> {
  if (!canRunLocalModel(modelId)) throw new Error(NO_WEBGPU_MESSAGE)
  await loadModel(modelId, onProgress)
}

/** Whether a model's files are already cached on disk, regardless of whether this page session has
 * loaded them into memory yet — lets Settings show accurate "downloaded" state on a fresh page
 * load instead of only knowing about downloads from the current session. */
export async function hasDownloadedLocalModel(modelId: LocalModelId): Promise<boolean> {
  if (modelStates.get(modelId)?.isReady) return true
  const { hasCachedLocalModelFiles } = await import('./localModelCache')
  // Scoped to the build the *currently selected* backend needs. The GPU and CPU builds are
  // different files, so a model fetched for the GPU and then switched to the CPU is genuinely not
  // downloaded yet, and saying otherwise would hide a several-hundred-megabyte fetch behind a row
  // that claimed to be ready.
  return hasCachedLocalModelFiles(modelId, LOCAL_MODEL_DTYPE_SUFFIX[preferredDevice(modelId)])
}

/** Whether a model has an interrupted/incomplete download sitting on disk — distinct from fully
 * cached, so Settings can offer to clear it even though the model was never actually usable. */
export async function hasPartiallyDownloadedLocalModel(modelId: LocalModelId): Promise<boolean> {
  const { hasPartialModelDownload } = await import('./localModelResumableFetch')
  return hasPartialModelDownload(modelId)
}

/** Removes a model from this device (both its complete-file cache and any in-progress partial
 * download), freeing the space it takes up, and resets its state — in this module, in the worker
 * that holds the loaded copy, and in the remembered-backend map — so the next generation or
 * preload starts genuinely from scratch. Other models are untouched. */
export async function removeLocalModel(modelId: LocalModelId): Promise<void> {
  const [{ clearLocalModelCache }, { clearPartialModelDownload }] = await Promise.all([
    import('./localModelCache'),
    import('./localModelResumableFetch'),
  ])
  await Promise.all([clearLocalModelCache(modelId), clearPartialModelDownload(modelId)])
  modelStates.delete(modelId)
  // Deliberately re-enables WebGPU for this model: the player may be removing it precisely to
  // start over, and pinning them to the slow backend forever would make that unfixable from the UI.
  try {
    const backends = readBackends()
    delete backends[modelId]
    localStorage.setItem(BACKEND_STORAGE_KEY, JSON.stringify(backends))
  } catch {
    // Best-effort, same as rememberDevice.
  }
  if (worker) await send({ kind: 'evict', modelId })
}

/** Shared with Settings' manual "download now" button so both places describe load progress (and
 * eventual failures) the same way. */
export function describeLocalModelProgress(p: LocalModelLoadProgress): string {
  return describeModelDownloadProgress(p, 'local model')
}

/** ONNX Runtime surfaces a lost GPU device as a wall of C++ file paths and buffer-manager
 * internals, which tells a player nothing they can act on. Only reached when the CPU fallback
 * *also* failed — an ordinary device loss is now handled by finishing the turn on the CPU rather
 * than by reporting anything. Everything else is passed through as-is rather than guessed at. */
function describeGenerationFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/device.{0,20}(is )?lost|mapAsync/i.test(raw)) {
    return (
      "This device's GPU dropped the model and running it on the CPU instead didn't work either. " +
      'Try a smaller model in Settings, or switch this campaign to the Claude API in Settings.'
    )
  }
  return raw
}

export interface GenerateLocalReplyOptions {
  onLoadProgress?: (p: LocalModelLoadProgress) => void
  /** Called with the accumulated reply text as tokens stream in — generation on a phone can take a
   * while, so showing live progress matters more here than for a cloud API call. */
  onToken?: (textSoFar: string) => void
}

export async function generateLocalReply(
  modelId: LocalModelId,
  prompt: string,
  opts: GenerateLocalReplyOptions = {},
): Promise<string> {
  if (!canRunLocalModel(modelId)) throw new Error(NO_WEBGPU_MESSAGE)

  const state = getModelState(modelId)
  requestPersistentStorage()

  try {
    // Load through loadModel() rather than letting the worker load lazily inside 'generate'.
    // loadModel is what publishes `loadPromise`, and that is the only thing
    // getLocalModelLoadState() — and so Settings' model row, and its effect for reattaching to an
    // in-flight download — has to go on. Going straight to 'generate' left a download started from
    // Play invisible in Settings, which sat on an idle "Download" button for the whole thing and
    // would start a redundant second load if pressed. The worker caches per model and backend, so
    // the 'generate' that follows doesn't reload anything.
    await loadModel(modelId, opts.onLoadProgress)
    const reply = await send({ kind: 'generate', modelId, prompt, device: preferredDevice(modelId) }, opts.onToken)
    return reply ?? ''
  } catch (err) {
    // The worker has already dropped whatever it was holding for this model; clear the mirror of
    // that state here so the next attempt reloads rather than reporting a model that isn't there.
    modelStates.delete(modelId)
    throw new Error(describeGenerationFailure(err))
  } finally {
    if (opts.onLoadProgress) state.progressListeners.delete(opts.onLoadProgress)
  }
}
