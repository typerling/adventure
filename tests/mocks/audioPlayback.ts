import type { Page } from '@playwright/test'

/** Headless Chromium has no real audio pipeline and a mocked/generated audio response isn't
 * necessarily valid, so playback would never fire `ended`. Fakes window.Audio to resolve
 * immediately instead of actually decoding/playing anything — same "fake the API surface"
 * approach as webSpeech.ts. */
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
