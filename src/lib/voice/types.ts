/**
 * Voice provider interfaces (DESIGN.md §8) — swappable per-function in Settings. All are
 * implemented: STT via `browser` (Web Speech API) or `elevenlabs`; TTS via `browser`,
 * `elevenlabs`, or `huggingface-local` (Kokoro, on-device — see kokoroTts.ts).
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
  speak(
    text: string,
    opts?: {
      voice?: string
      /** Fired 'loading' as soon as speak() is called (fetching/generating audio), then 'playing'
       * once audio has actually started — lets callers show a spinner instead of a control that
       * looks unresponsive while, e.g., an ElevenLabs request or a Kokoro model load is in flight. */
      onStateChange?: (state: 'loading' | 'playing') => void
    },
  ): Promise<void>
  /** Pauses mid-utterance without discarding it — a subsequent resume() continues from here. */
  pause(): void
  /** Resumes a paused utterance. A no-op if nothing is paused. */
  resume(): void
  stop(): void
}
