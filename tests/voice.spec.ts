import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi, simulateSpeechResult, getSpokenTexts } from './mocks/webSpeech'
import { createRandomCampaign, submitFreeTextTurn } from './helpers'

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

  test('the Read-aloud toggle only appears in the header while on the Play screen', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toBeVisible()

    await page.getByRole('link', { name: 'Codex' }).click()
    await expect(page).toHaveURL(/\/codex\/.+/)
    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toHaveCount(0)

    await page.getByTitle('Back to play').click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Read new turns aloud' })).toBeVisible()
  })
})
