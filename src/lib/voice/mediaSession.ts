/**
 * Thin wrapper over the browser's Media Session API
 * (https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) — lets Android (and
 * desktop OSes) show a real "Now Playing" media notification/lock-screen with working
 * play/pause/stop controls while a turn is being read aloud.
 *
 * Deliberately provider-agnostic: this is presentation (what the OS shows), not playback (what
 * actually plays), so it applies identically to all three `TtsProvider` implementations
 * (`browser`, `elevenlabs`, `huggingface-local`/Kokoro) regardless of whether the underlying audio
 * is `SpeechSynthesisUtterance` or a real `HTMLAudioElement`. See `Play.tsx` for the call sites —
 * every call goes through the *same* play/stop paths the app already uses (`ttsProviderRef`,
 * `toggleTurnPlayback`, the read-aloud auto-narrate effect), not a parallel mechanism.
 *
 * None of the three `TtsProvider` implementations support true pause/resume (each only exposes
 * `speak()`/`stop()` — see `types.ts`), so there is no way to genuinely resume mid-utterance.
 * `Play.tsx` reflects that honestly: its Media Session `pause` handler stops the audio but
 * deliberately leaves metadata/handlers in place (just moves playback state to `'paused'`), and
 * its `play` handler restarts the last-played turn from the beginning rather than resuming — a
 * real, if imperfect, action rather than a dead button. `stop` is the only handler that actually
 * dismisses the notification (clears metadata/handlers entirely).
 */

export function isMediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
}

export interface MediaSessionMetadataInput {
  title: string
  artist: string
}

/** Sets the title/artist shown in the OS media notification — e.g. "Turn 5" / the campaign name. */
export function setMediaSessionMetadata({ title, artist }: MediaSessionMetadataInput): void {
  if (!isMediaSessionSupported()) return
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist })
}

export function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  if (!isMediaSessionSupported()) return
  navigator.mediaSession.playbackState = state
}

export interface MediaSessionHandlers {
  onPlay?: () => void
  onPause?: () => void
  onStop?: () => void
}

/** Wires the OS-level play/pause/stop controls to the given callbacks. Pass `{}` to clear all
 * three. `setActionHandler` throws a `TypeError` for an action a given browser doesn't recognize
 * (the Media Session action set has grown over time and isn't uniformly supported) — handled
 * per-action so one unsupported action can't stop the rest from being wired. */
export function setMediaSessionHandlers({ onPlay, onPause, onStop }: MediaSessionHandlers): void {
  if (!isMediaSessionSupported()) return
  const entries: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
    ['play', onPlay ?? null],
    ['pause', onPause ?? null],
    ['stop', onStop ?? null],
  ]
  for (const [action, handler] of entries) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // Not supported by this browser — nothing more we can do for this action.
    }
  }
}

/** Clears metadata, playback state, and action handlers — call whenever narration ends, whether
 * from a deliberate stop or the audio simply finishing, so a stale "Now Playing" notification
 * with dead controls doesn't linger. */
export function clearMediaSession(): void {
  if (!isMediaSessionSupported()) return
  navigator.mediaSession.metadata = null
  setMediaSessionPlaybackState('none')
  setMediaSessionHandlers({})
}
