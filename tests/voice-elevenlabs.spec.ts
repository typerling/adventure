import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import {
  installControllableAudioPlayback,
  installElevenLabsApiMock,
  installFakeAudioPlayback,
} from './mocks/elevenLabs'
import { installFakeMediaRecorder } from './mocks/mediaRecorder'
import { createRandomCampaign, setCampaignAutoReadAloud, setCampaignVoiceProviders, submitFreeTextTurn } from './helpers'

const KEY_STORAGE = 'adventure:elevenlabs-api-key'

// Scoped to the ElevenLabs card specifically — the Claude API card has its own identically
// labeled key input and Save/Clear key button.
function elevenLabsCard(page: import('@playwright/test').Page) {
  return page.locator('[data-slot="card"]', { has: page.locator('#elevenLabsKey') })
}

/** The ElevenLabs API key lives on the device-global Settings page (src/pages/Settings.tsx),
 * unconditionally — not gated on any campaign's provider choice. */
async function saveElevenLabsKey(page: import('@playwright/test').Page, key: string): Promise<void> {
  await page.goto('/settings')
  await page.locator('#elevenLabsKey').fill(key)
  await elevenLabsCard(page).getByRole('button', { name: /Save key|Clear key/ }).click()
}

function campaignIdFromUrl(page: import('@playwright/test').Page): string {
  const match = page.url().match(/\/play\/([^/?#]+)/)
  if (!match) throw new Error(`campaignIdFromUrl: no campaign id in URL "${page.url()}"`)
  return match[1]
}

test.describe('ElevenLabs voice provider', () => {
  test('API key entered in Settings persists in localStorage across reloads', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)
    await setCampaignVoiceProviders(page, { tts: 'elevenlabs' })

    await page.goto('/settings')
    await expect(page.locator('#elevenLabsKey')).toHaveValue('')

    await saveElevenLabsKey(page, 'sk_test_12345')
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY_STORAGE)).toBe('sk_test_12345')

    // Reload — the field should rehydrate from localStorage, not reset.
    await page.reload()
    await expect(page.locator('#elevenLabsKey')).toHaveValue('sk_test_12345')

    // Clearing the field and saving removes it from storage.
    await page.locator('#elevenLabsKey').fill('')
    await elevenLabsCard(page).getByRole('button', { name: 'Clear key' }).click()
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY_STORAGE)).toBeNull()
  })

  test('the API key card is always visible on Settings, regardless of any campaign\'s provider choice', async ({
    page,
  }) => {
    await installGoogleApiMock(page)

    // Device-global, no campaign needed — visible even before any campaign exists.
    await page.goto('/settings')
    await expect(page.locator('#elevenLabsKey')).toBeVisible()

    // A fresh campaign defaults to the browser voice providers — key card still visible, since
    // it's no longer gated on any one campaign's choice.
    await createRandomCampaign(page)
    await page.goto('/settings')
    await expect(page.locator('#elevenLabsKey')).toBeVisible()
  })

  test('voice picker lists ElevenLabs voices, previews one, and selecting one sets the voice ID', async ({ page }) => {
    await installGoogleApiMock(page)
    const elevenLabs = await installElevenLabsApiMock(page, {
      voices: [
        { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', preview_url: 'https://example.com/rachel.mp3' },
        { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', category: 'premade', preview_url: 'https://example.com/domi.mp3' },
        // A voice with no hosted sample — the preview button for it should be disabled rather
        // than attempt to play `new Audio(undefined)`.
        { voice_id: 'no-preview-voice', name: 'Silent Sam', category: 'cloned', preview_url: null },
      ],
    })
    // Deliberately not the auto-ending fake — previews need a window to click "stop" before
    // playback would resolve on its own (same reasoning as the play-button toggle test below).
    await installControllableAudioPlayback(page)

    await createRandomCampaign(page)
    await setCampaignVoiceProviders(page, { tts: 'elevenlabs' })
    const campaignId = campaignIdFromUrl(page)
    await saveElevenLabsKey(page, 'sk_test_12345')
    await page.goto(`/codex/${campaignId}?tab=settings`)

    await page.getByRole('button', { name: 'Browse voices' }).click()
    await expect(page.getByRole('dialog', { name: 'Choose an ElevenLabs voice' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Rachel/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Domi/ })).toBeVisible()
    expect(elevenLabs.voicesRequests).toBe(1)

    // A voice with no preview_url can't be auditioned.
    await expect(page.getByRole('button', { name: 'Preview Silent Sam' })).toBeDisabled()

    // Preview toggles to a stop button, doesn't touch the voice ID field, and doesn't hit the
    // text-to-speech endpoint (it plays ElevenLabs' hosted sample directly).
    await page.getByRole('button', { name: 'Preview Rachel' }).click()
    await expect(page.getByRole('button', { name: 'Stop preview of Rachel' })).toBeVisible()
    expect(elevenLabs.ttsRequests).toHaveLength(0)
    await expect(page.locator('#voiceId')).toHaveValue('')

    // Switching to a different voice's preview stops the first rather than layering audio.
    await page.getByRole('button', { name: 'Preview Domi' }).click()
    await expect(page.getByRole('button', { name: 'Stop preview of Domi' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Preview Rachel$/ })).toBeVisible()

    // Explicitly stopping a preview reverts its button without selecting anything.
    await page.getByRole('button', { name: 'Stop preview of Domi' }).click()
    await expect(page.getByRole('button', { name: /^Preview Domi$/ })).toBeVisible()
    await expect(page.locator('#voiceId')).toHaveValue('')

    await page.getByRole('button', { name: /^Domi/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('#voiceId')).toHaveValue('AZnzlk1XvdvUeBnXmlld')

    // Reopening the picker reuses the already-loaded list instead of refetching.
    await page.getByRole('button', { name: 'Browse voices' }).click()
    await expect(page.getByRole('dialog', { name: 'Choose an ElevenLabs voice' })).toBeVisible()
    expect(elevenLabs.voicesRequests).toBe(1)
  })

  test('selecting ElevenLabs for STT/TTS drives the real request shapes', async ({ page }) => {
    await installGoogleApiMock(page)
    const elevenLabs = await installElevenLabsApiMock(page, { transcript: 'Search the altar for clues' })
    await installFakeMediaRecorder(page, { supported: true })
    await installFakeAudioPlayback(page)

    await createRandomCampaign(page)
    await setCampaignVoiceProviders(page, { stt: 'elevenlabs', tts: 'elevenlabs' })
    const campaignId = campaignIdFromUrl(page)
    await saveElevenLabsKey(page, 'sk_test_12345')
    await page.goto(`/play/${campaignId}`)

    // --- STT: record, stop, and the transcript lands in the free-text box ---
    const micButton = page.getByRole('button', { name: 'Speak your action' })
    await expect(micButton).toBeVisible()
    await micButton.click()
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible()
    await page.getByRole('button', { name: 'Stop listening' }).click()

    await expect(page.getByPlaceholder('Say or do anything…')).toHaveValue('Search the altar for clues')
    expect(elevenLabs.sttRequests).toBe(1)

    // --- TTS: auto-read-aloud sends the applied turn's narrative to ElevenLabs, then its options
    // as a second request once the narrative finishes ---
    await setCampaignAutoReadAloud(page, true)
    await submitFreeTextTurn(page, 'search the altar', 'Dust rises as your fingers find a hidden latch.')
    await expect(page.getByText('Dust rises as your fingers find a hidden latch.')).toBeVisible()

    await expect.poll(() => elevenLabs.ttsRequests.length).toBe(2)
    expect(elevenLabs.ttsRequests[0].text).toBe('Dust rises as your fingers find a hidden latch.')
    expect(elevenLabs.ttsRequests[0].voiceId).toBeTruthy()
    expect(elevenLabs.ttsRequests[1].text).toBe('Your options: 1. Look around. 2. Move on.')
  })

  test("a turn's play button toggles to pause, and starting another turn pauses the first", async ({ page }) => {
    await installGoogleApiMock(page)
    await installElevenLabsApiMock(page)
    // Deliberately not using the shared installFakeAudioPlayback() — that fake resolves `ended`
    // almost immediately, leaving no window to click "pause" before playback finishes on its own.
    // This one plays indefinitely until explicitly paused, and counts play()/pause() calls so the
    // test can confirm pause() actually reaches whatever's currently playing.
    await page.addInitScript(() => {
      ;(window as unknown as Record<string, unknown>).__audioEvents = { plays: 0, pauses: 0 }
      class NeverEndingAudio {
        onended: (() => void) | null = null
        onerror: ((event?: unknown) => void) | null = null
        constructor(public src: string) {}
        play() {
          ;((window as unknown as Record<string, unknown>).__audioEvents as { plays: number }).plays += 1
          return Promise.resolve()
        }
        pause() {
          ;((window as unknown as Record<string, unknown>).__audioEvents as { pauses: number }).pauses += 1
        }
      }
      Object.defineProperty(window, 'Audio', { value: NeverEndingAudio, configurable: true })
    })

    await createRandomCampaign(page)
    await setCampaignVoiceProviders(page, { tts: 'elevenlabs' })
    const campaignId = campaignIdFromUrl(page)
    await saveElevenLabsKey(page, 'sk_test_12345')
    await page.goto(`/play/${campaignId}`)

    await submitFreeTextTurn(page, 'look around', 'A dusty room, empty save for a locked chest.')
    // Wait for the first turn to fully settle (dialog closed, toast shown) before starting the
    // next one — otherwise the second Act click can race the first dialog's close animation.
    await expect(page.getByText('Turn applied.')).toBeVisible()
    await submitFreeTextTurn(page, 'open the chest', 'Inside: a folded letter, sealed with wax.')

    // The header's master control mirrors the same state, so scope to the per-turn (icon-xs)
    // buttons specifically — both would otherwise match by name.
    const playButtons = page.getByRole('button', { name: 'Play this turn aloud' })
    const perTurnPauseButtons = page.getByRole('button', { name: 'Pause playback' }).and(page.locator('[data-size="icon-xs"]'))
    const perTurnResumeButtons = page.getByRole('button', { name: 'Resume playback' }).and(page.locator('[data-size="icon-xs"]'))
    await expect(playButtons).toHaveCount(2)

    // Start turn 1 — its button becomes a pause button.
    await playButtons.first().click()
    await expect(perTurnPauseButtons).toHaveCount(1)
    await expect(playButtons).toHaveCount(1)

    // Starting turn 2 while turn 1 is still playing pauses turn 1 first (this is exactly the bug
    // report: a stale provider instance per call meant pause()/stop() couldn't reach earlier
    // audio) — turn 1's button reverts to idle since it's no longer the active turn.
    await playButtons.first().click() // now the only remaining "Play" button — turn 2's
    await expect(perTurnPauseButtons).toHaveCount(1)
    await expect(playButtons).toHaveCount(1)

    // play()/pause() happen after an async fetch (the mocked TTS request) — poll rather than
    // asserting immediately after the click.
    const readAudioEvents = () =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__audioEvents as { plays: number; pauses: number })
    await expect.poll(readAudioEvents).toEqual({ plays: 2, pauses: 1 }) // both turns played; turn 1 paused when turn 2 started

    // Pausing turn 2 explicitly reverts its button to "Resume playback" — not back to idle, since
    // pausing keeps position rather than discarding it — and actually pauses the audio.
    await perTurnPauseButtons.click()
    await expect(perTurnResumeButtons).toHaveCount(1)
    await expect.poll(readAudioEvents).toEqual({ plays: 2, pauses: 2 })

    // Resuming continues playing the same turn rather than starting over.
    await perTurnResumeButtons.click()
    await expect(perTurnPauseButtons).toHaveCount(1)
    await expect.poll(readAudioEvents).toEqual({ plays: 3, pauses: 2 })
  })

  test('missing API key surfaces a clear error instead of failing silently', async ({ page }) => {
    await installGoogleApiMock(page)
    await installElevenLabsApiMock(page)
    await installFakeMediaRecorder(page, { supported: true })
    await installFakeAudioPlayback(page)

    // Deliberately not saving a key this time.
    await createRandomCampaign(page)
    await setCampaignVoiceProviders(page, { stt: 'elevenlabs' })

    await page.getByRole('button', { name: 'Speak your action' }).click()
    await page.getByRole('button', { name: 'Stop listening' }).click()

    await expect(page.getByText('Add your ElevenLabs API key in Settings first.')).toBeVisible()
  })
})
