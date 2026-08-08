import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, hideToasts, submitFreeTextTurn } from './helpers'

/**
 * Coverage for issue #70: `story/summary/rolling.md` is seeded with a placeholder
 * (`EMPTY_ROLLING_SUMMARY_PLACEHOLDER`, campaignRepo.ts) that `useCampaign.ts`'s `submitReply`
 * used to only ever append onto, so it stuck around as a permanent leading prefix on every
 * campaign's stored rolling summary forever. `stripRollingSummaryPlaceholder`
 * (campaignRepo.ts) now strips it before appending, both on a campaign's first-ever real
 * `summary_update` and — because it strips wherever the prefix is still present, not just on a
 * literal first write — self-healing any campaign whose rolling.md already carried it in from
 * before this fix (this suite's "already-affected campaign" cases below, simulated by writing
 * that shape directly into the fake Drive store since the real app can no longer produce it).
 */

async function openRecapDialog(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: /^Turn \d+ ·/ }).click()
}

/** submitFreeTextTurn's "Apply turn" click resolves as soon as the click event fires, not once
 * the async submitReply (parse -> validate -> apply, including the Drive write this suite reads
 * back) actually finishes — callers that only assert against *visible* UI get this for free via
 * Playwright's built-in actionability polling (a locator obscured by the still-open dialog keeps
 * retrying until it closes), but a synchronous read straight from the fake Drive store has no
 * such retry and can race ahead of the write. Wait for the dialog to actually close first. */
async function waitForTurnApplied(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test("a campaign's first real turn produces a clean stored rolling summary with no placeholder text", async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await hideToasts(page)
  await createRandomCampaign(page)

  const narrative = 'You step into the tavern and the din quiets for a moment.'
  await submitFreeTextTurn(page, 'look around', narrative)
  await waitForTurnApplied(page)

  const rollingFile = store.allFiles().find((f) => f.name === 'rolling.md')
  expect(rollingFile?.content).toBe(narrative)
  expect(rollingFile?.content).not.toContain('No story yet')

  // The recap dialog reads the same in-memory rollingSummary this turn just wrote — confirms the
  // fix reaches the UI, not just the stored file.
  await openRecapDialog(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('So far')).toBeVisible()
  await expect(dialog.getByText(narrative)).toBeVisible()
  await expect(dialog.getByText('No story yet', { exact: false })).toHaveCount(0)
})

test('a second real turn keeps appending normally (no re-introduced placeholder, no double-stripping real content)', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await hideToasts(page)
  await createRandomCampaign(page)

  await submitFreeTextTurn(page, 'look around', 'You step into the tavern.')
  await waitForTurnApplied(page)
  await submitFreeTextTurn(page, 'order a drink', 'The bartender pours you a whiskey.')
  await waitForTurnApplied(page)

  const rollingFile = store.allFiles().find((f) => f.name === 'rolling.md')
  expect(rollingFile?.content).toBe('You step into the tavern. The bartender pours you a whiskey.')
})

test('a fresh, turn-less campaign sends "(no summary yet)" to the AI prompt instead of the raw placeholder', async ({
  page,
}) => {
  await installGoogleApiMock(page)
  await hideToasts(page)
  await createRandomCampaign(page)

  await page.getByPlaceholder('Say or do anything…').fill('look around')
  await page.getByRole('button', { name: 'Act', exact: true }).click()

  const promptText = await page.locator('textarea[readonly]').first().inputValue()
  expect(promptText).toContain('(no summary yet)')
  expect(promptText).not.toContain('No story yet')
})

test('an already-affected campaign (placeholder baked into stored content from before this fix) self-heals its stored rolling summary on its next turn', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await hideToasts(page)
  await createRandomCampaign(page)

  // Simulate a campaign that already had at least one turn applied under the old, unfixed
  // append-only logic — the real app can no longer produce this shape, so it's written directly
  // into the fake store, mirroring issue #70's "campaign that already had at least one turn
  // applied before this ships" backward-compatibility case.
  const rollingFile = store.allFiles().find((f) => f.name === 'rolling.md')!
  store.updateContent(
    rollingFile.id,
    '_No story yet — this campaign has not started._ You arrived in Redrock at dusk.',
  )
  // Reload so useCampaign re-reads the seeded content instead of serving what's already cached
  // in memory from createRandomCampaign.
  await page.reload()

  await submitFreeTextTurn(page, 'ask around', 'The bartender mentions a stolen ledger.')
  await waitForTurnApplied(page)

  const updated = store.allFiles().find((f) => f.name === 'rolling.md')
  expect(updated?.content).toBe('You arrived in Redrock at dusk. The bartender mentions a stolen ledger.')
  expect(updated?.content).not.toContain('No story yet')
})

test("recap.ts's placeholder strip still displays cleanly for an already-affected campaign that has not yet self-healed", async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await hideToasts(page)
  await createRandomCampaign(page)

  const rollingFile = store.allFiles().find((f) => f.name === 'rolling.md')!
  store.updateContent(
    rollingFile.id,
    '_No story yet — this campaign has not started._ You arrived in Redrock at dusk.',
  )
  await page.reload()

  // No new turn submitted yet — the stored file still carries the placeholder prefix (it only
  // self-heals on the next write), but the display layer must not show it.
  await openRecapDialog(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('So far')).toBeVisible()
  await expect(dialog.getByText('You arrived in Redrock at dusk.')).toBeVisible()
  await expect(dialog.getByText('No story yet', { exact: false })).toHaveCount(0)

  const stillUnhealed = store.allFiles().find((f) => f.name === 'rolling.md')
  expect(stillUnhealed?.content).toContain('No story yet')
})

test('the AI prompt strips the placeholder for an already-affected campaign that has not yet self-healed', async ({
  page,
}) => {
  const store = await installGoogleApiMock(page)
  await hideToasts(page)
  await createRandomCampaign(page)

  const rollingFile = store.allFiles().find((f) => f.name === 'rolling.md')!
  store.updateContent(
    rollingFile.id,
    '_No story yet — this campaign has not started._ You arrived in Redrock at dusk.',
  )
  await page.reload()

  await page.getByPlaceholder('Say or do anything…').fill('ask around')
  await page.getByRole('button', { name: 'Act', exact: true }).click()

  const promptText = await page.locator('textarea[readonly]').first().inputValue()
  expect(promptText).toContain('You arrived in Redrock at dusk.')
  expect(promptText).not.toContain('No story yet')
})
