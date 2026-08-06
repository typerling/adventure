import { test, expect, type Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi } from './mocks/webSpeech'
import { createRandomCampaign, submitFreeTextTurn } from './helpers'

/**
 * Coverage for #39: navigator.mediaSession wiring (metadata + play/pause/stop action handlers)
 * driven through the same play/stop paths Play.tsx already uses for all three TTS providers.
 *
 * What this *can't* prove: real Android "Now Playing" notification behavior, or whether native
 * speechSynthesis actually survives backgrounding — those need a real device/OS, not headless
 * Playwright (see #39's PR description). What it *can* prove: that the app calls the real
 * `navigator.mediaSession` API (Chromium implements it headless — verified while writing this;
 * it's a JS-level object, not something that needs an OS notification tray to exist) with the
 * right metadata/handlers at the right times, and that those handlers actually drive playback.
 *
 * `navigator.mediaSession.setActionHandler` has no getter, so `installMediaSessionSpy` wraps it in
 * an init script to record what's currently registered for each action.
 */
async function installMediaSessionSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const registered: Record<string, boolean> = { play: false, pause: false, stop: false }
    const handlers: Record<string, (() => void) | null> = { play: null, pause: null, stop: null }
    ;(window as unknown as Record<string, unknown>).__mediaSessionActions = registered
    ;(window as unknown as Record<string, unknown>).__mediaSessionHandlers = handlers
    const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession)
    navigator.mediaSession.setActionHandler = (action, handler) => {
      registered[action] = handler !== null
      handlers[action] = handler as (() => void) | null
      // Captured once, the first time a non-null pause handler is registered. pausePlayback is a
      // stable function identity for the component's whole lifetime (a useCallback with no deps),
      // so this stays a valid reference to call even after a later setActionHandler('pause', null)
      // overwrites handlers.pause above — the same way a real OS that already has the callback
      // can still invoke it regardless of what the app does to the "currently registered" one
      // afterward. Lets a test simulate an OS tap landing just after the app cleared its session.
      if (action === 'pause' && handler && !(window as unknown as Record<string, unknown>).__capturedPauseHandler) {
        ;(window as unknown as Record<string, unknown>).__capturedPauseHandler = handler
      }
      original(action, handler)
    }
  })
}

/** Invokes the pause handler captured the first time it was registered — bypassing whatever is
 * *currently* registered, to simulate an OS tap dispatched to a callback the app has since
 * cleared. See installMediaSessionSpy's __capturedPauseHandler comment. */
async function tapCapturedPauseHandler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const handler = (window as unknown as { __capturedPauseHandler?: () => void }).__capturedPauseHandler
    handler?.()
  })
}

function readMediaSessionState(page: Page) {
  return page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title ?? null,
    artist: navigator.mediaSession.metadata?.artist ?? null,
    playbackState: navigator.mediaSession.playbackState,
    actions: (window as unknown as { __mediaSessionActions?: Record<string, boolean> })
      .__mediaSessionActions ?? {},
  }))
}

/** Invokes the currently-registered action handler directly — simulates an OS media-notification
 * tap (play/pause/stop). Headless Chromium has no real notification surface to tap, so this calls
 * through the app's own handler reference, captured by installMediaSessionSpy at registration
 * time — the same function `navigator.mediaSession.setActionHandler` was actually given. */
async function tapMediaSessionAction(page: Page, action: 'play' | 'pause' | 'stop'): Promise<void> {
  await page.evaluate((action) => {
    const handlers = (window as unknown as { __mediaSessionHandlers?: Record<string, (() => void) | null> })
      .__mediaSessionHandlers
    handlers?.[action]?.()
  }, action)
}

