/**
 * Fully on-device DM turn generation via a small instruction-tuned model, running in-browser over
 * WebGPU (no server, no API key, no data leaving the device) — see DESIGN.md's "no AI vendor SDK
 * dependency" note in §11: `@huggingface/transformers` is a model *runtime*, not a vendor API
 * client, so it doesn't fall under that rule the way `@anthropic-ai/sdk` would.
 *
 * `@huggingface/transformers` is dynamically imported (only when local mode is actually used) —
 * it bundles a full ONNX runtime and is far too heavy to include in the main app bundle for
 * players who never touch this mode.
 *
 * Several models are offered (LOCAL_MODELS below) rather than one fixed choice, since "how much
 * can this device's browser tab hold in memory before crashing" varies enormously by device, and
 * there's no way to know that ahead of time — a picker with real sizes lets a player who hits a
 * crash retry with something smaller instead of being stuck.
 */

import type { LocalModelId } from '@/types/campaign'
import {
  createProgressAggregator,
  describeModelDownloadProgress,
  requestPersistentStorage,
  type ModelDownloadProgress,
} from '@/lib/modelDownloadProgress'

const MAX_NEW_TOKENS = 1024

export interface LocalModelInfo {
  label: string
  /** Approximate total download size (decoder + tokenizer + small config files) at the q4f16
   * quantization this app always requests — for the picker/download cards, not exact byte
   * accounting. Measured against each repo's actual `onnx/` file listing on Hugging Face. */
  sizeBytes: number
  /** Only the Gemma 4 E2B checkpoint ships a real `preprocessor_config.json` — it's a genuinely
   * multimodal-capable checkpoint, loaded here in text-only mode (see the `AutoModelForCausalLM`
   * comment in loadModel below). `AutoProcessor.from_pretrained()` throws for any repo without
   * one, so every other (natively text-only) model here uses a plain `AutoTokenizer` instead —
   * and its chat template expects `content` as a plain string, not a list of parts, unlike the
   * processor's. */
  usesProcessor: boolean
}

/** Ordered smallest to largest — see the PR that added this for how each size/architecture claim
 * was verified (repo file listings, resolveTypeConfig/session_config.js in the installed
 * package). Gemma 4 E2B is kept as the largest/highest-quality option since it's what this app
 * shipped with first; the rest were added specifically because that one crashed low-memory
 * devices around ~2GB downloaded. */
export const LOCAL_MODELS: Record<LocalModelId, LocalModelInfo> = {
  'onnx-community/Qwen2.5-0.5B-Instruct': {
    label: 'Qwen2.5 0.5B — smallest, weakest at following the reply format',
    sizeBytes: 490_000_000,
    usesProcessor: false,
  },
  'onnx-community/gemma-3-1b-it-ONNX': {
    label: 'Gemma 3 1B — recommended balance of size and quality',
    sizeBytes: 785_000_000,
    usesProcessor: false,
  },
  'HuggingFaceTB/SmolLM2-1.7B-Instruct': {
    label: 'SmolLM2 1.7B — edge-optimized, competitive for its size',
    sizeBytes: 1_110_000_000,
    usesProcessor: false,
  },
  'onnx-community/Llama-3.2-1B-Instruct': {
    label: 'Llama 3.2 1B',
    sizeBytes: 1_100_000_000,
    usesProcessor: false,
  },
  'onnx-community/Qwen2.5-1.5B-Instruct': {
    label: 'Qwen2.5 1.5B',
    sizeBytes: 1_230_000_000,
    usesProcessor: false,
  },
  'onnx-community/gemma-4-E2B-it-ONNX': {
    label: 'Gemma 4 E2B — largest, highest quality',
    sizeBytes: 3_170_000_000,
    usesProcessor: true,
  },
}

export function isLocalModelSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

export type LocalModelLoadProgress = ModelDownloadProgress

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedModel = { processor: any; model: any }

interface ModelRuntimeState {
  loadPromise: Promise<LoadedModel> | null
  isReady: boolean
  // The most recent progress update for the in-flight load, if any, and every currently-attached
  // listener for it. A load is a module-level singleton that can outlive the component that
  // started it (e.g. the user leaves Settings mid-download) — without replaying `lastProgress` to
  // a newly attached listener, a component that mounts (or re-mounts) while a load is already in
  // flight has no way to show anything until the next real update arrives, which reads as "the
  // download stopped" even though it's still running in the background.
  lastProgress: LocalModelLoadProgress | null
  progressListeners: Set<(p: LocalModelLoadProgress) => void>
}

// Keyed by model ID rather than one shared set of module-level variables — several models can
// each have their own in-flight load, cached download, or listener at once (e.g. a player
// downloads one model ahead of time in Settings while a different campaign is mid-generation
// with another).
const modelStates = new Map<string, ModelRuntimeState>()

