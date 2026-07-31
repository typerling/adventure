import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

/**
 * Regression coverage for a real bug: the dialog's own `max-w-2xl` (an unprefixed class) was
 * silently losing to the base Dialog component's `sm:max-w-sm` at any viewport >= 640px, because
 * Tailwind's responsive utilities are ordered after unprefixed ones in the generated stylesheet —
 * so on desktop the turn dialog was actually capped at ~384px wide, not the ~672px the className
 * suggested. Fixed by giving every breakpoint its own explicit override (sm:/md:/lg:) instead of
 * one unprefixed class.
 */
test('the turn dialog is narrow on mobile and meaningfully wider on desktop', async ({ page }) => {
  await installGoogleApiMock(page)
  await createRandomCampaign(page)

  await page.getByPlaceholder('Say or do anything…').fill('look around')
  await page.getByRole('button', { name: 'Act', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileBox = await dialog.boundingBox()
  expect(mobileBox).not.toBeNull()
  expect(mobileBox!.width).toBeLessThan(390)
  expect(mobileBox!.width).toBeGreaterThan(300) // near-full-width, not a fixed tiny box

  await page.setViewportSize({ width: 1440, height: 900 })
  const desktopBox = await dialog.boundingBox()
  expect(desktopBox).not.toBeNull()
  // Previously capped at ~384px (sm:max-w-sm) regardless of viewport — now well past that.
  expect(desktopBox!.width).toBeGreaterThan(600)
})
