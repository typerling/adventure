import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'

/**
 * Page-level responsive coverage for the three campaign screens. The component-level counterpart
 * lives in Storybook (`npm run test:stories` — see Header.stories.tsx); this file covers what
 * only shows up once a whole page is assembled inside the app shell: that the hamburger menu
 * actually works once wired to real routes, that it doesn't overlap page content, and that
 * nothing overflows a phone-width viewport.
 *
 * Everything here goes through the same fake Drive/Sheets backend as the rest of the suite
 * (tests/mocks/googleApi.ts), so no real Google account or network is involved.
 *
 * As of the hamburger-menu rewrite (see issue #21), there is a single nav pattern at every
 * width — no more `BottomNav`/header-icon split to assert as complementary. The menu itself is
 * exercised at both MOBILE and DESKTOP below, since it's meant to behave identically at either.
 */

const MOBILE = { width: 390, height: 844 } // below Tailwind's `md` (768px)
const DESKTOP = { width: 1280, height: 900 } // above it

// hideToasts is shared via ./helpers now — see its doc comment there for why this is needed
// (headless Chromium never fires Sonner's auto-dismiss timer) and for the mid-test variant a
// test needing a toast visible first, then out of the way, uses instead.

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

async function openMenu(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click()
}

/**
 * `createRandomCampaign` only waits for the URL to reach `/play/:id`, not for `Play.tsx`'s own
 * `usePlayHeaderStore().setContext` effect to have committed — so a test that opens the header
 * menu immediately afterwards can race the header from "no campaign" (Settings-only) to "campaign
 * open" (Codex/Settings/Back to campaigns) state, intermittently seeing the sparse menu. Waiting
 * for a Play-only element sidesteps the race, matching the pattern other specs already use (e.g.
 * tests/drive-cache.spec.ts) before touching campaign-aware header state.
 */
async function waitForCampaignHeaderReady(page: Page): Promise<void> {
  await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
}

for (const [viewportLabel, viewport] of [
  ['mobile', MOBILE],
  ['desktop', DESKTOP],
] as const) {
  test.describe(`hamburger menu (${viewportLabel})`, () => {
    test.use({ viewport })

    test('is sparse (Settings only) when no campaign is open', async ({ page }) => {
      await installGoogleApiMock(page)
      await hideToasts(page)
      await page.goto('/')

      const trigger = page.getByRole('banner').getByRole('button', { name: 'Menu' })
      await expect(trigger).toBeVisible()
      await openMenu(page)

      await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Codex' })).toHaveCount(0)
      await expect(page.getByRole('menuitem', { name: 'Back to campaigns' })).toHaveCount(0)

      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(page).toHaveURL(/\/settings$/)
    })

    test('has Codex, Settings, and Back to campaigns when a campaign is open', async ({ page }) => {
      await installGoogleApiMock(page)
      await hideToasts(page)
      await createRandomCampaign(page)
      const campaignId = await currentCampaignId(page)

      for (const [label, path] of campaignRoutes(campaignId)) {
        await page.goto(path)
        await openMenu(page)

        const codex = page.getByRole('menuitem', { name: 'Codex' })
        const settings = page.getByRole('menuitem', { name: 'Settings' })
        const back = page.getByRole('menuitem', { name: 'Back to campaigns' })
        await expect(codex, `${label}: Codex item`).toBeVisible()
        await expect(settings, `${label}: Settings item`).toBeVisible()
        await expect(back, `${label}: Back to campaigns item`).toBeVisible()

        // Close it back out (Escape) so the next iteration starts from a known state.
        await page.keyboard.press('Escape')
        await expect(codex).toBeHidden()
      }
    })

    test('navigates to Codex and closes on selection', async ({ page }) => {
      await installGoogleApiMock(page)
      await hideToasts(page)
      await createRandomCampaign(page)
      await waitForCampaignHeaderReady(page)

      await openMenu(page)
      await page.getByRole('menuitem', { name: 'Codex' }).click()

      await expect(page).toHaveURL(/\/codex\/.+/)
      await expect(page.getByRole('menu')).toHaveCount(0)
    })

    test('Back to campaigns returns to the Dashboard', async ({ page }) => {
      await installGoogleApiMock(page)
      await hideToasts(page)
      await createRandomCampaign(page)
      await waitForCampaignHeaderReady(page)

      await openMenu(page)
      await page.getByRole('menuitem', { name: 'Back to campaigns' }).click()

      await expect(page).toHaveURL(/\/$/)
    })

    test('closes when clicking outside', async ({ page }) => {
      await installGoogleApiMock(page)
      await hideToasts(page)
      await createRandomCampaign(page)
      await waitForCampaignHeaderReady(page)

      await openMenu(page)
      await expect(page.getByRole('menu')).toBeVisible()

      // Click somewhere on the page that isn't the menu or its trigger.
      await page.mouse.click(viewport.width / 2, viewport.height - 10)
      await expect(page.getByRole('menu')).toHaveCount(0)
    })

    test('is keyboard operable', async ({ page }) => {
      await installGoogleApiMock(page)
      await hideToasts(page)
      await createRandomCampaign(page)
      await waitForCampaignHeaderReady(page)

      const trigger = page.getByRole('banner').getByRole('button', { name: 'Menu' })
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menu')).toBeVisible()

      // Arrow down moves the roving highlight onto an item; Enter activates whatever's
      // highlighted. Which item ends up highlighted after one ArrowDown is a Radix internal
      // (opening via Enter can auto-highlight the first item, making the first explicit ArrowDown
      // land on the second) and isn't stable enough under a loaded test run to assert exactly —
      // the point of this test is that keyboard navigation reaches *some* item and activates it,
      // landing on one of the menu's known destinations, not which item specifically.
      await page.keyboard.press('ArrowDown')
      await expect(page.locator('[data-slot="dropdown-menu-item"][data-highlighted]')).toBeVisible()

      await page.keyboard.press('Enter')

      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(page).toHaveURL(/\/(codex|settings)\/[^/]+$|\/$/)
    })
  })
}