function getModelState(modelId: string): ModelRuntimeState {
  let state = modelStates.get(modelId)
  if (!state) {
    state = { loadPromise: null, isReady: false, lastProgress: null, progressListeners: new Set() }
    modelStates.set(modelId, state)
  }
  return state
}

function broadcastProgress(state: ModelRuntimeState, p: LocalModelLoadProgress): void {
  state.lastProgress = p
  for (const listener of state.progressListeners) listener(p)
}

const UNUSED_TEXT_ONLY_FILE_PATTERN = /vision_encoder|audio_encoder/

/** @huggingface/transformers' upfront `progress_total` estimate (see modeling_utils.js's
 * from_pretrained, which calls get_model_files()/getSessionsConfig() to size every file before
 * any of them download) is computed purely from the checkpoint's own config — for Gemma 4 E2B it
 * never receives the `textOnly` flag that loading it as a CausalLM below triggers, so it still
 * counts the vision/audio encoder files' sizes even though they're never fetched. Left alone, the
 * aggregate percentage would stall around ~91% (2.9GB actually downloaded / (2.9GB + the ~270MB
 * that's never fetched) ≈ 91%) and jump straight to "ready" without ever visibly reaching 100%.
 * Every other model here is natively text-only (no vision/audio components exist to strip in the
 * first place), so this is a harmless no-op for them — applied unconditionally rather than only
 * for Gemma 4 E2B to avoid a model-specific branch here. */
function stripUnusedComponents(p: LocalModelLoadProgress): LocalModelLoadProgress {
  if (p.status !== 'progress_total' || !p.files) return p
  let loaded = 0
  let total = 0
  const files: Record<string, { loaded: number; total: number }> = {}
  for (const [file, f] of Object.entries(p.files)) {
    if (UNUSED_TEXT_ONLY_FILE_PATTERN.test(file)) continue
    files[file] = f
    loaded += f.loaded
    total += f.total
  }
  return { ...p, files, loaded, total, progress: total > 0 ? (loaded / total) * 100 : p.progress }
}

/**
 * One throwaway single-token generation before the model is reported ready — what every official
 * transformers.js WebGPU example does after `from_pretrained` (see the `llama-3.2-webgpu` /
 * `phi-3.5-webgpu` workers, which run `generate({ ...tokenizer('a'), max_new_tokens: 1 })`), and
 * something this app was missing.
 *
 * It matters more here than in those examples. WebGPU compiles a model's shaders lazily, on first
 * use, so without this the very first turn pays for all of that *and* a prefill over this app's
 * DM prompt — persona, difficulty rules, the whole sheet snapshot, rolling summary, six recent
 * turns and the state contract, i.e. thousands of tokens where those examples send a short chat
 * message. That combined burst is the single heaviest thing this app ever asks of the GPU, and on
 * a mobile driver a long enough burst gets reset out from under the page ("Device is lost").
 * Splitting it in two — compile here on a 1-token input, prefill later — is the cheap half of the
 * mitigation. (The other half is moving generation off the main thread into a Worker, as those
 * same examples do.)
 *
 * Deliberately non-fatal: a model whose warm-up trips but whose real generation would have worked
 * shouldn't be bricked by this, and the failure resurfaces immediately at generation time anyway,
 * where it's reported properly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function warmUp(processor: any, model: any, usesProcessor: boolean): Promise<void> {
  try {
    const tokenizer = processor.tokenizer ?? processor
    const inputs = usesProcessor ? await processor('a') : await tokenizer('a')
    await model.generate({ ...inputs, max_new_tokens: 1 })
  } catch {
    // Intentionally ignored — see above.
  }
}

/** Lets Settings show whether a given model still needs downloading, without triggering it. */
export function getLocalModelLoadState(modelId: LocalModelId): 'unloaded' | 'loading' | 'ready' {
  const state = modelStates.get(modelId)
  if (!state) return 'unloaded'
  if (state.isReady) return 'ready'
  return state.loadPromise ? 'loading' : 'unloaded'
}

