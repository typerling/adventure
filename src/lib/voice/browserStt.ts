import type { SttProvider } from './types'

export function isBrowserSttSupported(): boolean {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition ?? window.webkitSpeechRecognition)
}

const ERROR_MESSAGES: Partial<Record<string, string>> = {
  'not-allowed': 'Microphone access was denied.',
  'audio-capture': 'No microphone was found.',
  'no-speech': "Didn't catch that — try again.",
  network: 'Speech recognition network error.',
}

/** Browser-native STT via the Web Speech API — one utterance per start(), zero config. */
export function createBrowserSttProvider(): SttProvider {
  const RecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
  if (!RecognitionCtor) {
    throw new Error('Speech recognition is not supported in this browser.')
  }

  let recognition: SpeechRecognition | null = null
  let resultCb: ((text: string, isFinal: boolean) => void) | null = null
  let errorCb: ((message: string) => void) | null = null
  let endCb: (() => void) | null = null

  return {
    start() {
      recognition?.abort()
      recognition = new RecognitionCtor()
      recognition.lang = navigator.language || 'en-US'
      recognition.continuous = false
      recognition.interimResults = true
      recognition.maxAlternatives = 1

      recognition.onresult = (event) => {
        let text = ''
        let isFinal = false
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          text += result[0]?.transcript ?? ''
          isFinal = isFinal || result.isFinal
        }
        resultCb?.(text.trim(), isFinal)
      }
      recognition.onerror = (event) => {
        // 'aborted' fires from our own abort()/stop() calls — not a real error to surface.
        if (event.error === 'aborted') return
        errorCb?.(ERROR_MESSAGES[event.error] ?? `Speech recognition error: ${event.error}`)
      }
      recognition.onend = () => endCb?.()

      recognition.start()
    },
    stop() {
      recognition?.stop()
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
