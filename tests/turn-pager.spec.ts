import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, hideToasts, submitFreeTextTurn } from './helpers'

/**
 * End-to-end coverage for issue #26's page model — one turn per horizontally-swipeable page,
 * replacing the old continuous-scroll log (see src/components/TurnPager.tsx and its own stories
 * for the component-level coverage; this file covers it wired into the real turn loop).
 *
 * This is the direct replacement for mobile-layout.spec.ts's old "options and input are
 * reachable, and hide behind a scroll affordance" test, which exercised the isAtBottom mechanism
 * this ticket removed entirely — see that file's doc comment.
 */

const MOBILE = { width: 390, height: 844 }

function pager(page: Page) {
  return page.locator('[data-testid="turn-pager"]')
}

function turnPage(page: Page, turn: number) {
  return page.locator(`[data-testid="turn-page-${turn}"]`)
}

/** Waits until TurnPager's IntersectionObserver confirms the scroll actually landed on the given
 * page — asserting on text/button visibility alone is unreliable here, since every page stays
 * mounted in the DOM at once (that's what makes the horizontal scroll-snap work), so unscoped
 * visibility checks can pass before the position has actually settled. */
async function waitForCurrentPage(page: Page, index: number): Promise<void> {
  await expect(pager(page)).toHaveAttribute('data-current-index', String(index))
}

/** Scrolls the pager directly to a given turn's page — the "swipe-equivalent" mechanism per issue
 * #26's ask (real touch-drag emulation isn't reliably available in this suite's headless Chromium
 * setup; a direct scroll to the same geometry a swipe would land on is what the issue's own
 * scoping comment suggests as the alternative). */
async function scrollPagerToTurn(page: Page, turn: number): Promise<void> {
  await page.evaluate((t) => {
    const container = document.querySelector('[data-testid="turn-pager"]') as HTMLElement | null
    const target = document.querySelector(`[data-testid="turn-page-${t}"]`) as HTMLElement | null
    if (!container || !target) throw new Error(`turn-pager or turn-page-${t} not found`)
    const left = target.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft
    container.scrollTo({ left, behavior: 'auto' })
  }, turn)
}