function loadModel(modelId: LocalModelId, onProgress?: (p: LocalModelLoadProgress) => void): Promise<LoadedModel> {
  const state = getModelState(modelId)
  if (onProgress) {
    state.progressListeners.add(onProgress)
    if (state.lastProgress) onProgress(state.lastProgress)
  }
  if (!state.loadPromise) {
    requestPersistentStorage()
    state.loadPromise = (async () => {
      const { AutoModelForCausalLM, AutoProcessor, AutoTokenizer, env } = await import('@huggingface/transformers')
      const { localModelCache } = await import('./localModelCache')
      const { createResumableFetch } = await import('./localModelResumableFetch')
      const info = LOCAL_MODELS[modelId]
      // See localModelCache.ts for why this replaces the library's default Cache Storage-backed
      // caching — without it, this download would repeat on every page load/generation.
      env.useCustomCache = true
      env.customCache = localModelCache
      // See localModelResumableFetch.ts — resumes an interrupted download from where it left off
      // (e.g. after a page refresh) instead of restarting from byte 0. Wraps the real global
      // fetch directly rather than env.fetch (whose declared type in this library is narrower
      // than the standard fetch signature) — env.fetch defaults to it anyway.
      env.fetch = createResumableFetch(fetch)
      // The tokenizer/processor and model are two separate from_pretrained() calls, each
      // downloading their own set of files but sharing one progress_callback —
      // createProgressAggregator combines both into a single monotonic byte-based percentage
      // instead of each file's own progress (see its doc comment for why raw per-file progress is
      // actively misleading here). broadcastProgress fans out to every attached listener rather
      // than whichever one call to loadModel() happened to be first, so it always runs, listener
      // or not. stripUnusedComponents corrects progress_total's estimate for Gemma 4 E2B's
      // text-only load before the aggregator sees it (a no-op for every other model).
      const aggregateProgress = createProgressAggregator((p) => broadcastProgress(state, p))
      const progressCallback = (p: LocalModelLoadProgress) => aggregateProgress(stripUnusedComponents(p))
      const [processor, model] = await Promise.all([
        info.usesProcessor
          ? AutoProcessor.from_pretrained(modelId, { progress_callback: progressCallback })
          : AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCallback }),
        // AutoModelForCausalLM resolves each model's *ForCausalLM class from its config's
        // model_type — for a model whose native architecture is already a plain causal LM (every
        // model here except Gemma 4 E2B), that's a no-op. For Gemma 4 E2B specifically, whose
        // native architecture is Gemma4ForConditionalGeneration (a genuinely multimodal
        // checkpoint — text decoder + token embeddings + a vision encoder + an audio encoder),
        // resolving to the sibling Gemma4ForCausalLM class instead triggers this library's
        // documented cross-architecture "text-only" loading path (see resolveTypeConfig/
        // MODEL_SESSION_CONFIG in the installed package's modeling_utils.js/session_config.js),
        // which skips fetching (and allocating) the vision/audio encoder sessions entirely —
        // confirmed against the model repo's file listing and this library's session-selection
        // logic, not a guess. This app's DM narrator only ever sends { type: 'text' } content
        // (see generateLocalReply below), never images or audio, so that's safe for every model
        // here regardless of whether it's technically capable of more.
        AutoModelForCausalLM.from_pretrained(modelId, {
          dtype: 'q4f16',
          device: 'webgpu',
          progress_callback: progressCallback,
        }),
      ])
      await warmUp(processor, model, info.usesProcessor)
      return { processor, model }
    })()
    state.loadPromise.then(
      () => {
        state.isReady = true
        state.progressListeners.clear()
      },
      // Don't cache a failed load — let the next attempt (e.g. after enabling WebGPU) retry cleanly.
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
  if (!isLocalModelSupported()) {
    throw new Error("This browser doesn't support WebGPU, which the local model needs to run.")
  }
  await loadModel(modelId, onProgress)
}

/** Whether a model's files are already cached on disk, regardless of whether this page session
 * has loaded them into memory yet — lets Settings show accurate "downloaded" state on a fresh
 * page load instead of only ever knowing about downloads from the current session. */
export async function hasDownloadedLocalModel(modelId: LocalModelId): Promise<boolean> {
  if (modelStates.get(modelId)?.isReady) return true
  const { hasCachedLocalModelFiles } = await import('./localModelCache')
  return hasCachedLocalModelFiles(modelId)
}

/** Whether a model has an interrupted/incomplete download sitting on disk — distinct from fully
 * cached, so Settings can offer to clear it even though the model was never actually usable. */
export async function hasPartiallyDownloadedLocalModel(modelId: LocalModelId): Promise<boolean> {
  const { hasPartialModelDownload } = await import('./localModelResumableFetch')
  return hasPartialModelDownload(modelId)
}

/** Removes a model from this device (both its complete-file cache and any in-progress partial
 * download), freeing the space it takes up, and resets its in-memory state so the next
 * generation/preload re-downloads from scratch rather than reusing a stale reference. Other
 * models' cached data is untouched. */
export async function removeLocalModel(modelId: LocalModelId): Promise<void> {
  const [{ clearLocalModelCache }, { clearPartialModelDownload }] = await Promise.all([
    import('./localModelCache'),
    import('./localModelResumableFetch'),
  ])
  await Promise.all([clearLocalModelCache(modelId), clearPartialModelDownload(modelId)])
  modelStates.delete(modelId)
}

/** Shared with Settings' manual "download now" button so both places describe load progress
 * (and eventual failures) the same way. */
export function describeLocalModelProgress(p: LocalModelLoadProgress): string {
  return describeModelDownloadProgress(p, 'local model')
}

