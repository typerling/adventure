/**
 * Runs on-device model loading and generation off the main thread.
 *
 * Every official transformers.js WebGPU example (`llama-3.2-webgpu`, `phi-3.5-webgpu`, …) puts the
 * model in a dedicated worker, and this app was the odd one out in driving it from the main thread.
 * Generation is a long, unbroken stretch of work; on the main thread it competes with React
 * rendering and the compositor, which on a phone means the UI locks up for the whole turn — the
 * "read aloud" controls, the streaming preview and the cancel affordance all stop responding
 * precisely while the player most wants them.
 *
 * The worker owns the loaded models. localModel.ts keeps the UI-facing state (progress listeners,
 * per-model load status) and talks to this over the protocol in localModelWorkerProtocol.ts.
 *
 * Nothing here may touch `window` or the DOM. `navigator.storage.persist()` in particular is
 * Window-only, which is why localModel.ts calls it on the main thread before asking for a load.
 */

import type { LocalModelId } from '@/types/campaign'
import {
  LOCAL_MODELS,
  LOCAL_MODEL_CPU_DTYPE,
  LOCAL_MODEL_GPU_DTYPE,
  MAX_NEW_TOKENS,
  type LocalModelDevice,
} from './localModelCatalog'
import { createProgressAggregator, type ModelDownloadProgress } from '@/lib/modelDownloadProgress'
import type { WorkerRequest, WorkerResponse } from './localModelWorkerProtocol'

// Typed view of the worker global rather than a `/// <reference lib="webworker" />`, which would
// pull the WorkerGlobalScope lib into a project otherwise compiled against the DOM lib and produce
// conflicting global declarations.
const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void
  addEventListener(type: 'message', handler: (event: MessageEvent<WorkerRequest>) => void): void
}

function post(message: WorkerResponse): void {
  ctx.postMessage(message)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedModel = { processor: any; model: any }

/** Keyed by `${modelId}::${device}` — the GPU and CPU builds of one model are different files and
 * different sessions, so a fallback must not collide with the WebGPU entry it's replacing. */
const loaded = new Map<string, Promise<LoadedModel>>()

function keyFor(modelId: string, device: LocalModelDevice): string {
  return `${modelId}::${device}`
}

const UNUSED_TEXT_ONLY_FILE_PATTERN = /vision_encoder|audio_encoder/

/** @huggingface/transformers' upfront `progress_total` estimate is computed purely from the
 * checkpoint's own config — for Gemma 4 E2B it never receives the `textOnly` flag that loading it
 * as a CausalLM triggers, so it still counts the vision/audio encoder files even though they're
 * never fetched. Left alone the aggregate would stall near ~91% and jump straight to ready without
 * visibly reaching 100%. Every other model is natively text-only, so this is a harmless no-op for
 * them — applied unconditionally rather than as a model-specific branch. */
function stripUnusedComponents(p: ModelDownloadProgress): ModelDownloadProgress {
  if (p.status !== 'progress_total' || !p.files) return p
  let loadedBytes = 0
  let total = 0
  const files: Record<string, { loaded: number; total: number }> = {}
  for (const [file, f] of Object.entries(p.files)) {
    if (UNUSED_TEXT_ONLY_FILE_PATTERN.test(file)) continue
    files[file] = f
    loadedBytes += f.loaded
    total += f.total
  }
  return { ...p, files, loaded: loadedBytes, total, progress: total > 0 ? (loadedBytes / total) * 100 : p.progress }
}

/**
 * One throwaway single-token generation before a model is reported ready — what the official
 * WebGPU examples do after `from_pretrained`. WebGPU compiles shaders lazily on first use, so
 * without this the first real turn pays for all of that *and* a prefill over this app's
 * multi-thousand-token DM prompt in one burst; a long enough burst gets reset out from under the
 * page by a mobile driver. Deliberately non-fatal: a model whose warm-up trips but whose real
 * generation would have worked shouldn't be bricked by it, and a genuine problem resurfaces at
 * generation time where it's reported properly.
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

function loadModel(modelId: LocalModelId, device: LocalModelDevice): Promise<LoadedModel> {
  const key = keyFor(modelId, device)
  const existing = loaded.get(key)
  if (existing) return existing

  const promise = (async () => {
    const { AutoModelForCausalLM, AutoProcessor, AutoTokenizer, env } = await import('@huggingface/transformers')
    const { localModelCache } = await import('./localModelCache')
    const { createResumableFetch } = await import('./localModelResumableFetch')
    const info = LOCAL_MODELS[modelId]

    // See localModelCache.ts for why this replaces the library's default Cache Storage-backed
    // caching, and localModelResumableFetch.ts for resuming an interrupted download rather than
    // restarting it from byte 0.
    env.useCustomCache = true
    env.customCache = localModelCache
    env.fetch = createResumableFetch(fetch)

    const aggregate = createProgressAggregator((p) => post({ kind: 'progress', modelId, progress: p }))
    const progress_callback = (p: ModelDownloadProgress) => aggregate(stripUnusedComponents(p))

    const [processor, model] = await Promise.all([
      info.usesProcessor
        ? AutoProcessor.from_pretrained(modelId, { progress_callback })
        : AutoTokenizer.from_pretrained(modelId, { progress_callback }),
      // AutoModelForCausalLM resolves each model's *ForCausalLM class from its config's
      // model_type — a no-op for a model whose native architecture is already a plain causal LM
      // (everything here except Gemma 4 E2B). For Gemma 4 E2B, whose native architecture is the
      // genuinely multimodal Gemma4ForConditionalGeneration, resolving to the sibling
      // Gemma4ForCausalLM triggers this library's documented cross-architecture "text-only"
      // loading path, which skips fetching and allocating the vision/audio encoder sessions
      // entirely. This app only ever sends text, so that's safe for every model here.
      AutoModelForCausalLM.from_pretrained(modelId, {
        dtype: device === 'webgpu' ? LOCAL_MODEL_GPU_DTYPE : LOCAL_MODEL_CPU_DTYPE,
        device,
        progress_callback,
      }),
    ])
    await warmUp(processor, model, info.usesProcessor)
    return { processor, model }
  })()

  loaded.set(key, promise)
  // Don't cache a failed load — let the next attempt retry cleanly instead of replaying the error.
  promise.catch(() => loaded.delete(key))
  return promise
}

/** A lost GPU device is unrecoverable for the session built on it: every later call against that
 * session fails the same way, so the only route forward is a different backend. Matched on the
 * message because ONNX Runtime surfaces it as plain text from its C++ layer, with no error code to
 * branch on. */
function isDeviceLost(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  return /device.{0,20}(is )?lost|mapAsync|GPUDevice|createBindGroup/i.test(raw)
}

async function runGeneration(
  requestId: number,
  modelId: LocalModelId,
  prompt: string,
  device: LocalModelDevice,
): Promise<string> {
  const { TextStreamer } = await import('@huggingface/transformers')
  const { processor, model } = await loadModel(modelId, device)

  // Gemma 4 E2B's chat template is processor-based and expects `content` as a list of typed parts;
  // every other model uses a plain AutoTokenizer, whose template expects a plain string.
  const usesProcessor = LOCAL_MODELS[modelId].usesProcessor
  const history = [{ role: 'user', content: usesProcessor ? [{ type: 'text', text: prompt }] : prompt }]
  const templated = processor.apply_chat_template(history, {
    enable_thinking: false,
    add_generation_prompt: true,
  })
  // The two loaders' apply_chat_template defaults are opposites: Processor forces `tokenize: false`
  // and returns a string for the processor call below to turn into tensors, while
  // PreTrainedTokenizer defaults to `tokenize: true` and has already returned the finished
  // `{ input_ids, attention_mask }`. Feeding that dict back through the tokenizer doesn't throw —
  // it silently yields input_ids with dims [1, 0], and generation then dies inside the ONNX graph
  // with a reshape error nowhere near the actual mistake. Using the dict directly is also the more
  // faithful option: it was tokenized with `add_special_tokens: false`, because the chat template
  // has already placed every special token it wants; re-tokenizing the rendered string would
  // default to `true` and prepend a duplicate BOS for Gemma 3 and Llama 3.2.
  const inputs = usesProcessor ? await processor(templated) : templated

  if (!(inputs?.input_ids?.dims?.at(-1) > 0)) {
    throw new Error(`Building the prompt for ${modelId} produced no tokens — this is a bug, not a model failure.`)
  }

  let fullReply = ''
  const streamer = new TextStreamer(processor.tokenizer ?? processor, {
    skip_prompt: true,
    callback_function: (token: string) => {
      fullReply += token
      post({ kind: 'token', requestId, text: fullReply })
    },
  })

  await model.generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: true,
    temperature: 0.7,
    streamer,
  })

  if (!fullReply.trim()) throw new Error('The local model produced no text — try again.')
  return fullReply
}

