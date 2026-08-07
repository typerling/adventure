/**
 * Constants shared between kokoroTts.ts (main thread) and kokoroTts.worker.ts.
 *
 * Kept in their own module, rather than living in kokoroTts.ts, for the same reason
 * localModelCatalog.ts is split out from localModel.ts: the worker importing kokoroTts.ts directly
 * would recursively try to construct another worker, since that module's job is to construct one.
 */

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/** Which backend Kokoro runs generation on. Unlike the local text models (LocalModelDevice in
 * localModelCatalog.ts), there is no per-model dimension here — Kokoro is exactly one model, so
 * this is a single global preference, not something keyed by model id. */
export type KokoroDevice = 'wasm' | 'webgpu'

/**
 * The dtype requested on the WASM backend — unchanged from before this file existed. `q8` is
 * `@huggingface/transformers`' own default for the wasm device (DEFAULT_DEVICE_DTYPE_MAPPING in
 * its utils/dtypes.js) and maps to `model_quantized.onnx` (92.4 MB on
 * onnx-community/Kokoro-82M-v1.0-ONNX).
 */
export const KOKORO_WASM_DTYPE = 'q8'

/**
 * The dtype requested on the opt-in WebGPU backend (issue #51).
 *
 * Investigated before picking this, rather than blindly following kokoro-js's README (which
 * recommends `fp32` for `device: 'webgpu'`) or assuming a smaller quantized variant "should" work:
 *
 * - `q8f16` (86 MB on the HF repo, the smallest quantized candidate) is **not a usable dtype at
 *   all** with the installed kokoro-js@1.2.1 (bundled `@huggingface/transformers` 3.8.1, a
 *   *different* copy from this app's own v4 — see kokoroTts.ts's caching-caveat doc comment).
 *   Verified by reading that copy's `src/utils/dtypes.js`: its `DATA_TYPES` enum is `{ auto, fp32,
 *   fp16, q8, int8, uint8, q4, bnb4, q4f16 }` — no `q8f16` entry — and `models.js`'s shared
 *   `getSession()` (used by every `from_pretrained()` call, including kokoro-js's
 *   `StyleTextToSpeech2Model`) throws `Invalid dtype: q8f16. Should be one of: ...` for anything
 *   not in that table. This isn't a quality judgment call, it's a hard capability gap in the
 *   installed version — ruled out before ever reaching a "does it sound good" question.
 * - `q4f16` (155 MB) *is* a valid dtype in the same table, and is exactly what this app's own
 *   local text models already request for their WebGPU path (`LOCAL_MODEL_GPU_DTYPE` in
 *   `localModelCatalog.ts`) — a working precedent for this exact dtype on this exact
 *   onnxruntime-web/transformers stack. But that precedent is for a text decoder's logits, not a
 *   vocoder's raw waveform output — quantization artifacts are a different (and less
 *   forgiving-to-the-ear) failure mode for audio than for text, so "it works for the text models"
 *   doesn't settle whether it *sounds* fine here.
 * - A real listen test was the plan, but this environment cannot get a WebGPU adapter at all:
 *   headless Chromium here reports `navigator.gpu === undefined` regardless of
 *   `--enable-unsafe-webgpu`, `--enable-unsafe-swiftshader`, `--use-angle=swiftshader`,
 *   `--ignore-gpu-blocklist`, or Vulkan variants — the container has no `/dev/dri` GPU device
 *   nodes at all, one step further than PR #52's "headless Chromium crashes on large WASM/WebGPU
 *   payloads" limitation (there, a context existed and generation was attempted; here, no WebGPU
 *   context can be obtained in the first place to attempt anything). So no real audio-quality
 *   measurement was possible here, honestly, not just assumed to be fine.
 *
 * Given that — "don't just guess" — this ships `fp32` (kokoro-js's own tested README
 * recommendation, i.e. deferring to the upstream maintainers rather than guessing at an unverified
 * quantization for audio) as the safe default. `q4f16` is left as a well-understood, cheaper
 * (155 MB vs 326 MB) candidate for whoever can next verify it on real WebGPU hardware — swap this
 * one constant if a real listen test confirms it holds up.
 */
export const KOKORO_WEBGPU_DTYPE = 'fp32'

/** The filename suffix each dtype above resolves to (`@huggingface/transformers`'
 * DEFAULT_DTYPE_SUFFIX_MAPPING in utils/dtypes.js: `fp32` has no suffix, `q8` is `_quantized`).
 * Needed on the main thread — which never imports that library — to tell whether the on-disk file
 * the currently selected backend needs is already cached, mirroring
 * LOCAL_MODEL_DTYPE_SUFFIX in localModelCatalog.ts. */
export const KOKORO_DTYPE_SUFFIX: Record<KokoroDevice, string> = {
  webgpu: '',
  wasm: '_quantized',
}

/** Exported (via kokoroTts.ts) so Settings can mark this voice as the fallback in the picker
 * without duplicating the literal, and so the worker's own fallback (an unrecognized/blank voice
 * id falls back to this) stays the single source of truth. */
export const DEFAULT_VOICE = 'af_heart'

export const PROGRESS_LABEL = 'voice model'

/** Fixed phrase for Settings' per-voice preview button — short enough to generate quickly, long
 * enough to actually hear the voice's character. */
export const PREVIEW_TEXT = 'Hello, this is a preview of my voice.'

/**
 * Safety net for a single sentence long enough to still blow the model's token budget on its own
 * (see splitIntoSpeakableChunks in kokoroTts.ts). Kokoro's context is 512 tokens — 510 usable
 * phoneme tokens plus two specials, which is what the hardcoded `509` style-vector cap in its
 * `generate_from_ids` reflects. Phoneme count per character varies, and truncation past that point
 * is *silent*, so this budget is deliberately well under the ~470 English characters measured to
 * hit the limit.
 */
export const MAX_CHUNK_CHARS = 320

/** Cache Storage buckets kokoro-js and its bundled transformers write into — cleared together by
 * removeKokoroModel(). 'kokoro-voices' is kokoro's own hardcoded per-voice cache; the other is
 * its transformers copy's default model cache (env.cacheKey). Cache Storage is a per-origin store
 * shared between the main thread and any Worker on that origin, so these buckets are the same
 * whether the download happened via the worker (kokoroTts.worker.ts) or were seeded any other way. */
export const CACHE_NAMES = ['kokoro-voices', 'transformers-cache']
