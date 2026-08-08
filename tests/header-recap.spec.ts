import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'

/**
 * End-to-end coverage for issue #24: the header's info dialog now shows a "quick recap" (rolling
 * summary excerpt + active quests) alongside the pre-existing current-location line. Both are
 * sourced from data useCampaign already has in memory (see src/pages/Play.tsx and
 * src/lib/recap.ts) — this test's own job is to confirm the dialog actually renders that content
 * once it's there, at both mobile and desktop width per the epic's (#20) working agreement.
 */

const MOBILE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 900 }

const SUMMARY_TEXT =
  'You rode into Redrock chasing rumors of a stolen railroad ledger, and found the sheriff was in on it.'

/** Submits one manual turn whose reply carries quest_updates and a summary_update — the direct
 * way to seed representative recap content (a rolling summary excerpt plus a couple of active
 * quests) through the real turn pipeline, the same one Play.tsx's recap fields are built from. */
async function submitTurnWithRecapContent(page: Page): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill('investigate the saloon')
  await page.getByRole('button', { name: 'Act', exact: true }).click()

  const reply = `The saloon falls quiet as you push through the doors.\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {
      quest_updates: [
        { title: 'Find the stolen railroad ledger', status: 'active', description: 'Last seen with the sheriff.' },
        { title: "Earn the bartender's trust", status: 'active' },
      ],
    },
    summary_update: SUMMARY_TEXT,
    options: ['Ask the bartender', 'Search the back room'],
  })}\n\`\`\``
  await page.getByPlaceholder(/Paste the narrative/).fill(reply)
  await page.getByRole('button', { name: 'Apply turn' }).click()
}

async function openRecapDialog(page: Page): Promise<void> {
  // The info button's accessible name is the current turn/location label ("Turn N · <location>"),
  // set by usePlayHeaderStore — see Header.tsx.
  await page.getByRole('banner').getByRole('button', { name: /^Turn \d+ ·/ }).click()
}

for (const viewport of [
  { name: 'mobile', size: MOBILE },
  { name: 'desktop', size: DESKTOP },
]) {
  test(`info dialog shows current location, recap summary, and active quests at ${viewport.name} width`, async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await page.setViewportSize(viewport.size)

    await createRandomCampaign(page)
    await submitTurnWithRecapContent(page)

    await openRecapDialog(page)

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Recap' })).toBeVisible()
    // Current location — the dialog's original, pre-#24 content.
    await expect(dialog.getByText(/^Turn \d+ ·/)).toBeVisible()

    // Rolling-summary excerpt.
    await expect(dialog.getByText('So far')).toBeVisible()
    await expect(dialog.getByText(SUMMARY_TEXT)).toBeVisible()

    // Active quests.
    await expect(dialog.getByText('Active quests')).toBeVisible()
    await expect(dialog.getByText('Find the stolen railroad ledger')).toBeVisible()
    await expect(dialog.getByText("Earn the bartender's trust")).toBeVisible()

    // No horizontal overflow at this viewport — dialogs are a common place for that (issue #24's
    // own stated concern), so this is a real assertion, not boilerplate.
    const scrollWidth = await dialog.evaluate((el) => el.scrollWidth)
    const clientWidth = await dialog.evaluate((el) => el.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
  })
}

test('a campaign with no rolling summary or active quests yet shows just the location', async ({ page }) => {
  await installGoogleApiMock(page)
  await hideToasts(page)
  await page.setViewportSize(MOBILE)

  await createRandomCampaign(page)
  // No turn submitted yet — rollingSummary is empty and Quests is empty, straight off campaign
  // creation.
  await openRecapDialog(page)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Recap' })).toBeVisible()
  await expect(dialog.getByText(/^Turn \d+ ·/)).toBeVisible()
  await expect(dialog.getByText('So far')).not.toBeVisible()
  await expect(dialog.getByText('Active quests')).not.toBeVisible()
})