/**
 * Generation with a one-shot CPU fallback. If the GPU drops the model mid-reply, the WebGPU
 * session is dead and retrying on it can only fail again — so the model is re-loaded on the WASM
 * backend and the turn is finished there instead of handing the player an error.
 *
 * The fallback is not free and the UI is told about it (`kind: 'backend'`) rather than silently
 * going slow: the CPU build is a *different quantization file*, so it downloads the model again,
 * and generation runs in minutes rather than seconds. Only attempted when the GPU was the thing
 * that failed — a bad prompt or an out-of-memory abort would fail identically on the CPU, just far
 * more slowly.
 */
async function generate(requestId: number, modelId: LocalModelId, prompt: string, preferred: LocalModelDevice) {
  if (preferred === 'wasm') {
    post({ kind: 'backend', modelId, device: 'wasm' })
    return runGeneration(requestId, modelId, prompt, 'wasm')
  }
  try {
    return await runGeneration(requestId, modelId, prompt, 'webgpu')
  } catch (err) {
    if (!isDeviceLost(err)) throw err
    loaded.delete(keyFor(modelId, 'webgpu'))
    post({ kind: 'backend', modelId, device: 'wasm' })
    return runGeneration(requestId, modelId, prompt, 'wasm')
  }
}

ctx.addEventListener('message', (event) => {
  const message = event.data
  const fail = (err: unknown) =>
    post({
      kind: 'error',
      requestId: message.requestId,
      message: err instanceof Error ? err.message : String(err),
      deviceLost: isDeviceLost(err),
    })

  switch (message.kind) {
    case 'load':
      // A preload only ever warms the backend the caller expects to use; it never falls back,
      // since a fallback here would silently download a second copy of the model from a Settings
      // button that said nothing about it.
      loadModel(message.modelId, message.device)
        .then(() => post({ kind: 'done', requestId: message.requestId }))
        .catch(fail)
      break
    case 'generate':
      generate(message.requestId, message.modelId, message.prompt, message.device)
        .then((reply) => post({ kind: 'done', requestId: message.requestId, reply }))
        .catch(fail)
      break
    case 'evict':
      for (const device of ['webgpu', 'wasm'] as const) loaded.delete(keyFor(message.modelId, device))
      post({ kind: 'done', requestId: message.requestId })
      break
  }
})
