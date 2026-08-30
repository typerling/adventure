import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi, getSpokenTexts } from './mocks/webSpeech'
import { createRandomCampaign } from './helpers'

/**
 * End-to-end coverage for issue #96's invisible `{{v:Name}}...{{/v}}` speaker-attribution token
 * (the first ticket in the multi-voice-narration epic #36). This ships no playback change at
 * all — no voice actually switches yet — so what matters here is the integration-level contract:
 * the token must never reach the rendered DOM or the TTS spoken text, for both a reply that uses
 * the new token and a legacy-shaped reply that predates it. `src/components/TurnContent.speakerTokens.stories.tsx`
 * covers the underlying parsing/segmentation logic (unclosed tags, stray closers, nesting,
 * mid-sentence splits, the heuristic fallback) at the unit level; this file is the same style of
 * "wired into the real turn loop" coverage `inline-turn-content.spec.ts` provides for
 * `{{options}}`.
 */

async function submitReplyWithState(
  page: import('@playwright/test').Page,
  action: string,
  narrative: string,
  options: unknown,
): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill(action)
  await page.getByRole('button', { name: 'Act', exact: true }).click()
  const reply = `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {},
    summary_update: narrative,
    options,
  })}\n\`\`\``
  await page.getByPlaceholder(/Paste the narrative/).fill(reply)
  await page.getByRole('button', { name: 'Apply turn' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

test.describe('speaker attribution tokens', () => {
  test('a {{v:Name}}...{{/v}} token never reaches the rendered DOM', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitReplyWithState(
      page,
      'approach the caretaker',
      'Old Maren looks up as you enter. {{v:Old Maren}}"Keys like that one don\'t come free," she says.{{/v}} She sets down her cup.',
      [{ label: 'Offer payment' }, { label: 'Leave' }],
    )

    // The dialogue itself is visible...
    await expect(page.getByText(/Keys like that one don't come free/)).toBeVisible()
    await expect(page.getByText(/She sets down her cup/)).toBeVisible()
    // ...but none of the literal token markup ever leaked into the page.
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('{{v:')
    expect(bodyText).not.toContain('{{/v}}')
  })

  test('a {{v:Name}}...{{/v}} token never reaches the spoken/TTS text', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop reading turns aloud' })).toBeVisible()

    await submitReplyWithState(
      page,
      'approach the caretaker',
      'Old Maren looks up as you enter. {{v:Old Maren}}"Keys like that one don\'t come free," she says.{{/v}} She sets down her cup.',
      [{ label: 'Offer payment' }],
    )
    await expect(page.getByText(/Keys like that one don't come free/)).toBeVisible()

    await expect.poll(() => getSpokenTexts(page)).toHaveLength(1)
    const [spoken] = await getSpokenTexts(page)
    expect(spoken).not.toContain('{{v:')
    expect(spoken).not.toContain('{{/v}}')
    // The dialogue content itself is still read, just without the markup around it.
    expect(spoken).toContain("Keys like that one don't come free")
    expect(spoken).toContain('She sets down her cup')
  })

  test('a legacy reply with no tokens at all renders and speaks exactly as it did before this shipped', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop reading turns aloud' })).toBeVisible()

    // A pre-existing/historical-shaped narrative: plain quoted dialogue, no {{v:}} tokens — the
    // only shape every turn logged before this ticket could possibly have.
    const legacyNarrative =
      'Old Maren sets down her cup and studies you for a long moment.\n"You want the key," she says, "but keys like that one don\'t come free."'

    await submitReplyWithState(page, 'approach the caretaker', legacyNarrative, [{ label: 'Offer payment' }])

    await expect(page.getByText(/studies you for a long moment/)).toBeVisible()
    await expect(page.getByText(/keys like that one don't come free/)).toBeVisible()

    await expect.poll(() => getSpokenTexts(page)).toHaveLength(1)
    const [spoken] = await getSpokenTexts(page)
    // No token markup ever existed in this input, so none should appear — and the whole
    // narrative is read as a single continuous script exactly as it was before this ticket.
    expect(spoken).not.toContain('{{')
    expect(spoken).toContain('studies you for a long moment')
    expect(spoken).toContain("keys like that one don't come free")
  })
})
