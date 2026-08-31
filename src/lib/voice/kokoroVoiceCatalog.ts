/**
 * Static mirror of kokoro-js@1.2.1's built-in voice catalog (its frozen `VOICES` object, exposed
 * as `KokoroTTS.prototype.voices`) — issue #98, part of the multi-voice-narration epic (#36).
 *
 * Why this exists instead of reaching the real thing: `promptBuilder.ts`'s `buildTurnPrompt` is
 * synchronous and has to run before the Kokoro model has ever been loaded (or even downloaded) —
 * manual-bridge mode never touches Kokoro at all, and API/local AI mode can generate a turn before
 * the player has opened the voice picker even once. `kokoroTts.ts`'s own `listKokoroVoices()`
 * can't be used here because it `await`s a full model load.
 *
 * A shortcut was investigated first, per the issue: reading `node_modules/kokoro-js/dist/kokoro.js`
 * directly shows the getter is `get voices(){return $}` — a class-body accessor that never reads
 * `this`, so (confirmed empirically in Node, no browser/model needed — see
 * `tests/kokoro-voice-catalog.spec.ts`) it's reachable via
 * `Object.getOwnPropertyDescriptor(KokoroTTS.prototype, 'voices').get()` with no real instance at
 * all. That rules out "requires a loaded model," but it doesn't make it usable *here*: reaching it
 * still means importing `kokoro-js` (which imports `@huggingface/transformers` at module scope) —
 * and `kokoroTts.ts`'s own module doc comment, and CLAUDE.md's Voice section, are explicit that
 * `kokoro-js` is dynamically imported specifically so its bundled ONNX runtime never touches the
 * main bundle. `promptBuilder.ts` is imported unconditionally by every AI mode, manual included, so
 * a static import here would undo that. Hence: a checked-in catalog, not a live read.
 *
 * Kept in sync by `tests/kokoro-voice-catalog.spec.ts`, which imports the real `kokoro-js` package
 * directly in Node (no browser, no model download — same shortcut proven above) and deep-equals its
 * `voices` getter against `KOKORO_VOICE_CATALOG` below, so upstream drift (a new voice added, a
 * grade changed) fails loudly in CI instead of silently miscasting.
 */

export type KokoroVoiceLanguage = 'en-us' | 'en-gb'
export type KokoroVoiceGender = 'Male' | 'Female'

export interface KokoroVoiceCatalogEntry {
  name: string
  language: KokoroVoiceLanguage
  gender: KokoroVoiceGender
  /** Letter grade for the underlying training data quality, per kokoro-js's own metadata. */
  targetQuality: string
  /** Letter grade for the voice's overall output quality, per kokoro-js's own metadata. */
  overallGrade: string
  /** An emoji flourish kokoro-js attaches to a handful of voices (9 of 28) — purely descriptive. */
  traits?: string
}

/** Exactly the 28 voice ids kokoro-js@1.2.1 ships, in the same order/shape as its own `VOICES`
 * object — see this file's doc comment for how that was verified. */
