/**
 * Voice provider interfaces (DESIGN.md §8) — swappable per-function in Settings. All are
 * implemented: STT via `browser` (Web Speech API); TTS via `browser` or `huggingface-local`
 * (Kokoro, on-device — see kokoroTts.ts).
 */

export interface SttProvider {
  /** Begins listening for a single utterance. */
  start(): void
  /** Stops listening early (a no-op if not currently listening). */
  stop(): void
  /** Fired as speech is recognized — `isFinal` marks the last, settled transcript for this utterance. */
  onResult(cb: (text: string, isFinal: boolean) => void): void
  onError(cb: (message: string) => void): void
  /** Fired when listening ends, whether from silence, an error, or an explicit stop(). */
  onEnd(cb: () => void): void
}

/** One piece of text to speak with its own voice/speed, already resolved by the caller (issue #66)
 * — the TTS-provider-facing counterpart to `turnBlocks.ts`'s `SpokenSegment`. Deliberately doesn't
 * import anything from `@/types/turn` or reuse `SpokenSegment` directly: this module stays free of
 * any campaign/sheet-domain dependency (the interfaces here are meant to be provider-agnostic), so
 * the caller (`Play.tsx`, via `resolveSegmentVoices.ts`) is what maps a `SpokenSegment`'s `speaker`
 * to a concrete `voice`/`speed` before handing it to a `TtsProvider`. */
export interface TtsSpeakSegment {
  text: string
  /** A concrete voice id (e.g. a Kokoro voice like `bm_george`) for just this segment — falls back
   * to the call's own top-level `voice` opt (see TtsProvider.speak) when omitted. Meaningless to
   * the `browser` provider, which has no per-segment voice-switching capability at all — see
   * TtsProvider.speak's own doc comment. */
  voice?: string
  /** A provider-specific speed multiplier for just this segment (Kokoro's `generate(text, {voice,
   * speed})` — see kokoroConstants.ts's KOKORO_NARRATION_SPEED/KOKORO_DIALOGUE_SPEED). Ignored by
   * any provider with no notion of speed. */
  speed?: number
}

export interface TtsProvider {
  /** Speaks the given text, resolving when playback finishes (or rejecting on error). Cancels
   * any speech already in progress from this provider first — only one utterance plays at a time.
   *
   * `segments` (issue #66, additive — every implementation that predates it, and every existing
   * caller, keeps working with `text`/`voice` alone) lets a caller that already knows how to switch
   * voices mid-utterance (currently only Kokoro — see kokoroTts.ts's "Multi-voice playback" doc
   * comment) speak several speakers' lines with their own distinct voices in one call, instead of
   * one flat string in one voice. A provider with no such capability (`browser`, via the Web Speech
   * API — SpeechSynthesisUtterance has no per-range voice) MUST ignore `segments` entirely and keep
   * reading the flat `text` in its one `voice`, exactly as before this option existed — never throw
   * or drop text just because it can't honor per-segment voices. `narratorVoice`, if given, is which
   * of `segments`' voice ids is "the narrator's" — purely an optional hint a provider MAY use to
   * choose a more natural pause length around a speaker change (see kokoroTts.ts's
   * pauseForVoiceChange); ignoring it is always safe. */
  speak(text: string, opts?: { voice?: string; segments?: TtsSpeakSegment[]; narratorVoice?: string }): Promise<void>
  stop(): void
}
