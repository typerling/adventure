/**
 * Fully on-device DM turn generation via a small edge-optimized Gemma model, running in-browser
 * over WebGPU (no server, no API key, no data leaving the device) — see DESIGN.md's "no AI vendor
 * SDK dependency" note in §11: `@huggingface/transformers` is a model *runtime*, not a vendor API
 * client, so it doesn't fall under that rule the way `@anthropic-ai/sdk` would.
 *
 * `@huggingface/transformers` is dynamically imported (only when local mode is actually used) —
 * it bundles a full ONNX runtime and is far too heavy to include in the main app bundle for
 * players who never touch this mode.
 */

import {
  createProgressAggregator,
  describeModelDownloadProgress,
  type ModelDownloadProgress,
} from '@/lib/modelDownloadProgress'

// "E2B" = Gemma's edge-optimized elastic-parameter variant, purpose-built for on-device use
// (phones/laptops) rather than a full-size model trimmed after the fact.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'
const MAX_NEW_TOKENS = 1024

export function isLocalModelSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

export type LocalModelLoadProgress = ModelDownloadProgress

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedModel = { processor: any; model: any }

let loadPromise: Promise<LoadedModel> | null = null
let isReady = false
// The most recent progress update for the in-flight load, if any, and every currently-attached
// listener for it. A load is a module-level singleton that can outlive the component that started
// it (e.g. the user leaves Settings mid-download) — without replaying `lastProgress` to a newly
// attached listener, a component that mounts (or re-mounts) while a load is already in flight has
// no way to show anything until the next real update arrives, which reads as "the download
// stopped" even though it's still running in the background.
let lastProgress: LocalModelLoadProgress | null = null
const progressListeners = new Set<(p: LocalModelLoadProgress) => void>()

function broadcastProgress(p: LocalModelLoadProgress): void {
  lastProgress = p
  for (const listener of progressListeners) listener(p)
}

/** Lets Settings show whether the model still needs downloading, without triggering it. */
export function getLocalModelLoadState(): 'unloaded' | 'loading' | 'ready' {
  if (isReady) return 'ready'
  return loadPromise ? 'loading' : 'unloaded'
}

