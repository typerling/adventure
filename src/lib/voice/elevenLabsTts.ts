import type { TtsProvider } from './types'
import { getElevenLabsApiKey } from './elevenLabsKey'

// "Rachel" — one of ElevenLabs' stable premade voices, used when a campaign hasn't set
// CampaignSettings.elevenLabsVoiceId yet.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const MODEL_ID = 'eleven_multilingual_v2'

/** ElevenLabs TTS — needs an API key (Settings, see elevenLabsKey.ts) and, optionally, a
 * campaign-level voice ID (CampaignSettings.elevenLabsVoiceId, passed as opts.voice). */
export function createElevenLabsTtsProvider(): TtsProvider {
  let currentAudio: HTMLAudioElement | null = null

  return {
    async speak(text, opts) {
      const apiKey = getElevenLabsApiKey()
      if (!apiKey) {
        throw new Error('Add your ElevenLabs API key in Settings first.')
      }

      currentAudio?.pause()
      currentAudio = null

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
          audio.onended = () => resolve()
          audio.onerror = () => reject(new Error('Audio playback failed.'))
          audio.play().catch(reject)
        })
      } finally {
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
      }
    },
    stop() {
      currentAudio?.pause()
      currentAudio = null
    },
  }
}
