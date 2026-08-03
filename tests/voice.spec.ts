import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi, simulateSpeechResult, getSpokenTexts } from './mocks/webSpeech'
import {
  createRandomCampaign,
  getRecordedToasts,
  recordToasts,
  setCampaignAutoReadAloud,
  submitFreeTextTurn,
} from './helpers'

test.describe('browser voice (STT/TTS)', () => {
  test('mic button transcribes speech into the free-text box', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    const freeText = page.getByPlaceholder('Say or do anything…')
    const micButton = page.getByRole('button', { name: 'Speak your action' })
    await expect(micButton).toBeVisible()

    await micButton.click()
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible()
    await expect(page.getByPlaceholder('Listening…')).toBeVisible()

    await simulateSpeechResult(page, 'Search the altar for clues')
    await expect(freeText).toHaveValue('Search the altar for clues')

    // Recognition auto-ends after one utterance — the mic button should revert on its own.
    await expect(page.getByRole('button', { name: 'Speak your action' })).toBeVisible()
  })

  test('auto-read-aloud speaks new turns but not campaign history on load', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    expect(await getSpokenTexts(page)).toEqual([])

    await setCampaignAutoReadAloud(page, true)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    // The latest turn's narrative is followed by its options, spoken as one continuous playback.
    await expect
      .poll(() => getSpokenTexts(page))
      .toEqual(['You step into a quiet, dust-lit room.', 'Your options: 1. Look around. 2. Move on.'])
  })

  test('does not speak a turn applied before auto-read-aloud was turned on', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    // Auto-read-aloud is still off — applying the turn above must not have queued any speech.
    expect(await getSpokenTexts(page)).toEqual([])

    await setCampaignAutoReadAloud(page, true)
    await page.waitForTimeout(200)
    expect(await getSpokenTexts(page)).toEqual([])
  })

  test('voice controls are hidden when the browser has no speech support', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: false, ttsSupported: false })
    await createRandomCampaign(page)

    await expect(page.getByRole('button', { name: 'Speak your action' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Play latest turn aloud' })).toHaveCount(0)
    // The rest of the turn loop still works without voice.
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  })

  test('a turn can be replayed on demand via its own play button, regardless of auto-read-aloud', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    // Auto-read-aloud stays off — this turn is never auto-narrated.
    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()
    expect(await getSpokenTexts(page)).toEqual([])

    // "In case one missed the opportunity" — replaying it manually still works, and since this
    // is the latest turn its options are spoken afterward too.
    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect
      .poll(() => getSpokenTexts(page))
      .toEqual(['You step into a quiet, dust-lit room.', 'Your options: 1. Look around. 2. Move on.'])
  })

  test('the per-turn button shows loading, then playing, then lets you pause and resume', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 3000 })
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    // The header's master control mirrors the same state, so scope to the per-turn (icon-xs)
    // button specifically — both are visible and both would otherwise match by name.
    const perTurnPauseButton = page.getByRole('button', { name: 'Pause playback' }).and(page.locator('[data-size="icon-xs"]'))
    const perTurnResumeButton = page.getByRole('button', { name: 'Resume playback' }).and(page.locator('[data-size="icon-xs"]'))

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect(perTurnPauseButton).toBeVisible()

    await perTurnPauseButton.click()
    await expect(perTurnResumeButton).toBeVisible()

    await perTurnResumeButton.click()
    await expect(perTurnPauseButton).toBeVisible()
  })

  test('pausing and resuming playback is not reported as an error', async ({ page }) => {
    // Regression test: SpeechSynthesis reports a cancelled utterance through `error`
    // ('interrupted'/'canceled'), not `end`. browserTts rejected on any error, so speak()'s
    // rejection reached the player's catch and popped a bogus "Speech synthesis error: interrupted"
    // toast on every stop/pause. The mock's cancel() used to be a no-op, which hid this entirely.
    await installGoogleApiMock(page)
    await recordToasts(page)
    // Long-running utterance so there is a real window in which speech is active to interrupt.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    const perTurnPauseButton = page.getByRole('button', { name: 'Pause playback' }).and(page.locator('[data-size="icon-xs"]'))
    const perTurnResumeButton = page.getByRole('button', { name: 'Resume playback' }).and(page.locator('[data-size="icon-xs"]'))

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect.poll(() => getSpokenTexts(page)).toEqual(['You step into a quiet, dust-lit room.'])

    await perTurnPauseButton.click()
    await perTurnResumeButton.click()
    await perTurnPauseButton.click()
    await page.waitForTimeout(500)

    // Plain (non-retrying) assertion against the recorded history — see recordToasts for why a
    // `toHaveCount(0)` locator assertion cannot fail here.
    expect(await getRecordedToasts(page)).not.toContainEqual(
      expect.stringMatching(/Speech synthesis error|Failed to read this aloud/),
    )
  })

  test('the master play/pause control only appears in the header while on the Play screen', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await expect(page.getByRole('button', { name: 'Play latest turn aloud' })).toBeVisible()

    await page.getByRole('link', { name: 'Codex' }).click()
    await expect(page).toHaveURL(/\/codex\/.+/)
    await expect(page.getByRole('button', { name: 'Play latest turn aloud' })).toHaveCount(0)

    await page.getByTitle('Back to play').click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Play latest turn aloud' })).toBeVisible()
  })

  test('the header control narrates the latest turn and speaks its options afterward', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play latest turn aloud' }).click()

    await expect
      .poll(() => getSpokenTexts(page))
      .toEqual(['You step into a quiet, dust-lit room.', 'Your options: 1. Look around. 2. Move on.'])
  })
})
