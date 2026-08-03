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
  /** How long a fake utterance "speaks" before firing `end`, in ms. Defaults to 0 (ends on the
   * next tick), which is what most tests want. Set it higher to leave a window where speech is
   * genuinely in progress — required to test interruption, since cancel() can only interrupt an
   * utterance that is still active. */
  ttsDurationMs?: number
}

export async function installFakeWebSpeechApi(page: Page, opts: FakeSpeechOptions = {}): Promise<void> {
  const { sttSupported = true, ttsSupported = true, ttsDurationMs = 0 } = opts
  await page.addInitScript(
    ({ sttSupported, ttsSupported, ttsDurationMs }) => {
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
        function FakeUtterance(
          this: {
            text: string
            voice?: unknown
            onstart: (() => void) | null
            onend: (() => void) | null
            onerror: ((e: unknown) => void) | null
          },
          text: string,
        ) {
          this.text = text
          this.onstart = null
          this.onend = null
          this.onerror = null
        }
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true })
        // Tracks the utterance currently "speaking" so cancel() can interrupt it the way the real
        // API does. A no-op cancel() would make this mock unable to model interruption at all —
        // which is exactly how a bug where cancel() rejected speak() (surfacing a spurious error
        // toast on every stop) stayed invisible to these tests.
        type FakeUtteranceInstance = {
          onstart: (() => void) | null
          onend: (() => void) | null
          onerror: ((e: unknown) => void) | null
        }
        let speaking: FakeUtteranceInstance | null = null
        let paused: FakeUtteranceInstance | null = null
        let endTimer: ReturnType<typeof setTimeout> | null = null
        function scheduleEnd(utterance: FakeUtteranceInstance) {
          endTimer = setTimeout(() => {
            if (speaking !== utterance) return // cancelled/paused before it finished
            speaking = null
            utterance.onend?.()
          }, ttsDurationMs)
        }
        Object.defineProperty(window, 'speechSynthesis', {
          configurable: true,
          value: {
            getVoices: () => [],
            cancel: () => {
              const active = speaking ?? paused
              speaking = null
              paused = null
              if (endTimer) clearTimeout(endTimer)
              // Real SpeechSynthesis reports a cancelled utterance through `error`, not `end`.
              active?.onerror?.({ error: 'interrupted' })
            },
            pause: () => {
              if (!speaking) return
              if (endTimer) clearTimeout(endTimer)
              paused = speaking
              speaking = null
            },
            resume: () => {
              if (!paused) return
              speaking = paused
              paused = null
              scheduleEnd(speaking)
            },
            speak: (utterance: FakeUtteranceInstance & { text: string }) => {
              ;((window as unknown as Record<string, unknown>).__spokenTexts as string[]).push(utterance.text)
              speaking = utterance
              utterance.onstart?.()
              scheduleEnd(utterance)
            },
          },
        })
      } else {
        Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true })
      }
    },
    { sttSupported, ttsSupported, ttsDurationMs },
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
