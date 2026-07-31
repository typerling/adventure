import type { TtsProvider } from './types'

export function isBrowserTtsSupported(): boolean {
  // A truthiness check, not `'speechSynthesis' in window`: some privacy-hardened browsers keep
  // the property present but null it out, and `in` would still (wrongly) report support.
  return typeof window !== 'undefined' && !!window.speechSynthesis
}

/** Browser-native TTS via SpeechSynthesis — zero config, quality varies by OS/browser. */
export function createBrowserTtsProvider(): TtsProvider {
  return {
    speak(text, opts) {
      return new Promise((resolve, reject) => {
        // Only one utterance plays at a time — cancel anything already in progress first.
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        if (opts?.voice) {
          const match = window.speechSynthesis
            .getVoices()
            .find((v) => v.name === opts.voice || v.voiceURI === opts.voice)
          if (match) utterance.voice = match
        }
        utterance.onend = () => resolve()
        utterance.onerror = (event) => {
          // cancel() — from stop(), or from the pre-emptive cancel above when a new utterance
          // starts — surfaces as an 'interrupted'/'canceled' error rather than 'end'. That's a
          // deliberate stop, not a failure, so resolve instead of rejecting; rejecting made every
          // stop/replay pop a spurious "Speech synthesis error" toast in Play.tsx.
          if (event.error === 'interrupted' || event.error === 'canceled') {
            resolve()
            return
          }
          reject(new Error(`Speech synthesis error: ${event.error}`))
        }
        window.speechSynthesis.speak(utterance)
      })
    },
    stop() {
      window.speechSynthesis.cancel()
    },
  }
}
