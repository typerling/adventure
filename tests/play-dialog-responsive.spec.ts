import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'

/**
 * Regression coverage for a real bug: the dialog's own `max-w-2xl` (an unprefixed class) was
 * silently losing to the base Dialog component's `sm:max-w-sm` at any viewport >= 640px, because
 * Tailwind's responsive utilities are ordered after unprefixed ones in the generated stylesheet —
 * so on desktop the turn dialog was actually capped at ~384px wide, not the ~672px the className
 * suggested. Fixed by giving every breakpoint its own explicit override (sm:/md:/lg:) instead of
 * one unprefixed class.
 *
 * Each size opens the dialog *after* its viewport is in place, rather than opening once and
 * resizing underneath it: a resize doesn't synchronously recompute an already-open fixed-position
 * element's resolved max-width, so measuring straight after `setViewportSize` could catch the
 * dialog still at the pre-resize `w-full` width — which is exactly how this spec used to read a
 * width of precisely 390px (the new viewport width) and fail.
 *
 * There is a cheaper component-level version of this in Storybook — see dialog.stories.tsx's
 * NarrowOnMobile/WiderOnDesktop, which need no campaign or mocked Drive backend. This one is kept
 * because it exercises the real Play screen, where the class stack actually lives.
 */
const SIZES = [
  {
    label: 'mobile',
    viewport: { width: 390, height: 844 },
    // max-w-[calc(100%-2rem)] applies (no sm:/md:/lg: at this width): near-full-width with a 1rem
    // gutter each side — never edge-to-edge, and never a fixed tiny box.
    expect: (width: number) => {
      expect(width).toBeLessThan(390)
      expect(width).toBeGreaterThan(300)
    },
  },
  {
    label: 'desktop',
    viewport: { width: 1440, height: 900 },
    // Previously capped at ~384px (sm:max-w-sm) regardless of viewport — now well past that.
    expect: (width: number) => {
      expect(width).toBeGreaterThan(600)
    },
  },
]

for (const size of SIZES) {
  test(`the turn dialog is sized for its breakpoint (${size.label})`, async ({ page }) => {
    await page.setViewportSize(size.viewport)
    // `createRandomCampaign`'s "Random campaign" click fires a "Randomized a starting point…"
    // success toast immediately, then this test clicks straight through the wizard's remaining
    // "Next" steps with no pause — at the mobile viewport that toast pins to the bottom right over
    // those buttons. Headless Chromium never fires Sonner's auto-dismiss timer (see hideToasts's
    // own doc comment), so under load the toast can still be sitting there when the click lands,
    // intercepting it. Found while verifying Phase 2 tier 2 (issue #93)'s migration against the
    // full suite: this exact spec failed here, reproducibly, only under the full suite's
    // concurrent load (never in isolation, on either this branch or pre-migration `main`) — timing
    // margins under load are close enough to this known Sonner/headless-Chromium gap that this was
    // likely latent already, this migration just wasn't confirmed to be the trigger either way.
    // Every other `createRandomCampaign` caller in a similarly tight spot already carries this
    // exact guard (e.g. turn-pager.spec.ts, npc-profiles.spec.ts) — this spec was simply missing
    // it. Fixed with the same established mechanism those use, not a loosened assertion.
    await hideToasts(page)
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await page.getByPlaceholder('Say or do anything…').fill('look around')
    await page.getByRole('button', { name: 'Act', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    size.expect(box!.width)
  })
}
