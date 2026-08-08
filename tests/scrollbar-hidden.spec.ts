import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, submitFreeTextTurn } from './helpers'

/**
 * Regression coverage for issue #69: TurnPager's swipe/scroll-snap container (and Codex's
 * horizontally-scrollable tab strip, which has the same shape of problem) use `overflow-x-auto`
 * so touch/trackpad swipe and CSS scroll-snap work — but that also makes some browsers/OSes
 * (notably desktop with non-overlay scrollbars) render a visible horizontal scrollbar, which reads
 * as unwanted UI chrome given both already have real, accessible navigation (TurnPager's Previous/
 * Next buttons; Codex's clickable tabs). The fix (src/index.css's `scrollbar-none` utility) hides
 * the scrollbar visually via `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`
 * without touching overflow/scroll-snap — this asserts the CSS actually lands on both containers,
 * at both a phone width (where the scrollbar issue was reported to sometimes appear too, per the
 * issue) and desktop, and that the container is still genuinely scrollable (content still
 * overflows) so a false-green "no scrollbar because nothing to scroll" can't slip through.
 */

const MOBILE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 900 }

async function assertScrollbarHiddenAndScrollable(page: Page, testId: string): Promise<void> {
  const container = page.locator(`[data-testid="${testId}"]`)
  await expect(container).toBeVisible()

  const scrollbarWidth = await container.evaluate((el) => getComputedStyle(el).scrollbarWidth)
  expect(scrollbarWidth).toBe('none')

  const { scrollWidthPx, clientWidthPx } = await container.evaluate((el) => ({
    scrollWidthPx: el.scrollWidth,
    clientWidthPx: el.clientWidth,
  }))
  expect(scrollWidthPx).toBeGreaterThan(clientWidthPx)
}

test.describe('scrollbar chrome is hidden on swipe/scroll containers', () => {
  for (const [name, viewport] of [
    ['mobile', MOBILE],
    ['desktop', DESKTOP],
  ] as const) {
    test(`TurnPager's pager container has no visible scrollbar at ${name} width`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await installGoogleApiMock(page)
      await createRandomCampaign(page)

      // Two pages are enough to guarantee horizontal overflow (each page is `w-full shrink-0`).
      await submitFreeTextTurn(page, 'look around', 'You step into a quiet, dust-lit room.')
      await expect(page.getByRole('dialog')).toBeHidden()
      await submitFreeTextTurn(page, 'move on', 'A second room, just as quiet.')
      await expect(page.getByRole('dialog')).toBeHidden()

      await assertScrollbarHiddenAndScrollable(page, 'turn-pager')
    })
  }

  for (const [name, viewport] of [
    ['mobile', MOBILE],
    ['desktop', DESKTOP],
  ] as const) {
    test(`Codex's tab strip has no visible scrollbar at ${name} width`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await installGoogleApiMock(page)
      await createRandomCampaign(page)

      // Same route as navigation.spec.ts uses to reach Codex — via the header's hamburger menu,
      // not a raw goto, so this also exercises the real campaign-aware link.
      await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click()
      await page.getByRole('menuitem', { name: 'Codex' }).click()
      await expect(page).toHaveURL(/\/codex\/.+/)
      await expect(page.getByRole('heading', { name: 'Codex' })).toBeVisible()

      const tabList = page.getByRole('tablist')
      await expect(tabList).toBeVisible()
      const scrollbarWidth = await tabList.evaluate((el) => getComputedStyle(el).scrollbarWidth)
      expect(scrollbarWidth).toBe('none')
    })
  }
})
