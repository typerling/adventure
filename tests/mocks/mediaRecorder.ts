import type { Page } from '@playwright/test'

/** Fakes getUserMedia + MediaRecorder for testing ElevenLabs STT — headless Chromium has no real
 * microphone, and even with a fake device flag there's no real speech to transcribe. Real
 * Chromium already implements both natively, so the `supported: false` branch explicitly
 * overrides them (a value-based check, not `'x' in navigator`, matches how the app itself checks
 * support — see isElevenLabsSttSupported). */
export async function installFakeMediaRecorder(page: Page, opts: { supported?: boolean } = {}): Promise<void> {
  const { supported = true } = opts
  await page.addInitScript(({ supported }) => {
    if (!supported) {
      Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true })
      if (navigator.mediaDevices) {
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: undefined, configurable: true })
      }
      return
    }

    class FakeMediaRecorder extends EventTarget {
      mimeType = 'audio/webm'
      state: 'inactive' | 'recording' = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null

      constructor(public stream: unknown) {
        super()
      }
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['fake-audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true })

    const fakeStream = { getTracks: () => [{ stop: () => {} }] }
    const fakeGetUserMedia = async () => fakeStream as unknown as MediaStream
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fakeGetUserMedia, configurable: true })
  }, { supported })
}
