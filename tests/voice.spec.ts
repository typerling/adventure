import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi, simulateSpeechResult, getSpokenTexts } from './mocks/webSpeech'
import { createRandomCampaign, getRecordedToasts, recordToasts, submitFreeTextTurn } from './helpers'

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

  test('Read aloud speaks new turns but not campaign history on load', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    expect(await getSpokenTexts(page)).toEqual([])

    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop reading turns aloud' })).toBeVisible()

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await expect.poll(() => getSpokenTexts(page)).toEqual(['You step into a quiet, dust-lit room.'])
  })

  test('does not speak a turn applied before Read aloud was turned on', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    // Read aloud is still off — applying the turn above must not have queued any speech.
    expect(await getSpokenTexts(page)).toEqual([])

    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await page.waitForTimeout(200)
    expect(await getSpokenTexts(page)).toEqual([])
  })

  test('voice controls are hidden when the browser has no speech support', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: false, ttsSupported: false })
    await createRandomCampaign(page)

    await expect(page.getByRole('button', { name: 'Speak your action' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toHaveCount(0)
    // The rest of the turn loop still works without voice.
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  })

  test('a turn can be replayed on demand via its own play button, regardless of Read aloud', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    // Read aloud stays off — this turn is never auto-narrated.
    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()
    expect(await getSpokenTexts(page)).toEqual([])

    // "In case one missed the opportunity" — replaying it manually still works.
    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect.poll(() => getSpokenTexts(page)).toEqual(['You step into a quiet, dust-lit room.'])
  })

  test('stopping playback is not reported as an error', async ({ page }) => {
    // Regression test: SpeechSynthesis reports a cancelled utterance through `error`
    // ('interrupted'/'canceled'), not `end`. browserTts rejected on any error, so speak()'s
    // rejection reached Play.tsx's catch and popped a bogus "Speech synthesis error: interrupted"
    // toast on every stop, every read-aloud toggle-off, and every auto-narrate that pre-empted a
    // still-playing turn. The mock's cancel() used to be a no-op, which hid this entirely.
    await installGoogleApiMock(page)
    await recordToasts(page)
    // Long-running utterance so there is a real window in which speech is active to interrupt.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true, ttsDurationMs: 5000 })
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await page.getByRole('button', { name: 'Play this turn aloud' }).click()
    await expect.poll(() => getSpokenTexts(page)).toEqual(['You step into a quiet, dust-lit room.'])

    // Stop mid-utterance, then toggle read-aloud on and off (which also cancels) — none of these
    // are failures, so none should surface an error.
    await page.getByRole('button', { name: 'Stop playback' }).click()
    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await page.getByRole('button', { name: 'Stop reading turns aloud' }).click()
    await page.waitForTimeout(500)

    // Plain (non-retrying) assertion against the recorded history — see recordToasts for why a
    // `toHaveCount(0)` locator assertion cannot fail here.
    expect(await getRecordedToasts(page)).not.toContainEqual(
      expect.stringMatching(/Speech synthesis error|Failed to read this aloud/),
    )
  })

  test('the Read-aloud toggle only appears in the header while on the Play screen', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toBeVisible()

    await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'Codex' }).click()
    await expect(page).toHaveURL(/\/codex\/.+/)
    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toHaveCount(0)

    await page.getByTitle('Back to play').click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toBeVisible()
  })
})
