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

/** Lets Settings show whether the model still needs downloading, without triggering it. */
export function getLocalModelLoadState(): 'unloaded' | 'loading' | 'ready' {
  if (isReady) return 'ready'
  return loadPromise ? 'loading' : 'unloaded'
}

function loadModel(onProgress?: (p: LocalModelLoadProgress) => void): Promise<LoadedModel> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const { AutoProcessor, Gemma4ForConditionalGeneration, env } = await import('@huggingface/transformers')
      const { localModelCache } = await import('./localModelCache')
      const { createResumableFetch } = await import('./localModelResumableFetch')
      // See localModelCache.ts for why this replaces the library's default Cache Storage-backed
      // caching — without it, this ~1GB download would repeat on every page load/generation.
      env.useCustomCache = true
      env.customCache = localModelCache
      // See localModelResumableFetch.ts — resumes an interrupted download from where it left off
      // (e.g. after a page refresh) instead of restarting the whole ~1GB from byte 0. Wraps the
      // real global fetch directly rather than env.fetch (whose declared type in this library is
      // narrower than the standard fetch signature) — env.fetch defaults to it anyway.
      const resumedUrls = new Set<string>()
      env.fetch = createResumableFetch(fetch, undefined, (url) => resumedUrls.add(url))
      // The progress events' `file` field is just the filename within the repo (e.g.
      // "onnx/model_q4f16.onnx"), while `onResume` reports the full request URL — matching by
      // suffix is enough since a filename collision across different repo paths isn't possible
      // here (this only ever loads one model id).
      const wasResumed = (file?: string) => !!file && [...resumedUrls].some((url) => url.endsWith(file))
      // The processor and model are two separate from_pretrained() calls, each downloading their
      // own set of files but sharing one progress_callback — createProgressAggregator combines
      // both into a single monotonic byte-based percentage instead of each file's own progress
      // (see its doc comment for why raw per-file progress is actively misleading here). Tag each
      // raw per-file event with whether *that file* is resuming before it reaches the aggregator,
      // so the aggregator's own per-file bookkeeping (and the "any file resuming" flag it derives)
      // sees accurate input rather than only ever the last file's status.
      const progressCallback = onProgress ? createProgressAggregator(onProgress) : undefined
      const taggedProgressCallback = progressCallback
        ? (p: LocalModelLoadProgress) =>
            progressCallback(p.status === 'progress' && wasResumed(p.file) ? { ...p, resuming: true } : p)
        : undefined
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: taggedProgressCallback }),
        Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
          dtype: 'q4f16',
          device: 'webgpu',
          progress_callback: taggedProgressCallback,
        }),
      ])
      return { processor, model }
    })()
    loadPromise.then(
      () => {
        isReady = true
      },
      // Don't cache a failed load — let the next attempt (e.g. after enabling WebGPU) retry cleanly.
      () => {
        loadPromise = null
        isReady = false
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
 * in-progress partial download), freeing the ~1GB it takes up, and resets in-memory state so the
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
