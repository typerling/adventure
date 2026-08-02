import type { Page, Route } from '@playwright/test'

/** Mocks ElevenLabs' TTS + STT HTTP endpoints and records what was sent, so tests can assert on
 * it directly (route handlers run in the Node/test process, same pattern as googleApi.ts). */

export interface ElevenLabsMockVoice {
  voice_id: string
  name: string
  category?: string
  preview_url?: string | null
}

export interface ElevenLabsMockState {
  ttsRequests: { voiceId: string; text: string }[]
  sttRequests: number
  voicesRequests: number
}

const DEFAULT_MOCK_VOICES: ElevenLabsMockVoice[] = [
  { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', preview_url: 'https://example.com/rachel.mp3' },
  { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', category: 'premade', preview_url: 'https://example.com/domi.mp3' },
]

export async function installElevenLabsApiMock(
  page: Page,
  opts: { transcript?: string; voices?: ElevenLabsMockVoice[] } = {},
): Promise<ElevenLabsMockState> {
  const transcript = opts.transcript ?? 'Search the altar for clues'
  const voices = opts.voices ?? DEFAULT_MOCK_VOICES
  const state: ElevenLabsMockState = { ttsRequests: [], sttRequests: 0, voicesRequests: 0 }

  await page.route('https://api.elevenlabs.io/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (url.pathname.startsWith('/v1/text-to-speech/') && request.method() === 'POST') {
      const voiceId = url.pathname.split('/').pop() ?? ''
      const body = request.postDataJSON() as { text: string }
      state.ttsRequests.push({ voiceId, text: body.text })
      await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('fake-mp3-bytes') })
      return
    }

    if (url.pathname === '/v1/speech-to-text' && request.method() === 'POST') {
      state.sttRequests += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: transcript }) })
      return
    }

    if (url.pathname === '/v1/voices' && request.method() === 'GET') {
      state.voicesRequests += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ voices }) })
      return
    }

    await route.fulfill({ status: 501, body: `Unhandled ElevenLabs mock request: ${request.method()} ${url.pathname}` })
  })

  return state
}

/** Headless Chromium has no real audio pipeline and the mocked TTS response isn't valid MP3
 * data, so playback would never fire `ended`. Fakes window.Audio to resolve immediately instead
 * of actually decoding/playing anything — same "fake the API surface" approach as webSpeech.ts. */
export async function installFakeAudioPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeAudio {
      src: string
      onended: (() => void) | null = null
      onerror: ((event?: unknown) => void) | null = null
      constructor(src: string) {
        this.src = src
      }
      play() {
        setTimeout(() => this.onended?.(), 0)
        return Promise.resolve()
      }
      pause() {}
    }
    Object.defineProperty(window, 'Audio', { value: FakeAudio, configurable: true })
  })
}

/** Like installFakeAudioPlayback, but never fires `ended` on its own — for tests that need a
 * window to click a "stop"/toggle control before playback would naturally finish (the auto-ending
 * fake above leaves no such window). */
export async function installControllableAudioPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class ControllableAudio {
      src: string
      onended: (() => void) | null = null
      onerror: ((event?: unknown) => void) | null = null
      constructor(src: string) {
        this.src = src
      }
      play() {
        return Promise.resolve()
      }
      pause() {}
    }
    Object.defineProperty(window, 'Audio', { value: ControllableAudio, configurable: true })
  })
}