function loadModel(onProgress?: (p: LocalModelLoadProgress) => void): Promise<LoadedModel> {
  if (onProgress) {
    progressListeners.add(onProgress)
    if (lastProgress) onProgress(lastProgress)
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const { AutoProcessor, Gemma4ForCausalLM, env } = await import('@huggingface/transformers')
      const { localModelCache } = await import('./localModelCache')
      const { createResumableFetch } = await import('./localModelResumableFetch')
      // See localModelCache.ts for why this replaces the library's default Cache Storage-backed
      // caching — without it, this ~2.9GB download would repeat on every page load/generation.
      env.useCustomCache = true
      env.customCache = localModelCache
      // See localModelResumableFetch.ts — resumes an interrupted download from where it left off
      // (e.g. after a page refresh) instead of restarting the whole ~2.9GB from byte 0. Wraps the
      // real global fetch directly rather than env.fetch (whose declared type in this library is
      // narrower than the standard fetch signature) — env.fetch defaults to it anyway.
      env.fetch = createResumableFetch(fetch)
      // The processor and model are two separate from_pretrained() calls, each downloading their
      // own set of files but sharing one progress_callback — createProgressAggregator combines
      // both into a single monotonic byte-based percentage instead of each file's own progress
      // (see its doc comment for why raw per-file progress is actively misleading here).
      // broadcastProgress fans out to every attached listener rather than whichever one call to
      // loadModel() happened to be first, so it always runs, listener or not.
      const progressCallback = createProgressAggregator(broadcastProgress)
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: progressCallback }),
        // Gemma4ForCausalLM (not the model card's native Gemma4ForConditionalGeneration) is a
        // deliberate, empty subclass @huggingface/transformers provides specifically to trigger
        // its "text-only" loading path (see resolveTypeConfig/MODEL_SESSION_CONFIG in the
        // installed package's modeling_utils.js/session_config.js) — this repo's DM narrator only
        // ever sends { type: 'text' } content (see generateLocalReply below), never images or
        // audio, but the underlying checkpoint is fully multimodal: alongside the ~2.9GB of
        // decoder + embedding weights this app actually uses, it also ships a ~99MB vision
        // encoder and ~171MB audio encoder that ForConditionalGeneration would download and hold
        // in memory unconditionally. ForCausalLM skips fetching (and allocating) both entirely —
        // confirmed against the model repo's file listing and this library's session-selection
        // logic, not a guess — which both shrinks the download and removes two files from the
        // set fetched concurrently, right as concurrent-download memory pressure is what's been
        // crashing the tab (Chrome's "Aw, Snap") on memory-constrained devices.
        Gemma4ForCausalLM.from_pretrained(MODEL_ID, {
          dtype: 'q4f16',
          device: 'webgpu',
          progress_callback: progressCallback,
        }),
      ])
      return { processor, model }
    })()
    loadPromise.then(
      () => {
        isReady = true
        progressListeners.clear()
      },
      // Don't cache a failed load — let the next attempt (e.g. after enabling WebGPU) retry cleanly.
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

/** Downloads and initializes the model ahead of time (e.g. from Settings), so the first real
 * turn doesn't have to wait on it. Safe to call repeatedly — a load already in flight or done is
 * reused, same as generateLocalReply's own use of loadModel. */
export async function preloadLocalModel(onProgress?: (p: LocalModelLoadProgress) => void): Promise<void> {
  if (!isLocalModelSupported()) {
    throw new Error("This browser doesn't support WebGPU, which the local model needs to run.")
  }
  await loadModel(onProgress)
}

/** Whether the model's files are already cached on disk, regardless of whether this page session
 * has loaded them into memory yet — lets Settings show accurate "downloaded" state on a fresh
 * page load instead of only ever knowing about downloads from the current session. */
export async function hasDownloadedLocalModel(): Promise<boolean> {
  if (isReady) return true
  const { hasCachedLocalModelFiles } = await import('./localModelCache')
  return hasCachedLocalModelFiles()
}

/** Removes the downloaded model from this device (both the complete-file cache and any
 * in-progress partial download), freeing the ~2.9GB it takes up, and resets in-memory state so the
 * next generation/preload re-downloads from scratch rather than reusing a stale reference. */
export async function removeLocalModel(): Promise<void> {
  const [{ clearLocalModelCache }, { clearAllPartialModelDownloads }] = await Promise.all([
    import('./localModelCache'),
    import('./localModelResumableFetch'),
  ])
  await Promise.all([clearLocalModelCache(), clearAllPartialModelDownloads()])
  loadPromise = null
  isReady = false
}

/** Shared with Settings' manual "download now" button so both places describe load progress
 * (and eventual failures) the same way. */
export function describeLocalModelProgress(p: LocalModelLoadProgress): string {
  return describeModelDownloadProgress(p, 'local model')
}

export interface GenerateLocalReplyOptions {
  onLoadProgress?: (p: LocalModelLoadProgress) => void
  /** Called with the accumulated reply text as tokens stream in — generation on a phone GPU can
   * take a while, so showing live progress matters more here than for a cloud API call. */
  onToken?: (textSoFar: string) => void
}

export async function generateLocalReply(prompt: string, opts: GenerateLocalReplyOptions = {}): Promise<string> {
  if (!isLocalModelSupported()) {
    throw new Error("This browser doesn't support WebGPU, which the local model needs to run.")
  }

  const { TextStreamer } = await import('@huggingface/transformers')
  const { processor, model } = await loadModel(opts.onLoadProgress)

  const history = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const chatText = processor.apply_chat_template(history, {
    enable_thinking: false,
    add_generation_prompt: true,
  })
  const inputs = await processor(chatText)

  let fullReply = ''
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    callback_function: (token: string) => {
      fullReply += token
      opts.onToken?.(fullReply)
    },
  })

  await model.generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: true,
    temperature: 0.7,
    streamer,
  })

  if (!fullReply.trim()) {
    throw new Error('The local model produced no text — try again.')
  }
  return fullReply
}