/** ONNX Runtime surfaces a lost GPU device as a wall of C++ file paths and buffer-manager
 * internals ("buffer_manager.cc:553 ... Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is
 * lost"), which tells a player nothing they can act on. Everything else is passed through as-is
 * rather than guessed at. */
function describeGenerationFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/device.{0,20}(is )?lost|mapAsync/i.test(raw)) {
    return (
      "This device's GPU dropped the model mid-reply. That usually means the generation was too " +
      'heavy for it, or the screen locked or another app claimed the GPU while it ran. Keep the ' +
      'screen on and retry — if it keeps happening, pick a smaller model in Settings.'
    )
  }
  return raw
}

export interface GenerateLocalReplyOptions {
  onLoadProgress?: (p: LocalModelLoadProgress) => void
  /** Called with the accumulated reply text as tokens stream in — generation on a phone GPU can
   * take a while, so showing live progress matters more here than for a cloud API call. */
  onToken?: (textSoFar: string) => void
}

export async function generateLocalReply(
  modelId: LocalModelId,
  prompt: string,
  opts: GenerateLocalReplyOptions = {},
): Promise<string> {
  if (!isLocalModelSupported()) {
    throw new Error("This browser doesn't support WebGPU, which the local model needs to run.")
  }

  const { TextStreamer } = await import('@huggingface/transformers')
  const { processor, model } = await loadModel(modelId, opts.onLoadProgress)

  // Gemma 4 E2B's chat template is processor-based and expects `content` as a list of typed parts
  // (to accommodate images/audio, even though this app never sends any); every other model here
  // uses a plain AutoTokenizer, whose chat template expects `content` as a plain string.
  const usesProcessor = LOCAL_MODELS[modelId].usesProcessor
  const history = [{ role: 'user', content: usesProcessor ? [{ type: 'text', text: prompt }] : prompt }]
  const templated = processor.apply_chat_template(history, {
    enable_thinking: false,
    add_generation_prompt: true,
  })
  // The two loaders' apply_chat_template defaults are opposites, and nothing about the call site
  // shows it: Processor.apply_chat_template forces `tokenize: false` (processing_utils.js) and
  // returns a *string*, which the processor call below turns into tensors; PreTrainedTokenizer.
  // apply_chat_template defaults to `tokenize: true` and has already returned the finished
  // `{ input_ids, attention_mask }`. Feeding that dict back through the tokenizer doesn't throw —
  // it silently yields input_ids with dims [1, 0], and generation then fails deep inside the ONNX
  // graph ("The input tensor cannot be reshaped to the requested shape", with a 0 where the
  // sequence length should be) rather than anywhere near the actual mistake.
  //
  // Using the tokenizer's dict directly is also the more faithful of the two options: internally
  // it tokenizes with `add_special_tokens: false`, because the chat template has already placed
  // every special token it wants. Re-tokenizing the rendered string instead would default to
  // `add_special_tokens: true` and prepend a second BOS for the models whose template already
  // starts with one (Gemma 3 and Llama 3.2, among those in LOCAL_MODELS).
  const inputs = usesProcessor ? await processor(templated) : templated

  // Cheap guard for an otherwise near-undebuggable class of failure: anything that leaves the
  // prompt empty (a chat template that renders to nothing, a future loader whose
  // apply_chat_template contract differs again) doesn't fail here — it fails several layers down
  // as an ONNX Runtime reshape error naming tensor dimensions with no obvious connection to the
  // prompt. Fail at the point the mistake actually happened instead.
  if (!(inputs?.input_ids?.dims?.at(-1) > 0)) {
    throw new Error(`Building the prompt for ${modelId} produced no tokens — this is a bug, not a model failure.`)
  }

  let fullReply = ''
  const streamer = new TextStreamer(processor.tokenizer ?? processor, {
    skip_prompt: true,
    callback_function: (token: string) => {
      fullReply += token
      opts.onToken?.(fullReply)
    },
  })

  try {
    await model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: true,
      temperature: 0.7,
      streamer,
    })
  } catch (err) {
    // A WebGPU device can be lost mid-generation — the driver resets under a long compute burst,
    // the GPU process is reclaimed under memory pressure, or the page is backgrounded. It is not
    // recoverable for the session built on it: every later call fails identically. Since the
    // loaded model is cached module-level, leaving it in place means "Retry" reuses the dead
    // session and can never succeed, so the only way out would be a full page reload. Dropping
    // the cached state makes the next attempt rebuild from the already-downloaded files instead
    // (no re-download — removeLocalModel is what clears those, and this deliberately isn't that).
    modelStates.delete(modelId)
    throw new Error(describeGenerationFailure(err))
  }

  if (!fullReply.trim()) {
    throw new Error('The local model produced no text — try again.')
  }
  return fullReply
}