export const KOKORO_VOICE_CATALOG: Readonly<Record<string, KokoroVoiceCatalogEntry>> = Object.freeze({
  af_heart: { name: 'Heart', language: 'en-us', gender: 'Female', traits: '❤️', targetQuality: 'A', overallGrade: 'A' },
  af_alloy: { name: 'Alloy', language: 'en-us', gender: 'Female', targetQuality: 'B', overallGrade: 'C' },
  af_aoede: { name: 'Aoede', language: 'en-us', gender: 'Female', targetQuality: 'B', overallGrade: 'C+' },
  af_bella: { name: 'Bella', language: 'en-us', gender: 'Female', traits: '🔥', targetQuality: 'A', overallGrade: 'A-' },
  af_jessica: { name: 'Jessica', language: 'en-us', gender: 'Female', targetQuality: 'C', overallGrade: 'D' },
  af_kore: { name: 'Kore', language: 'en-us', gender: 'Female', targetQuality: 'B', overallGrade: 'C+' },
  af_nicole: { name: 'Nicole', language: 'en-us', gender: 'Female', traits: '🎧', targetQuality: 'B', overallGrade: 'B-' },
  af_nova: { name: 'Nova', language: 'en-us', gender: 'Female', targetQuality: 'B', overallGrade: 'C' },
  af_river: { name: 'River', language: 'en-us', gender: 'Female', targetQuality: 'C', overallGrade: 'D' },
  af_sarah: { name: 'Sarah', language: 'en-us', gender: 'Female', targetQuality: 'B', overallGrade: 'C+' },
  af_sky: { name: 'Sky', language: 'en-us', gender: 'Female', targetQuality: 'B', overallGrade: 'C-' },
  am_adam: { name: 'Adam', language: 'en-us', gender: 'Male', targetQuality: 'D', overallGrade: 'F+' },
  am_echo: { name: 'Echo', language: 'en-us', gender: 'Male', targetQuality: 'C', overallGrade: 'D' },
  am_eric: { name: 'Eric', language: 'en-us', gender: 'Male', targetQuality: 'C', overallGrade: 'D' },
  am_fenrir: { name: 'Fenrir', language: 'en-us', gender: 'Male', targetQuality: 'B', overallGrade: 'C+' },
  am_liam: { name: 'Liam', language: 'en-us', gender: 'Male', targetQuality: 'C', overallGrade: 'D' },
  am_michael: { name: 'Michael', language: 'en-us', gender: 'Male', targetQuality: 'B', overallGrade: 'C+' },
  am_onyx: { name: 'Onyx', language: 'en-us', gender: 'Male', targetQuality: 'C', overallGrade: 'D' },
  am_puck: { name: 'Puck', language: 'en-us', gender: 'Male', targetQuality: 'B', overallGrade: 'C+' },
  am_santa: { name: 'Santa', language: 'en-us', gender: 'Male', targetQuality: 'C', overallGrade: 'D-' },
  bf_emma: { name: 'Emma', language: 'en-gb', gender: 'Female', traits: '🚺', targetQuality: 'B', overallGrade: 'B-' },
  bf_isabella: { name: 'Isabella', language: 'en-gb', gender: 'Female', targetQuality: 'B', overallGrade: 'C' },
  bm_george: { name: 'George', language: 'en-gb', gender: 'Male', targetQuality: 'B', overallGrade: 'C' },
  bm_lewis: { name: 'Lewis', language: 'en-gb', gender: 'Male', targetQuality: 'C', overallGrade: 'D+' },
  bf_alice: { name: 'Alice', language: 'en-gb', gender: 'Female', traits: '🚺', targetQuality: 'C', overallGrade: 'D' },
  bf_lily: { name: 'Lily', language: 'en-gb', gender: 'Female', traits: '🚺', targetQuality: 'C', overallGrade: 'D' },
  bm_daniel: { name: 'Daniel', language: 'en-gb', gender: 'Male', traits: '🚹', targetQuality: 'C', overallGrade: 'D' },
  bm_fable: { name: 'Fable', language: 'en-gb', gender: 'Male', traits: '🚹', targetQuality: 'B', overallGrade: 'C' },
})

export const KOKORO_VOICE_IDS: readonly string[] = Object.freeze(Object.keys(KOKORO_VOICE_CATALOG))

export function isKnownKokoroVoiceId(id: string | undefined | null): id is string {
  return typeof id === 'string' && Object.hasOwn(KOKORO_VOICE_CATALOG, id)
}

/** Compact, prompt-friendly rendering of the whole catalog — one line per voice, id first so the
 * AI can copy it verbatim into `voiceId`. 28 voices is real token cost, so this is deliberately as
 * terse as still-readable allows (no field labels beyond the header line). */
export function renderKokoroVoiceCatalog(): string {
  const lines = Object.entries(KOKORO_VOICE_CATALOG).map(([id, v]) => {
    const traits = v.traits ? ` ${v.traits}` : ''
    return `- ${id} — ${v.name}, ${v.gender}, ${v.language}, quality ${v.targetQuality}/grade ${v.overallGrade}${traits}`
  })
  return lines.join('\n')
}
