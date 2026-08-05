import { test, expect, type Page } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

/**
 * Page-level responsive coverage for the three campaign screens. The component-level counterpart
 * lives in Storybook (`npm run test:stories` — see BottomNav/Dialog stories); this file covers
 * what only shows up once a whole page is assembled inside the app shell: that the fixed
 * BottomNav and the header's icon links stay complementary, that neither overlaps page content,
 * and that nothing overflows a phone-width viewport.
 *
 * Everything here goes through the same fake Drive/Sheets backend as the rest of the suite
 * (tests/mocks/googleApi.ts), so no real Google account or network is involved.
 */

const MOBILE = { width: 390, height: 844 } // below Tailwind's `md` (768px)
const DESKTOP = { width: 1280, height: 900 } // above it

/**
 * Sonner renders toasts pinned to the bottom of the viewport, which on a phone-width screen sits
 * directly over the Play screen's input row — so a toast left over from campaign creation can
 * intercept a click meant for the page underneath. That's a real thing on mobile, but it's a
 * *transient* overlay and not what these layout assertions are about, so hide the toast layer
 * outright rather than sprinkling waits around every interaction. addInitScript so it survives
 * the navigations each test does.
 */
async function hideToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = '[data-sonner-toaster] { display: none !important; }'
    document.documentElement.appendChild(style)
  })
}

/** Play/Codex/Settings for the campaign currently open, as `[label, path]` pairs. */
function campaignRoutes(campaignId: string): [string, string][] {
  return [
    ['Play', `/play/${campaignId}`],
    ['Codex', `/codex/${campaignId}`],
    ['Settings', `/settings/${campaignId}`],
  ]
}

