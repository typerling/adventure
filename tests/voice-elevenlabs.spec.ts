import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installElevenLabsApiMock, installFakeAudioPlayback } from './mocks/elevenLabs'
import { installFakeMediaRecorder } from './mocks/mediaRecorder'
import { createRandomCampaign, setCampaignVoiceProviders, submitFreeTextTurn } from './helpers'

const KEY_STORAGE = 'adventure:elevenlabs-api-key'

// Scoped to the ElevenLabs card specifically — the Claude API card has its own identically
// labeled key input and Save/Clear key button.
function elevenLabsCard(page: import('@playwright/test').Page) {
  return page.locator('[data-slot="card"]', { has: page.locator('#elevenLabsKey') })
}

/** The ElevenLabs key card only renders on a campaign's own Settings page once that campaign
 * actually selected ElevenLabs for STT or TTS (see Settings.tsx) — so filling in a key requires a
 * campaign already configured that way, not just a bare /settings visit. */
async function saveElevenLabsKey(
  page: import('@playwright/test').Page,
  campaignId: string,
  key: string,
): Promise<void> {
  await page.goto(`/settings/${campaignId}`)
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
    const campaignId = campaignIdFromUrl(page)

    await page.goto(`/settings/${campaignId}`)
    await expect(page.locator('#elevenLabsKey')).toHaveValue('')

    await saveElevenLabsKey(page, campaignId, 'sk_test_12345')
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY_STORAGE)).toBe('sk_test_12345')

    // Reload — the field should rehydrate from localStorage, not reset.
    await page.reload()
    await expect(page.locator('#elevenLabsKey')).toHaveValue('sk_test_12345')

    // Clearing the field and saving removes it from storage.
    await page.locator('#elevenLabsKey').fill('')
    await elevenLabsCard(page).getByRole('button', { name: 'Clear key' }).click()
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY_STORAGE)).toBeNull()
  })

  test('the API key card is hidden unless a campaign actually uses ElevenLabs', async ({ page }) => {
    await installGoogleApiMock(page)

    // Global settings, no campaign — nothing here uses ElevenLabs, so no key field.
    await page.goto('/settings')
    await expect(page.locator('#elevenLabsKey')).toHaveCount(0)

    // A fresh campaign defaults to the browser voice providers — still hidden.
    await createRandomCampaign(page)
    const campaignId = campaignIdFromUrl(page)
    await page.goto(`/settings/${campaignId}`)
    await expect(page.getByText('AI mode', { exact: true })).toBeVisible()
    await expect(page.locator('#elevenLabsKey')).toHaveCount(0)

    // Selecting ElevenLabs for text-to-speech reveals it.
    await setCampaignVoiceProviders(page, { tts: 'elevenlabs' })
    await page.goto(`/settings/${campaignId}`)
    await expect(page.locator('#elevenLabsKey')).toBeVisible()
  })

  test('selecting ElevenLabs for STT/TTS drives the real request shapes', async ({ page }) => {
    await installGoogleApiMock(page)
    const elevenLabs = await installElevenLabsApiMock(page, { transcript: 'Search the altar for clues' })
    await installFakeMediaRecorder(page, { supported: true })
    await installFakeAudioPlayback(page)

    await createRandomCampaign(page)
    await setCampaignVoiceProviders(page, { stt: 'elevenlabs', tts: 'elevenlabs' })
    const campaignId = campaignIdFromUrl(page)
    await saveElevenLabsKey(page, campaignId, 'sk_test_12345')
    await page.goto(`/play/${campaignId}`)

    // --- STT: record, stop, and the transcript lands in the free-text box ---
    const micButton = page.getByRole('button', { name: 'Speak your action' })
    await expect(micButton).toBeVisible()
    await micButton.click()
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible()
    await page.getByRole('button', { name: 'Stop listening' }).click()

    await expect(page.getByPlaceholder('Say or do anything…')).toHaveValue('Search the altar for clues')
    expect(elevenLabs.sttRequests).toBe(1)

    // --- TTS: Read aloud sends the applied turn's narrative to ElevenLabs ---
    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await submitFreeTextTurn(page, 'search the altar', 'Dust rises as your fingers find a hidden latch.')
    await expect(page.getByText('Dust rises as your fingers find a hidden latch.')).toBeVisible()

    await expect.poll(() => elevenLabs.ttsRequests.length).toBe(1)
    expect(elevenLabs.ttsRequests[0].text).toBe('Dust rises as your fingers find a hidden latch.')
    expect(elevenLabs.ttsRequests[0].voiceId).toBeTruthy()
  })

  test('a turn\'s play button toggles to stop, and starting another turn stops the first', async ({ page }) => {
    await installGoogleApiMock(page)
    await installElevenLabsApiMock(page)
    // Deliberately not using the shared installFakeAudioPlayback() — that fake resolves `ended`
    // almost immediately, leaving no window to click "stop" before playback finishes on its own.
    // This one plays indefinitely until explicitly paused, and counts play()/pause() calls so the
    // test can confirm stop() actually reaches whatever's currently playing.
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
    await saveElevenLabsKey(page, campaignId, 'sk_test_12345')
    await page.goto(`/play/${campaignId}`)

    await submitFreeTextTurn(page, 'look around', 'A dusty room, empty save for a locked chest.')
    // Wait for the first turn to fully settle (dialog closed, toast shown) before starting the
    // next one — otherwise the second Act click can race the first dialog's close animation.
    await expect(page.getByText('Turn applied.')).toBeVisible()
    await submitFreeTextTurn(page, 'open the chest', 'Inside: a folded letter, sealed with wax.')

    const playButtons = page.getByRole('button', { name: 'Play this turn aloud' })
    await expect(playButtons).toHaveCount(2)

    // Start turn 1 — its button becomes a stop button.
    await playButtons.first().click()
    await expect(page.getByRole('button', { name: 'Stop playback' })).toHaveCount(1)
    await expect(playButtons).toHaveCount(1)

    // Starting turn 2 while turn 1 is still "playing" stops turn 1 first (this is exactly the bug
    // report: a stale provider instance per call meant stop() couldn't reach earlier audio).
    await playButtons.first().click() // now the only remaining "Play" button — turn 2's
    await expect(page.getByRole('button', { name: 'Stop playback' })).toHaveCount(1)
    await expect(playButtons).toHaveCount(1)

    // play()/pause() happen after an async fetch (the mocked TTS request) — poll rather than
    // asserting immediately after the click.
    const readAudioEvents = () =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__audioEvents as { plays: number; pauses: number })
    await expect.poll(readAudioEvents).toEqual({ plays: 2, pauses: 1 }) // both turns played; turn 1 paused when turn 2 started

    // Stopping turn 2 explicitly reverts its button immediately (not waiting on any "ended"
    // event, which this fake never fires) and actually pauses the audio.
    await page.getByRole('button', { name: 'Stop playback' }).click()
    await expect(page.getByRole('button', { name: 'Stop playback' })).toHaveCount(0)
    await expect(playButtons).toHaveCount(2)
    await expect.poll(readAudioEvents).toEqual({ plays: 2, pauses: 2 })
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
