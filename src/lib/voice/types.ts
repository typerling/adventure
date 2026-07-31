/**
 * Voice provider interfaces (DESIGN.md §8) — swappable per-function in Settings. Only the
 * `browser` implementation exists so far (Web Speech API, zero config); `elevenlabs` and
 * `huggingface-local` are Phase 2 follow-ups and stay disabled in Settings until implemented.
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

export interface TtsProvider {
  /** Speaks the given text, resolving when playback finishes (or rejecting on error). Cancels
   * any speech already in progress from this provider first — only one utterance plays at a time. */
  speak(text: string, opts?: { voice?: string }): Promise<void>
  stop(): void
}