async function currentCampaignId(page: Page): Promise<string> {
  const match = page.url().match(/\/(?:play|codex|settings)\/([^/?#]+)/)
  if (!match) throw new Error(`No campaign id in URL "${page.url()}"`)
  return match[1]
}

test.describe('mobile (below md)', () => {
  test.use({ viewport: MOBILE })

  /**
   * BottomNav is `md:hidden` and the header's Codex/Settings icons are `hidden md:inline-flex` —
   * deliberately complementary, so campaign navigation is reachable exactly once at any width.
   * Get one of the two conditions wrong and you either lose navigation entirely on phones or show
   * it twice. Asserted with visibility (not DOM presence): both sets of links exist in the DOM at
   * every width, and only CSS decides which is live.
   */
  test('campaign navigation lives in the bottom nav, not the header', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)
    const campaignId = await currentCampaignId(page)

    for (const [label, path] of campaignRoutes(campaignId)) {
      await page.goto(path)

      const nav = page.getByRole('navigation', { name: 'Campaign navigation' })
      await expect(nav, `${label}: bottom nav should be visible on mobile`).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Adventure' })).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Codex' })).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()

      // The header keeps only the campaign title + turn/read-aloud controls at this width.
      const header = page.getByRole('banner')
      await expect(header.getByRole('link', { name: 'Codex' })).toBeHidden()
      await expect(header.getByRole('link', { name: 'Settings' })).toBeHidden()
    }
  })

  /**
   * BottomNav is `position: fixed`, so without the app shell's `pb-16` reserve it would sit on top
   * of whatever the page ends with — on Play that's the free-text input row and the Act button,
   * i.e. the controls the whole screen exists for.
   */
  test('the fixed bottom nav never covers the end of a page', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)
    const campaignId = await currentCampaignId(page)

    for (const [label, path] of campaignRoutes(campaignId)) {
      await page.goto(path)
      await expect(page.getByRole('navigation', { name: 'Campaign navigation' })).toBeVisible()

      const overlap = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Campaign navigation"]')!
        const content = document.querySelector('[data-testid="app-content"]')!
        const navHeight = nav.getBoundingClientRect().height
        const reserved = parseFloat(getComputedStyle(content).paddingBottom)
        return { navHeight, reserved }
      })

      expect(overlap.navHeight, `${label}: bottom nav should have real height on mobile`).toBeGreaterThan(0)
      expect(
        overlap.reserved,
        `${label}: content must reserve at least the nav's height (${overlap.navHeight}px) below it`,
      ).toBeGreaterThanOrEqual(overlap.navHeight)
    }
  })

  /**
   * Horizontal overflow is the classic phone-layout bug — one fixed-width child or an un-wrapped
   * long string and the whole page scrolls sideways. Checked per page since each composes
   * different content (Play's turn log, Codex's 8-tab strip, Settings' cards).
   */
  test('no page scrolls sideways at phone width', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)
    const campaignId = await currentCampaignId(page)

    for (const [label, path] of campaignRoutes(campaignId)) {
      await page.goto(path)
      await expect(page.getByRole('navigation', { name: 'Campaign navigation' })).toBeVisible()

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(scrollWidth, `${label}: document should not overflow ${clientWidth}px horizontally`).toBeLessThanOrEqual(
        clientWidth,
      )
    }
  })

  /**
   * Regression coverage for the scroll-gated options/input on a real phone viewport — the exact
   * shape of two bugs shipped and fixed in quick succession: first the options/input staying
   * visible above unread text, then the space they vacated being left as a blank void instead of
   * the log growing into it. Both were only visible at phone width, which is why they got through.
   */
  test('Play: options and input are reachable, and hide behind a scroll affordance', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)

    const longNarrative = 'A very long narrative paragraph. '.repeat(60)
    await page.getByPlaceholder('Say or do anything…').fill('look around')
    await page.getByRole('button', { name: 'Act', exact: true }).click()
    await page.getByPlaceholder(/Paste the narrative/).fill(
      `${longNarrative}\n\n\`\`\`state\n${JSON.stringify({
        state_delta: {},
        summary_update: 'x',
        options: ['Look around', 'Move on'],
      })}\n\`\`\``,
    )
    await page.getByRole('button', { name: 'Apply turn' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()

    // Landing at the bottom of a fresh turn: both ways to act are available.
    const input = page.getByPlaceholder('Say or do anything…')
    await expect(input).toBeVisible()
    await expect(page.getByRole('button', { name: 'Look around' })).toBeVisible()

    const viewport = page.locator('[data-slot="scroll-area-viewport"]')
    const logHeightAtBottom = await viewport.evaluate((el) => el.getBoundingClientRect().height)

    // Scrolling up to reread hides them — they only make sense once you've read to the latest turn.
    await viewport.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(input).toBeHidden()
    await expect(page.getByRole('button', { name: 'Look around' })).toBeHidden()

    const scrollBack = page.getByRole('button', { name: 'Scroll to continue' })
    await expect(scrollBack).toBeVisible()

    // ...and the log grows into the freed space rather than leaving a blank void above the nav.
    const logHeightScrolledAway = await viewport.evaluate((el) => el.getBoundingClientRect().height)
    expect(logHeightScrolledAway).toBeGreaterThan(logHeightAtBottom)

    const gap = await page.evaluate(() => {
      const log = document.querySelector('[data-slot="scroll-area-viewport"]')!
      const nav = document.querySelector('nav[aria-label="Campaign navigation"]')!
      return nav.getBoundingClientRect().top - log.getBoundingClientRect().bottom
    })
    expect(gap, 'story log should reach close to the bottom nav, not leave a large empty band').toBeLessThan(160)

    // The affordance takes you back, and the controls come with it.
    await scrollBack.click()
    await expect(input).toBeVisible()
    await expect(scrollBack).toBeHidden()
  })
})

test.describe('desktop (above md)', () => {
  test.use({ viewport: DESKTOP })

  /** The other half of the complementary-navigation contract asserted on mobile above. */
  test('campaign navigation lives in the header, not a bottom nav', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)
    const campaignId = await currentCampaignId(page)

    for (const [label, path] of campaignRoutes(campaignId)) {
      await page.goto(path)

      const header = page.getByRole('banner')
      await expect(header.getByRole('link', { name: 'Codex' })).toBeVisible()
      await expect(header.getByRole('link', { name: 'Settings' })).toBeVisible()

      await expect(
        page.getByRole('navigation', { name: 'Campaign navigation' }),
        `${label}: bottom nav should be hidden above md`,
      ).toBeHidden()
    }
  })

  /** `md:pb-0` — the mobile-only reserve must not leave dead space on desktop. */
  test('no bottom-nav space is reserved', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)

    const reserved = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('[data-testid="app-content"]')!).paddingBottom),
    )
    expect(reserved).toBe(0)
  })
})
