import type { SttProvider } from './types'
import { getElevenLabsApiKey } from './elevenLabsKey'

const MODEL_ID = 'scribe_v1'

export function isElevenLabsSttSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined'
  )
}

/**
 * ElevenLabs STT ("Scribe") — unlike browser SpeechRecognition there's no live/interim
 * transcript: this records the whole utterance locally, then uploads it once stop() is called.
 * onResult fires exactly once, already final.
 */
export function createElevenLabsSttProvider(): SttProvider {
  let mediaRecorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let resultCb: ((text: string, isFinal: boolean) => void) | null = null
  let errorCb: ((message: string) => void) | null = null
  let endCb: (() => void) | null = null

  async function transcribe(): Promise<void> {
    const apiKey = getElevenLabsApiKey()
    if (!apiKey) {
      errorCb?.('Add your ElevenLabs API key in Settings first.')
      return
    }
    if (chunks.length === 0) return

    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
    const form = new FormData()
    form.append('file', blob, 'recording.webm')
    form.append('model_id', MODEL_ID)

    try {
      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`ElevenLabs transcription failed (${res.status})${body ? `: ${body}` : ''}`)
      }
      const data = (await res.json()) as { text?: string }
      resultCb?.((data.text ?? '').trim(), true)
    } catch (err) {
      errorCb?.(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    start() {
      chunks = []
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((s) => {
          stream = s
          mediaRecorder = new MediaRecorder(s)
          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data)
          }
          mediaRecorder.onstop = () => {
            void transcribe().finally(() => endCb?.())
          }
          mediaRecorder.start()
        })
        .catch((err: DOMException) => {
          errorCb?.(err.name === 'NotAllowedError' ? 'Microphone access was denied.' : 'Could not access the microphone.')
          endCb?.()
        })
    },
    stop() {
      mediaRecorder?.stop()
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
    },
    onResult(cb) {
      resultCb = cb
    },
    onError(cb) {
      errorCb = cb
    },
    onEnd(cb) {
      endCb = cb
    },
  }
}
