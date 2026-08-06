import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installFakeWebSpeechApi, getSpokenTexts } from './mocks/webSpeech'
import { createRandomCampaign } from './helpers'

/**
 * End-to-end coverage for issue #25's markdown-based, inline-options turn content renderer.
 * `src/components/TurnContent.stories.tsx` covers the component in isolation (Storybook); this
 * file covers it wired into the real turn loop — that selecting an inline option actually drives
 * `startTurn`, that the `{{options}}` placeholder and its fallback both work end to end, that the
 * new `{label, manus}` options shape isn't just incidentally exercised by the legacy-string
 * fallback path, and that the TTS spoken script reads prose then options in order.
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

test.describe('inline turn content', () => {
  test('an inline {{options}} placeholder renders options between prose, and selecting one starts the next turn', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitReplyWithState(
      page,
      'look around',
      'You step into the sunken chapel.\n\n{{options}}\n\nThe silence presses in, waiting.',
      [{ label: 'Search the altar' }, { label: 'Leave the chapel' }],
    )

    await expect(page.getByText('You step into the sunken chapel.')).toBeVisible()
    await expect(page.getByText('The silence presses in, waiting.')).toBeVisible()
    const searchOption = page.getByRole('button', { name: 'Search the altar' })
    await expect(searchOption).toBeVisible()

    // The option renders between the two prose segments, not appended after both of them.
    const before = page.getByText('You step into the sunken chapel.')
    const after = page.getByText('The silence presses in, waiting.')
    const beforePos = await before.evaluate((el) => el.getBoundingClientRect().top)
    const optionPos = await searchOption.evaluate((el) => el.getBoundingClientRect().top)
    const afterPos = await after.evaluate((el) => el.getBoundingClientRect().top)
    expect(optionPos).toBeGreaterThan(beforePos)
    expect(afterPos).toBeGreaterThan(optionPos)

    // Selecting it drives startTurn exactly like typing the same text would — it opens the
    // manual-mode dialog with that action already recorded as the pending player action.
    await searchOption.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByPlaceholder(/Paste the narrative/).fill(
      `You find nothing but dust.\n\n\`\`\`state\n${JSON.stringify({
        state_delta: {},
        summary_update: 'x',
        options: [{ label: 'Leave' }],
      })}\n\`\`\``,
    )
    await page.getByRole('button', { name: 'Apply turn' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByText('Turn 2 — you: Search the altar')).toBeVisible()
    await expect(page.getByText('You find nothing but dust.')).toBeVisible()
  })

  test('a reply with no {{options}} token falls back to appending options after the narrative', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitReplyWithState(page, 'look around', 'A quiet room, nothing more.', [
      { label: 'Search the room' },
      { label: 'Leave' },
    ])

    const narrative = page.getByText('A quiet room, nothing more.')
    const option = page.getByRole('button', { name: 'Search the room' })
    await expect(narrative).toBeVisible()
    await expect(option).toBeVisible()

    // Fallback behavior: the option renders below the narrative, not above it.
    const narrativeTop = await narrative.evaluate((el) => el.getBoundingClientRect().top)
    const optionTop = await option.evaluate((el) => el.getBoundingClientRect().top)
    expect(optionTop).toBeGreaterThan(narrativeTop)

    await option.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByPlaceholder(/Paste the narrative/)).toHaveValue('')
  })

  test('the new {label, manus} options shape renders by label and is selectable — not just the legacy string[] fallback', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitReplyWithState(page, 'look around', 'Old Maren studies you for a long moment.', [
      { label: 'Ask about the key', manus: 'Ask Old Maren about the key' },
      { label: 'Leave' },
    ])

    // Renders by label on screen, not by its (distinct) spoken manus.
    const option = page.getByRole('button', { name: 'Ask about the key', exact: false })
    await expect(option).toBeVisible()
    await expect(page.getByText('Ask Old Maren about the key')).toHaveCount(0)

    await option.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByPlaceholder(/Paste the narrative/).fill(
      `She names her price.\n\n\`\`\`state\n${JSON.stringify({
        state_delta: {},
        summary_update: 'x',
        options: [{ label: 'Agree' }],
      })}\n\`\`\``,
    )
    await page.getByRole('button', { name: 'Apply turn' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByText('Turn 2 — you: Ask about the key')).toBeVisible()
  })

  test('read-aloud speaks the prose then the options, using manus where supplied', async ({ page }) => {
    await installGoogleApiMock(page)
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true })
    await createRandomCampaign(page)

    await page.getByRole('button', { name: 'Read new turns aloud' }).click()
    await expect(page.getByRole('button', { name: 'Stop reading turns aloud' })).toBeVisible()

    await submitReplyWithState(page, 'look around', 'You step into a quiet, dust-lit room.', [
      { label: 'Search the desk' },
      { label: 'Leave', manus: 'Leave the room' },
    ])
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()

    await expect.poll(() => getSpokenTexts(page)).toHaveLength(1)
    const [spoken] = await getSpokenTexts(page)

    // Prose comes first, then the options block, and each option is read by its manus (falling
    // back to the label when none is supplied) — in the same order they're offered on screen.
    const proseIndex = spoken.indexOf('You step into a quiet, dust-lit room.')
    const searchIndex = spoken.indexOf('Search the desk')
    const leaveIndex = spoken.indexOf('Leave the room')
    expect(proseIndex).toBeGreaterThanOrEqual(0)
    expect(searchIndex).toBeGreaterThan(proseIndex)
    expect(leaveIndex).toBeGreaterThan(searchIndex)
    // The on-screen label "Leave" alone (distinct from its manus "Leave the room") isn't what
    // gets spoken.
    expect(spoken).not.toMatch(/\bLeave\.(?!\s*the room)/)
  })
})