test.describe('Media Session integration (#39)', () => {
  test('starting playback sets metadata, playback state, and play/pause/stop handlers', async ({ page }) => {
    await installGoogleApiMock(page)
    // Long-running utterance so there's a real window to observe "playing" before it ends on its
    // own (the default duration ends almost immediately, leaving nothing to assert against).
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    let state = await readMediaSessionState(page)
    expect(state.title).toBeNull()
    expect(state.playbackState).toBe('none')

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop playback' })).toBeVisible()

    state = await readMediaSessionState(page)
    expect(state.title).toBe('Turn 1')
    expect(state.artist).toBeTruthy() // the campaign's (randomly generated) name
    expect(state.playbackState).toBe('playing')
    expect(state.actions).toEqual({ play: true, pause: true, stop: true })
  })

  test('the in-app stop button clears the Media Session entirely', async ({ page }) => {
    await installGoogleApiMock(page)
    // Long-running utterance so there's a real window to click stop before it finishes on its own.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop playback' })).toBeVisible()
    expect((await readMediaSessionState(page)).playbackState).toBe('playing')

    await page.getByRole('button', { name: 'Stop playback' }).click()
    await expect(page.getByRole('button', { name: 'Play this turn aloud' })).toBeVisible()

    const state = await readMediaSessionState(page)
    expect(state.title).toBeNull()
    expect(state.playbackState).toBe('none')
    expect(state.actions).toEqual({ play: false, pause: false, stop: false })
  })

  test('narration finishing on its own also clears the Media Session', async ({ page }) => {
    await installGoogleApiMock(page)
    // Default ttsDurationMs (0) — the fake utterance ends on its own almost immediately.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(page.getByRole('button', { name: 'Play this turn aloud' })).toBeVisible() // reverted once it "ended"

    await expect.poll(async () => (await readMediaSessionState(page)).playbackState).toBe('none')
    expect((await readMediaSessionState(page)).title).toBeNull()
  })

  test('an OS pause tap that lands just after playback already ended naturally does not resurrect the cleared Media Session', async ({
    page,
  }) => {
    // Flagged in PR #43's review: pausePlayback wrote playbackState: 'paused' unconditionally,
    // with no check for whether the session it meant to pause had already been cleared by a
    // natural end. A real OS dispatches a tap to whatever callback reference it already holds —
    // re-registering (nulling) that handler afterward doesn't retroactively un-dispatch a tap that
    // already landed, so this simulates that by invoking the *originally* captured pause handler
    // directly, after the natural end has already cleared the session.
    await installGoogleApiMock(page)
    // Default ttsDurationMs (0) — ends on its own almost immediately, same as the natural-end test
    // above.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(page.getByRole('button', { name: 'Play this turn aloud' })).toBeVisible() // reverted once it "ended"
    await expect.poll(async () => (await readMediaSessionState(page)).playbackState).toBe('none')

    // The pause tap arrives after the clear above already happened.
    await tapCapturedPauseHandler(page)

    const state = await readMediaSessionState(page)
    expect(state.playbackState).toBe('none')
    expect(state.title).toBeNull()
  })

  test('turning off Read-aloud mid-playback clears the Media Session too', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await expect.poll(async () => (await readMediaSessionState(page)).playbackState).toBe('playing')

    await page.getByRole('button', { name: 'Stop reading turns aloud' }).click()

    const state = await readMediaSessionState(page)
    expect(state.playbackState).toBe('none')
    expect(state.title).toBeNull()
  })

  test('a second turn starting playback replaces (not stacks on) the first turn\'s Media Session state', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'A dusty room, empty save for a locked chest.')
    await expect(page.getByText('Turn applied.')).toBeVisible()
    await page.addStyleTag({ content: '[data-sonner-toaster] { display: none !important; }' })
    await submitFreeTextTurn(page, 'open the chest', 'Inside: a folded letter, sealed with wax.')

    const playButtons = page.getByRole('button', { name: 'Play this turn aloud' })
    await playButtons.first().click() // turn 1
    expect((await readMediaSessionState(page)).title).toBe('Turn 1')

    await playButtons.first().click() // now the only remaining "Play" button — turn 2's
    await expect(page.getByRole('button', { name: 'Stop playback' })).toHaveCount(1)
    await expect.poll(async () => (await readMediaSessionState(page)).title).toBe('Turn 2')
    expect((await readMediaSessionState(page)).playbackState).toBe('playing')
  })

  test('the OS pause control stops the audio but keeps the Now Playing session alive (no TtsProvider supports real pause/resume)', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop playback' })).toBeVisible()

    await tapMediaSessionAction(page, 'pause')

    // Reflected in the in-app UI too — this isn't a parallel mechanism, it's the same stop path.
    await expect(page.getByRole('button', { name: 'Play this turn aloud' })).toBeVisible()
    // Unlike a full stop, "pause" leaves the notification (metadata + play handler) in place —
    // otherwise there'd be nothing left on the lock screen to tap to resume.
    const state = await readMediaSessionState(page)
    expect(state.playbackState).toBe('paused')
    expect(state.title).toBe('Turn 1')
    expect(state.actions.play).toBe(true)
  })

  test('the OS play control restarts the last-played turn from the beginning after a pause', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await installMediaSessionSpy(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop playback' })).toBeVisible()
    await tapMediaSessionAction(page, 'pause')
    await expect(page.getByRole('button', { name: 'Play this turn aloud' })).toBeVisible()

    await tapMediaSessionAction(page, 'play')

    await expect(page.getByRole('button', { name: 'Stop playback' })).toBeVisible()
    const state = await readMediaSessionState(page)
    expect(state.title).toBe('Turn 1')
    expect(state.playbackState).toBe('playing')
  })
})
