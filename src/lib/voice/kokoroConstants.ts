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

/** kokoro-js's own hardcoded Cache Storage bucket for per-voice style files (voices/<id>.bin) —
 * named separately from CACHE_NAMES below so kokoroTts.worker.ts's voice-prefetch (issue #66) can
 * target it directly without importing the whole array just for its first element. Verified against
 * the installed kokoro-js@1.2.1 source: its internal (unexported) per-voice fetch helper opens
 * exactly this bucket name before falling back to a live `fetch()` — see kokoroTts.worker.ts's
 * `prefetchVoices` doc comment for why replicating that same fetch+cache.put ourselves, ahead of
 * time, is a genuine prefetch and not just a duplicate download. */
export const KOKORO_VOICES_CACHE_NAME = 'kokoro-voices'

/** Cache Storage buckets kokoro-js and its bundled transformers write into — cleared together by
 * removeKokoroModel(). 'kokoro-voices' is kokoro's own hardcoded per-voice cache; the other is
 * its transformers copy's default model cache (env.cacheKey). Cache Storage is a per-origin store
 * shared between the main thread and any Worker on that origin, so these buckets are the same
 * whether the download happened via the worker (kokoroTts.worker.ts) or were seeded any other way. */
export const CACHE_NAMES = [KOKORO_VOICES_CACHE_NAME, 'transformers-cache']

/**
 * Default Kokoro `speed` multipliers for narration vs. dialogue (issue #66, item 3/4 of the
 * multi-voice-playback ask: "calmer narration, more expressive dialogue"). `generate(text, {voice,
 * speed})`'s `speed` is a bare float32 multiplier fed straight into the model with no documented
 * safe range (see contract.ts's/voiceCasting.ts's research notes) — kept deliberately close to
 * Kokoro's own default of 1 (a narrow band, per the issue's explicit warning that an aggressive
 * value distorts audio) rather than a dramatic swing.
 *
 * **Not verified by ear in this sandbox** — this environment has no real audio output device (see
 * this file's KOKORO_WEBGPU_DTYPE doc comment for the identical limitation blocking a WebGPU audio
 * listen test), so these two values are a conservative starting point pending the project owner's
 * real listen test (this ticket's own Definition of Done), not a tuned-by-ear final answer. Easy to
 * adjust here alone if that test finds the gap too subtle or too much.
 */
export const KOKORO_NARRATION_SPEED = 0.95
export const KOKORO_DIALOGUE_SPEED = 1.05

/**
 * Silence inserted between consecutive chunks whose resolved voice differs (issue #66) — arithmetic
 * on kokoroTts.ts's own `nextStartTime` playback cursor, no model call needed (per the issue's own
 * suggestion). Asymmetric per the issue's suggestion ("consider a slightly longer beat entering
 * dialogue than leaving it"): entering a non-narrator voice gets the longer beat,
 * returning to the narrator's voice gets the shorter one. Same "not verified by ear" caveat as the
 * speed constants above.
 */
export const KOKORO_ENTER_DIALOGUE_PAUSE_SEC = 0.35
export const KOKORO_EXIT_DIALOGUE_PAUSE_SEC = 0.2

/**
 * How many chunks kokoroTts.ts's speak() buffers (generated but not yet scheduled) before starting
 * playback of a turn — issue #68's follow-up to #62's "start on chunk 1" design, a deliberate
 * middle ground between #44's "wait for the whole turn" and #62's "wait for nothing." See
 * kokoroTts.ts's "Startup playback buffer" doc comment section for the full reasoning, including
 * the real (unfaked) generation-speed measurement this value is based on and how it was
 * re-verified against the multi-voice chunk model (issue #66) this constant now operates inside of.
 *
 * 2, not more: issue #68's own probe (real Kokoro CPU inference via kokoro-js's Node build on
 * onnxruntime-node — a *conservative lower bound* on in-browser WASM's real cost, not literally
 * WASM; see kokoroTts.worker.ts's doc comment for that same caveat elsewhere in this file) has now
 * been measured three separate times across this ticket's history, on three different (shared,
 * noisy) sandboxes, landing on both sides of real-time: the original PR's own run found generation
 * at ~0.7x of each chunk's own audio duration (a thin ~30% margin); an independent reviewer's
 * re-run found the opposite, ~1.2x-2.4x (slower than real-time), under a sandbox they reported as
 * heavily loaded (`uptime` load average 9-11 on a shared 4-core box); this reconciliation's own
 * fresh re-run (three chunks, two voices, verifying the multi-voice chunk shape specifically) found
 * ~1.45x-1.77x (mean 1.62x — also slower than real-time). None of the three pins down a
 * device-independent number — this is a measurement of shared, noisy sandboxes, not a real device
 * — but two of three runs landing clearly on the *slower*-than-real-time side, not just close to
 * parity, is itself informative: it means "falling behind" isn't a marginal, easily-avoided risk on
 * this backend, it's the default outcome, and only real device hardware (a strict upgrade from a
 * shared CI sandbox running other work) plus real in-browser WASM (rather than this conservative
 * native-CPU stand-in) can be expected to do better. A margin that thin and inconsistent — genuinely
 * behind real-time on this backend more often than not — is still the most plausible explanation
 * this investigation could find for reported playback artifacts, once real generated audio ruled
 * out a chunk-boundary silence-padding defect (see kokoroTts.ts). One chunk of head
 * start (today's implicit buffer of 1, since nothing plays before chunk 0 finishes) leaves no
 * margin at all for chunk 1 to keep up with chunk 0's own playback; 2 buffered chunks means chunk 2
 * has an entire chunk 0 playback duration's worth of extra generation time before it's needed,
 * without reintroducing anything close to #44's tens-of-seconds full-turn wait. Buffering interacts
 * *well*, not adversarially, with issue #66's voice-change pauses above: a pause inserted between
 * two differently-voiced buffered chunks only adds to the real-time margin generation gets before
 * the next chunk is needed, never subtracts from it.
 *
 * Worth being honest about what this does and doesn't fix, given the measurements above: a device
 * on which generation runs *chronically* slower than real-time (not just momentarily, on the first
 * chunk) will still fall behind eventually no matter how large this buffer is — buffering delays
 * and narrows the exposure window, it doesn't change the underlying generation-vs-playback race for
 * a device that genuinely can't keep up. What it reliably fixes is the *zero-margin first chunk*
 * case (today's real starting point, buffer-of-1), which is strictly worse than any buffer ≥2
 * regardless of a given device's steady-state ratio.
 */
export const KOKORO_PLAYBACK_BUFFER_CHUNKS = 2