test.describe('mobile (below md)', () => {
  test.use({ viewport: MOBILE })

  /**
   * No page-level layout reserve exists any more (there's nothing fixed-position at the bottom
   * of the screen since BottomNav was removed) — this is the horizontal-overflow half of that
   * same "phone-width layout stays sane" coverage.
   */
  test('no page scrolls sideways at phone width', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)
    const campaignId = await currentCampaignId(page)

    for (const [label, path] of campaignRoutes(campaignId)) {
      await page.goto(path)
      await expect(page.getByRole('banner').getByRole('button', { name: 'Menu' })).toBeVisible()

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
   *
   * As of the inline-options rework (see issue #25), options render *inside* the scrollable log
   * (TurnContent, positioned at the live turn's `{{options}}` token or appended at the end as a
   * fallback — this turn uses the fallback, exercising that path) rather than in a separately
   * conditionally-mounted panel below it. That changes what "hidden" means for the option
   * button specifically: scrolling away no longer unmounts it (it's ordinary log content, so
   * `toBeHidden()` — which only checks CSS/DOM state, not scroll position — would report it as
   * still visible), it scrolls out of the browser viewport along with the rest of the unread
   * text above it, which `toBeInViewport()` does check. The free-text input is a separate
   * element below the log and still gets unmounted exactly as before, so it keeps the stricter
   * `toBeHidden()` assertion.
   */
  test('Play: options and input are reachable, and hide behind a scroll affordance', async ({ page }) => {
    await installGoogleApiMock(page)
    await hideToasts(page)
    await createRandomCampaign(page)

    const longNarrative = 'A very long narrative paragraph. '.repeat(60)
    await page.getByPlaceholder('Say or do anything…').fill('look around')
    await page.getByRole('button', { name: 'Act', exact: true }).click()
    // No {{options}} token in this narrative — deliberately exercising the fallback path
    // (options appended after the narrative) alongside the legacy plain-string `options` shape.
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
    const lookAroundOption = page.getByRole('button', { name: 'Look around' })
    await expect(input).toBeVisible()
    await expect(lookAroundOption).toBeInViewport()

    const viewport = page.locator('[data-slot="scroll-area-viewport"]')
    const logHeightAtBottom = await viewport.evaluate((el) => el.getBoundingClientRect().height)

    // Scrolling up to reread hides them — they only make sense once you've read to the latest turn.
    await viewport.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(input).toBeHidden()
    // The option, now part of the unread text below, scrolls out of view with it rather than
    // being unmounted — see this test's doc comment for why toBeInViewport() replaces
    // toBeHidden() here specifically.
    await expect(lookAroundOption).not.toBeInViewport()

    const scrollBack = page.getByRole('button', { name: 'Scroll to continue' })
    await expect(scrollBack).toBeVisible()

    // ...and the log grows into the freed space rather than leaving a blank void at the bottom of
    // the page.
    const logHeightScrolledAway = await viewport.evaluate((el) => el.getBoundingClientRect().height)
    expect(logHeightScrolledAway).toBeGreaterThan(logHeightAtBottom)

    const gap = await page.evaluate(() => {
      const log = document.querySelector('[data-slot="scroll-area-viewport"]')!
      return window.innerHeight - log.getBoundingClientRect().bottom
    })
    // Tight enough to actually bite: the bug this guards left a ~400px void, and the healthy
    // value here is small (just the page's own bottom padding, now that nothing bottom-anchored
    // reserves extra space). 80px catches a moderate regression, not just a catastrophic one.
    expect(gap, 'story log should reach close to the bottom of the viewport, not leave a large empty band').toBeLessThan(
      80,
    )

    // The affordance takes you back, and the controls come with it — asserted as a *settled*
    // state, deliberately past the ~1.5s observer-suppression window in Play.tsx. Checking
    // immediately after the click is a false green: a bug where the scroll landed short and the
    // state then flipped back (options hidden again, affordance re-shown, clicking it just
    // alternating forever) looked fine for the first second and only appeared afterwards.
    await scrollBack.click()
    await expect(input).toBeVisible()
    await expect(lookAroundOption).toBeInViewport()
    await expect(scrollBack).toBeHidden()

    await page.waitForTimeout(2000)
    await expect(input, 'controls must stay put once the scroll settles').toBeVisible()
    await expect(scrollBack, 'affordance must not come back while at the bottom').toBeHidden()

    // And it genuinely reached the bottom, rather than stopping short of it.
    const distanceFromBottom = await viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    expect(distanceFromBottom, 'should land at the bottom of the log').toBeLessThan(40)
  })
})
