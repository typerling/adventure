/**
 * Constants shared between kokoroTts.ts (main thread) and kokoroTts.worker.ts.
 *
 * Kept in their own module, rather than living in kokoroTts.ts, for the same reason
 * localModelCatalog.ts is split out from localModel.ts: the worker importing kokoroTts.ts directly
 * would recursively try to construct another worker, since that module's job is to construct one.
 */

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

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
