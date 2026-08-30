import type { TtsProvider } from './types'
import { getElevenLabsApiKey } from './elevenLabsKey'

// "Rachel" — one of ElevenLabs' stable premade voices, used when the player hasn't set
// GlobalSettings.elevenLabsVoiceId yet.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const MODEL_ID = 'eleven_multilingual_v2'

/** ElevenLabs TTS — needs an API key (Settings, see elevenLabsKey.ts) and, optionally, a global
 * voice ID (GlobalSettings.elevenLabsVoiceId, passed as opts.voice). */
export function createElevenLabsTtsProvider(): TtsProvider {
  let currentAudio: HTMLAudioElement | null = null
  /** Settles the in-flight speak() when stop() interrupts it. `pause()` fires neither 'ended' nor
   * 'error', so without this the promise never settles, its `finally` never runs, and the blob URL
   * is never revoked — leaking the audio for the page's lifetime on every stop. */
  let settleCurrent: (() => void) | null = null

  return {
    async speak(text, opts) {
      const apiKey = getElevenLabsApiKey()
      if (!apiKey) {
        throw new Error('Add your ElevenLabs API key in Settings first.')
      }

      this.stop()

      const voiceId = opts?.voice?.trim() || DEFAULT_VOICE_ID
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: MODEL_ID }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`ElevenLabs text-to-speech request failed (${res.status})${body ? `: ${body}` : ''}`)
      }

      const url = URL.createObjectURL(await res.blob())
      const audio = new Audio(url)
      currentAudio = audio
      try {
        await new Promise<void>((resolve, reject) => {
          settleCurrent = resolve
          audio.onended = () => resolve()
          audio.onerror = () => reject(new Error('Audio playback failed.'))
          audio.play().catch(reject)
        })
      } finally {
        settleCurrent = null
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
      }
    },
    stop() {
      currentAudio?.pause()
      currentAudio = null
      // Resolve (not reject) any in-flight speak(): a deliberate stop isn't a failure, and callers
      // treat a rejection as an error worth toasting.
      settleCurrent?.()
      settleCurrent = null
    },
  }
}
