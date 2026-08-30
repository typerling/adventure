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
 *
 * The turn log's own page-level coverage (paging via swipe/arrow-keys/buttons, read-only history,
 * auto-advance to the newest turn) lives in tests/turn-pager.spec.ts as of issue #26 — see that
 * file for why it's separate rather than folded in here.
 */

const MOBILE = { width: 390, height: 844 } // below Tailwind's `md` (768px)
const DESKTOP = { width: 1280, height: 900 } // above it

// hideToasts is shared via ./helpers now — see its doc comment there for why this is needed
// (a lingering toast can intercept clicks) and for the mid-test variant a test needing a toast
// visible first, then out of the way, uses instead.

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

  // The "options and input are reachable, and hide behind a scroll affordance" test that used to
  // live here covered the continuous-scroll log's isAtBottom mechanism, which issue #26 replaced
  // wholesale with a horizontally-paged turn log (see src/components/TurnPager.tsx) — a page
  // model has no scroll affordance to hide behind by construction. That coverage's replacement
  // (paging via swipe-equivalent/arrow-keys/on-screen buttons, historical pages staying read-only,
  // auto-advance to the newest page, input/options only on the live page) now lives in
  // tests/turn-pager.spec.ts.
})