test.describe('turn pager', () => {
  test.use({ viewport: MOBILE })

  test('a fresh turn auto-advances to its page, with input and options only there', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
    await expect(page.getByRole('dialog')).toBeHidden()

    await waitForCurrentPage(page, 0)
    await expect(page.getByText('You step into a quiet, dust-lit room.')).toBeVisible()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect(turnPage(page, 1).getByRole('button', { name: 'Look around' })).toBeVisible()

    await submitFreeTextTurn(page, 'move on', 'A second room, just as quiet.')
    await expect(page.getByRole('dialog')).toBeHidden()

    // Auto-advanced to the newest page — its content and the input/options are visible again,
    // without any manual paging.
    await waitForCurrentPage(page, 1)
    await expect(page.getByText('A second room, just as quiet.')).toBeVisible()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect(turnPage(page, 2).getByRole('button', { name: 'Look around' })).toBeVisible()
  })

  test('on-screen Previous/Next page through read-only history and back to the live page', async ({ page }) => {
    await hideToasts(page) // three turns apply back-to-back below with no pause between them
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'go north', 'The path forks north of the camp.')
    await expect(page.getByRole('dialog')).toBeHidden()
    await submitFreeTextTurn(page, 'go east', 'A stream cuts across the eastern trail.')
    await expect(page.getByRole('dialog')).toBeHidden()
    await submitFreeTextTurn(page, 'follow the stream', 'The stream leads to a quiet clearing.')
    await expect(page.getByRole('dialog')).toBeHidden()

    const prev = page.getByRole('button', { name: 'Previous turn' })
    const next = page.getByRole('button', { name: 'Next turn' })
    const input = page.getByPlaceholder('Say or do anything…')

    // Starts on the live (3rd) page.
    await waitForCurrentPage(page, 2)
    await expect(next).toBeDisabled()

    await prev.click()
    await waitForCurrentPage(page, 1)
    await expect(page.getByText('A stream cuts across the eastern trail.')).toBeVisible()
    await expect(input).toBeHidden()
    // Read-only: TurnContent renders no options block at all without onSelectOption, so this
    // historical page has no option buttons (its per-turn "play aloud" button is unrelated and
    // stays regardless — any turn can be replayed).
    await expect(turnPage(page, 2).getByRole('button', { name: 'Look around' })).toHaveCount(0)
    await expect(turnPage(page, 2).getByRole('button', { name: 'Move on' })).toHaveCount(0)

    await prev.click()
    await waitForCurrentPage(page, 0)
    await expect(prev).toBeDisabled()
    await expect(page.getByText('The path forks north of the camp.')).toBeVisible()
    await expect(input).toBeHidden()

    // Paging forward returns to the live page — input and options come back.
    await next.click()
    await next.click()
    await waitForCurrentPage(page, 2)
    await expect(next).toBeDisabled()
    await expect(page.getByText('The stream leads to a quiet clearing.')).toBeVisible()
    await expect(input).toBeVisible()
    await expect(turnPage(page, 3).getByRole('button', { name: 'Look around' })).toBeVisible()
  })

  test('arrow keys page between turns the same way the on-screen buttons do', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'open the gate', 'The gate swings open with a groan.')
    await expect(page.getByRole('dialog')).toBeHidden()
    await submitFreeTextTurn(page, 'step through', 'Beyond it, a courtyard overgrown with vines.')
    await expect(page.getByRole('dialog')).toBeHidden()

    await waitForCurrentPage(page, 1)
    const input = page.getByPlaceholder('Say or do anything…')
    await expect(input).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await waitForCurrentPage(page, 0)
    await expect(page.getByText('The gate swings open with a groan.')).toBeVisible()
    await expect(input).toBeHidden()

    await page.keyboard.press('ArrowRight')
    await waitForCurrentPage(page, 1)
    await expect(page.getByText('Beyond it, a courtyard overgrown with vines.')).toBeVisible()
    await expect(input).toBeVisible()
  })

  test('arrow keys are ignored while an open dialog has focus, not just while a text field does', async ({
    page,
  }) => {
    // Flagged in PR #38's review: the arrow-key handler checked for a focused text field but not
    // for an open dialog, so pressing ArrowLeft/Right while, say, the manual-paste dialog's
    // Cancel button had focus silently paged the *background* content behind the modal.
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'open the gate', 'The gate swings open with a groan.')
    await expect(page.getByRole('dialog')).toBeHidden()
    await submitFreeTextTurn(page, 'step through', 'Beyond it, a courtyard overgrown with vines.')
    await expect(page.getByRole('dialog')).toBeHidden()
    await waitForCurrentPage(page, 1)

    // Open the dialog again (without submitting) and focus a non-text-field control inside it.
    await page.getByPlaceholder('Say or do anything…').fill('look around')
    await page.getByRole('button', { name: 'Act', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const cancelButton = page.getByRole('button', { name: 'Cancel' })
    await cancelButton.focus()
    await expect(cancelButton).toBeFocused()

    await page.keyboard.press('ArrowLeft')
    // The page underneath must not have moved — this is the actual bug: a BUTTON isn't an
    // INPUT/TEXTAREA, so the original text-field-only check let this fall through. Asserting
    // toHaveAttribute('data-current-index', '1') *immediately* would be a false green regardless
    // of whether the bug is fixed: the attribute already reads '1' before any scroll/observer
    // settling even begins, so an auto-retrying "is it 1" check matches trivially on the starting
    // value rather than proving it *stayed* 1 (verified the hard way — this test passed even
    // against the unfixed handler until rewritten this way). Give any wrongly-triggered scroll
    // time to actually happen and the observer time to confirm it before checking.
    await page.waitForTimeout(800)
    await waitForCurrentPage(page, 1)

    await cancelButton.click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('a swipe-equivalent scroll to a page updates which page is current, read-only for history', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitFreeTextTurn(page, 'enter the vault', 'Cold air rushes from the vault door.')
    await expect(page.getByRole('dialog')).toBeHidden()
    await submitFreeTextTurn(page, 'step inside', 'Shelves of forgotten ledgers line the walls.')
    await expect(page.getByRole('dialog')).toBeHidden()

    await waitForCurrentPage(page, 1)

    await scrollPagerToTurn(page, 1)
    await waitForCurrentPage(page, 0)
    await expect(page.getByText('Cold air rushes from the vault door.')).toBeVisible()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeHidden()
    await expect(turnPage(page, 1).getByRole('button', { name: 'Look around' })).toHaveCount(0)
    await expect(turnPage(page, 1).getByRole('button', { name: 'Move on' })).toHaveCount(0)

    await scrollPagerToTurn(page, 2)
    await waitForCurrentPage(page, 1)
    await expect(page.getByText('Shelves of forgotten ledgers line the walls.')).toBeVisible()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  })
})
