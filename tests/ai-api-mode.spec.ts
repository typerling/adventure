import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { installClaudeApiMock, defaultValidReply } from './mocks/claude'
import { createRandomCampaign, hideToasts, setCampaignAiMode } from './helpers'

const KEY_STORAGE = 'adventure:claude-api-key'

function claudeCard(page: Page) {
  return page.locator('[data-slot="card"]', { has: page.locator('#claudeKey') })
}

/** The Claude API key card only renders on a campaign's own Settings page once that campaign's
 * AI mode is set to 'api' (see Settings.tsx) — so every test that needs to fill in a key first
 * needs a campaign already in that mode, not just a bare /settings visit. */
async function saveClaudeKey(page: Page, campaignId: string, key: string): Promise<void> {
  await page.goto(`/settings/${campaignId}`)
  await page.locator('#claudeKey').fill(key)
  await claudeCard(page).getByRole('button', { name: /Save key|Clear key/ }).click()
}

async function actAndOpenDialog(page: Page, action: string): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill(action)
  await page.getByRole('button', { name: 'Act', exact: true }).click()
}

function campaignIdFromUrl(page: Page): string {
  const match = page.url().match(/\/play\/([^/?#]+)/)
  if (!match) throw new Error(`campaignIdFromUrl: no campaign id in URL "${page.url()}"`)
  return match[1]
}

test.describe('Claude direct API mode', () => {
  test('API key entered in Settings persists in localStorage across reloads', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'api')
    const campaignId = campaignIdFromUrl(page)

    await page.goto(`/settings/${campaignId}`)
    await expect(page.locator('#claudeKey')).toHaveValue('')

    await saveClaudeKey(page, campaignId, 'sk-ant-test-12345')
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY_STORAGE)).toBe('sk-ant-test-12345')

    await page.reload()
    await expect(page.locator('#claudeKey')).toHaveValue('sk-ant-test-12345')

    await page.locator('#claudeKey').fill('')
    await claudeCard(page).getByRole('button', { name: 'Clear key' }).click()
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY_STORAGE)).toBeNull()
  })

  test('a turn auto-generates and applies with no copy/paste step', async ({ page }) => {
    await installGoogleApiMock(page)
    // A small artificial delay so there's a reliable window to click the status line below
    // before it resolves — an instant mock response would race the click against the dialog
    // closing itself once the turn applies.
    const claude = await installClaudeApiMock(page, { delayMs: 500 })

    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'api')
    const campaignId = campaignIdFromUrl(page)
    await saveClaudeKey(page, campaignId, 'sk-ant-test-12345')
    await page.goto(`/play/${campaignId}`)

    await page.getByPlaceholder('Say or do anything…').fill('look around')
    await page.getByRole('button', { name: 'Act', exact: true }).click()

    // No dialog pops open while generating — just a small clickable status line, per the request
    // to not show the prompt/progress dialog for every auto-generated turn.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const statusLine = page.getByText('Generating your turn…')
    await expect(statusLine).toBeVisible()

    await statusLine.click()
    await expect(page.getByText('Claude is narrating your turn')).toBeVisible()

    // Applies automatically and the dialog closes — no "Apply turn" click involved.
    await expect(page.getByText('You step forward and the torchlight flickers against the old stone.')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    expect(claude.requests).toHaveLength(1)
    expect(claude.requests[0].model).toBe('claude-sonnet-5')
    expect(claude.requests[0].prompt).toContain('look around')
  })

  test('the applied turn records the action that was actually submitted', async ({ page }) => {
    // Regression test: startTurn recorded the action via setState and kicked off generation in the
    // same tick, so the generation closure still saw the *previous* render's value. Turn 1 logged
    // an empty action, turn 2 logged turn 1's, and so on — permanently, since playerAction goes
    // into the append-only Drive story log and is fed back to the AI as history. The existing
    // coverage only asserted the outgoing prompt, which is built from the argument directly and so
    // looked correct either way.
    await installGoogleApiMock(page)
    await installClaudeApiMock(page, {
      reply: (_prompt, callIndex) => defaultValidReply(`Narrative for turn ${callIndex + 1}.`),
    })

    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'api')
    const campaignId = campaignIdFromUrl(page)
    await saveClaudeKey(page, campaignId, 'sk-ant-test-12345')
    // setCampaignAiMode/saveClaudeKey above each wait on their own "saved" toast as a sync point,
    // so toasts can't be hidden any earlier than this — but from here on, two turns apply
    // back-to-back with no dialog/pause between them (auto mode skips the manual-paste dialog
    // entirely), and headless Chromium never auto-dismisses the first turn's "Turn applied."
    // toast, so it can still be sitting over the Act button when the loop clicks it again. Nothing
    // below needs to see a toast, so just hide them from this navigation on rather than timing
    // around it.
    await hideToasts(page)
    await page.goto(`/play/${campaignId}`)

    for (const [i, action] of ['look around', 'open the door'].entries()) {
      await page.getByPlaceholder('Say or do anything…').fill(action)
      await page.getByRole('button', { name: 'Act', exact: true }).click()
      await expect(page.getByText(`Narrative for turn ${i + 1}.`)).toBeVisible()
      // Each turn's header echoes the persisted playerAction.
      await expect(page.getByText(`Turn ${i + 1} — you: ${action}`)).toBeVisible()
    }
  })

  test('missing API key surfaces a clear error with a Retry option', async ({ page }) => {
    await installGoogleApiMock(page)
    await installClaudeApiMock(page)

    // Deliberately not saving a key.
    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'api')

    await actAndOpenDialog(page, 'look around')

    await expect(page.getByText('Add your Claude API key in Settings first.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  test('a validation failure surfaces issues, and Retry sends a correction prompt', async ({ page }) => {
    await installGoogleApiMock(page)
    // chunkCount > 1 (issue #29): the invalid reply genuinely arrives split across several SSE
    // content_block_delta events and is reassembled client-side before validation ever sees it —
    // confirms streaming doesn't weaken or bypass the same validation a non-streamed reply gets.
    const claude = await installClaudeApiMock(page, {
      chunkCount: 4,
      reply: (_prompt, callIndex) =>
        callIndex === 0
          ? // References an item that cannot exist in a freshly created campaign — always invalid.
            `You reach for something that isn't there.\n\n\`\`\`state\n${JSON.stringify({
              state_delta: { inventory_remove: [{ name: 'NonexistentItemXYZ', qty: 1 }] },
              options: ['Look around', 'Move on'],
            })}\n\`\`\``
          : defaultValidReply('A quiet room, nothing more.'),
    })

    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'api')
    const campaignId = campaignIdFromUrl(page)
    await saveClaudeKey(page, campaignId, 'sk-ant-test-12345')
    await page.goto(`/play/${campaignId}`)

    await actAndOpenDialog(page, 'search the room')

    await expect(page.getByText("This reply doesn't match the documented state:")).toBeVisible()
    await expect(page.getByText(/isn't in inventory/)).toBeVisible()

    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByText('A quiet room, nothing more.')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    expect(claude.requests).toHaveLength(2)
    expect(claude.requests[1].prompt).toContain('Your previous reply had these problems')
  })

  test('narrative text streams into a live preview before the turn is applied (issue #29)', async ({ page }) => {
    await installGoogleApiMock(page)
    const narrative =
      'Word-one word-two word-three word-four word-five word-six word-seven word-eight word-nine word-ten reaches the door.'
    // Real, timed gaps between chunks (not an instant mock response) — genuinely exercises the
    // "partial text visible, then finalized" UI state rather than asserting on a race.
    const claude = await installClaudeApiMock(page, {
      reply: defaultValidReply(narrative),
      chunkCount: 6,
      chunkDelayMs: 250,
    })

    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'api')
    const campaignId = campaignIdFromUrl(page)
    await saveClaudeKey(page, campaignId, 'sk-ant-test-12345')
    await page.goto(`/play/${campaignId}`)

    await actAndOpenDialog(page, 'search the room')
    // Auto mode doesn't pop the dialog open on its own while generating (see startTurn) — click
    // the small status line to open it and see the live preview, same as the "no copy/paste step"
    // test above.
    const statusLine = page.getByText('Generating your turn…')
    await expect(statusLine).toBeVisible()
    await statusLine.click()

    const preview = page.getByLabel('Streaming narrative preview')
    // The very start of the narrative arrives in the first chunk and should show up well before
    // the whole ~1.5s stream finishes.
    await expect(preview).toContainText('Word-one word-two', { timeout: 5000 })
    // Still mid-stream at this point (the trailing ```state fence is only ever in a late chunk,
    // after all the narrative words) — the live preview is genuinely partial, not the final text,
    // and critically: nothing has parsed/applied a state block yet, because there isn't a complete
    // one to parse. If parsing ran against this partial text it would either throw or apply
    // nothing, not silently wait — the dialog staying open with no error is itself part of the
    // assertion.
    await expect(preview).not.toContainText('```state')
    await expect(page.getByText("This reply doesn't match the documented state:")).toHaveCount(0)
    await expect(page.getByRole('dialog')).toBeVisible()

    // Once the stream completes, parseTurnReply/validateStateDelta/applyStateDelta run against the
    // full, complete reply — same pipeline, same result as a non-streamed turn — and the dialog
    // closes on success exactly like today.
    await expect(page.getByText(narrative)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(claude.requests).toHaveLength(1)
  })
})
