import type { Page } from '@playwright/test'

/**
 * Fakes the Web Speech API (SpeechRecognition + SpeechSynthesis) so voice UI can be tested
 * deterministically — headless Chromium has no real microphone input and no OS TTS voices, so
 * driving this through the actual browser APIs would be flaky or simply never resolve. Real
 * Chromium also already ships `webkitSpeechRecognition`/`speechSynthesis` natively, so both
 * branches (supported/unsupported) explicitly override whatever the browser provides.
 */

export interface FakeSpeechOptions {
  sttSupported?: boolean
  ttsSupported?: boolean
}

export async function installFakeWebSpeechApi(page: Page, opts: FakeSpeechOptions = {}): Promise<void> {
  const { sttSupported = true, ttsSupported = true } = opts
  await page.addInitScript(
    ({ sttSupported, ttsSupported }) => {
      if (sttSupported) {
        class FakeSpeechRecognition extends EventTarget {
          lang = ''
          continuous = false
          interimResults = false
          maxAlternatives = 1
          onresult: ((event: unknown) => void) | null = null
          onerror: ((event: unknown) => void) | null = null
          onend: (() => void) | null = null
          onstart: (() => void) | null = null

          start() {
            // Exposed so the test can drive this exact instance from simulateSpeechResult().
            ;(window as unknown as Record<string, unknown>).__fakeRecognition = this
            this.onstart?.()
          }
          stop() {
            this.onend?.()
          }
          abort() {
            this.onend?.()
          }
        }
        Object.defineProperty(window, 'SpeechRecognition', { value: FakeSpeechRecognition, configurable: true })
        Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeSpeechRecognition, configurable: true })
      } else {
        Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true })
        Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true })
      }

      if (ttsSupported) {
        ;(window as unknown as Record<string, unknown>).__spokenTexts = []
        function FakeUtterance(this: { text: string; voice?: unknown; onend: (() => void) | null; onerror: ((e: unknown) => void) | null }, text: string) {
          this.text = text
          this.onend = null
          this.onerror = null
        }
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true })
        Object.defineProperty(window, 'speechSynthesis', {
          configurable: true,
          value: {
            getVoices: () => [],
            cancel: () => {},
            speak: (utterance: { text: string; onend: (() => void) | null }) => {
              ;((window as unknown as Record<string, unknown>).__spokenTexts as string[]).push(utterance.text)
              setTimeout(() => utterance.onend?.(), 0)
            },
          },
        })
      } else {
        Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true })
      }
    },
    { sttSupported, ttsSupported },
  )
}

/** Simulates speech coming into the currently-active fake recognition instance — call after the
 * mic button has been clicked (so start() has run and registered the instance). */
export async function simulateSpeechResult(
  page: Page,
  text: string,
  opts: { isFinal?: boolean; end?: boolean } = {},
): Promise<void> {
  const { isFinal = true, end = true } = opts
  await page.evaluate(
    ({ text, isFinal, end }) => {
      const recognition = (window as unknown as Record<string, unknown>).__fakeRecognition as {
        onresult: ((event: unknown) => void) | null
        onend: (() => void) | null
      } | undefined
      if (!recognition) throw new Error('No active fake SpeechRecognition instance — was the mic button clicked?')
      const result = Object.assign([{ transcript: text }], { isFinal })
      recognition.onresult?.({ resultIndex: 0, results: [result] })
      if (end) recognition.onend?.()
    },
    { text, isFinal, end },
  )
}

/** Reads back everything spoken through the fake TTS so far, in order. */
export async function getSpokenTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>).__spokenTexts as string[] | undefined ?? [])
}
