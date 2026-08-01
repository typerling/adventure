/**
 * The on-device model catalog, split out from localModel.ts so that both sides of the worker
 * boundary can read it: localModel.ts is now a thin proxy that *constructs* the worker, so the
 * worker importing it would spawn a worker from inside a worker, recursively. Nothing here touches
 * `window`, `navigator`, or `@huggingface/transformers` — it's plain data, safe in either context.
 */

import type { LocalModelId } from '@/types/campaign'

/** Cap on a single reply's length. One DM turn is prose plus a trailing ```state block, so this
 * has to leave room for both — a reply truncated before its state block fails validation and the
 * whole generation is wasted. */
export const MAX_NEW_TOKENS = 1024

export interface LocalModelInfo {
  label: string
  /** Approximate total download size (decoder + tokenizer + small config files) at the q4f16
   * quantization this app requests for WebGPU — for the picker/download cards, not exact byte
   * accounting. Measured against each repo's actual `onnx/` file listing on Hugging Face. The CPU
   * fallback (see LOCAL_MODEL_CPU_DTYPE) pulls a different, separately-sized file. */
  sizeBytes: number
  /** Only the Gemma 4 E2B checkpoint ships a real `preprocessor_config.json` — it's a genuinely
   * multimodal-capable checkpoint, loaded in text-only mode (see the `AutoModelForCausalLM`
   * comment in the worker's loadModel). `AutoProcessor.from_pretrained()` throws for any repo
   * without one, so every other (natively text-only) model here uses a plain `AutoTokenizer`
   * instead — and its chat template expects `content` as a plain string, not a list of parts,
   * unlike the processor's. */
  usesProcessor: boolean
}

/**
 * The quantization requested when running on the GPU. fp16 weights with 4-bit block quantization —
 * the smallest of the widely-available variants, and the one every official transformers.js WebGPU
 * example uses.
 */
export const LOCAL_MODEL_GPU_DTYPE = 'q4f16'

/**
 * The quantization requested when falling back to the CPU/WASM backend. Deliberately *not*
 * `q4f16`: fp16 is a GPU-oriented format, and `q8` is what @huggingface/transformers itself
 * defaults to for the wasm device (DEFAULT_DEVICE_DTYPE_MAPPING in its utils/dtypes.js). It maps
 * to each repo's `model_quantized.onnx` (DEFAULT_DTYPE_SUFFIX_MAPPING), which — unlike `int8` —
 * is present for every model in this catalog including Gemma 4 E2B's split components, verified
 * against each repo's file listing.
 *
 * Consequence worth knowing: it is a *different file* from the GPU one, so falling back to the CPU
 * means downloading the model again at a different quantization, not reusing what's on disk.
 */
export const LOCAL_MODEL_CPU_DTYPE = 'q8'

/** The filename suffix each dtype above resolves to, mirroring @huggingface/transformers'
 * DEFAULT_DTYPE_SUFFIX_MAPPING (utils/dtypes.js). Needed on the main thread — which never imports
 * that library — to tell whether the build a given backend actually needs is already on disk. */
export const LOCAL_MODEL_DTYPE_SUFFIX: Record<LocalModelDevice, string> = {
  webgpu: '_q4f16',
  wasm: '_quantized',
}

/** Ordered smallest to largest. Gemma 4 E2B is kept as the largest/highest-quality option since
 * it's what this app shipped with first; the rest were added specifically because that one crashed
 * low-memory devices around ~2GB downloaded. */
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

/** Which backend a model ran on. Surfaced so the UI can say why a turn suddenly got slow, and
 * persisted so a device that has already proven it can't sustain WebGPU doesn't rediscover that
 * (and pay for a failed generation) on every single turn. */
export type LocalModelDevice = 'webgpu' | 'wasm'
