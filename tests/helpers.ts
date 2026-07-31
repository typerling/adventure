import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** Runs the New Campaign wizard's Random quick-fill and creates the campaign, landing on Play.
 * Shared by tests that just need *a* campaign to exist without caring about its specific
 * content — see new-campaign.spec.ts for the full manual wizard walkthrough. */
export async function createRandomCampaign(page: Page): Promise<void> {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Random campaign' }).click()
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Next' }).click()
  }
  await page.getByRole('button', { name: 'Create campaign' }).click()
  await expect(page).toHaveURL(/\/play\/.+/)
}

/** Drives the manual copy/paste turn dialog end to end with a minimal, always-valid reply
 * (empty state_delta — nothing to fail deterministic validation against). */
export async function submitFreeTextTurn(page: Page, action: string, narrative: string): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill(action)
  await page.getByRole('button', { name: 'Act', exact: true }).click()

  const reply = `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {},
    summary_update: narrative,
    options: ['Look around', 'Move on'],
  })}\n\`\`\``
  await page.getByPlaceholder(/Paste the narrative/).fill(reply)
  await page.getByRole('button', { name: 'Apply turn' }).click()
}

/** Switches a campaign's voice providers via its Settings page, saves, and returns to Play.
 * Call while `page` is on /play/:id, /codex/:id, or /settings/:id for that campaign. */
export async function setCampaignVoiceProviders(
  page: Page,
  opts: { stt?: 'browser' | 'elevenlabs'; tts?: 'browser' | 'elevenlabs' },
): Promise<void> {
  const match = page.url().match(/\/(?:play|codex|settings)\/([^/?#]+)/)
  if (!match) throw new Error(`setCampaignVoiceProviders: no campaign id in URL "${page.url()}"`)
  const campaignId = match[1]

  await page.goto(`/settings/${campaignId}`)
  const triggers = page.locator('[data-slot="select-trigger"]')

  if (opts.stt) {
    await triggers.nth(1).click()
    await page.getByRole('option', { name: opts.stt === 'browser' ? 'Browser (Web Speech API)' : 'ElevenLabs (Scribe)' }).click()
  }
  if (opts.tts) {
    await triggers.nth(2).click()
    await page.getByRole('option', { name: opts.tts === 'browser' ? 'Browser (SpeechSynthesis)' : 'ElevenLabs' }).click()
  }

  await page.getByRole('button', { name: 'Save settings' }).click()
  // Save is async (a Drive write) — wait for it to actually land before navigating away, or the
  // Play page reloads and re-fetches the *old* settings.md.
  await expect(page.getByText('Settings saved.')).toBeVisible()
  await page.goto(`/play/${campaignId}`)
}

const AI_MODE_OPTION_LABEL = {
  manual: 'Manual (copy/paste into claude.ai or chatgpt.com)',
  api: 'Direct API key (Claude)',
  local: 'Local model (runs on this device)',
} as const

/** Switches a campaign's AI mode (manual copy/paste, direct Claude API, or an on-device local
 * model) via Settings, saves, and returns to Play. Leaves the Claude model / local model choice
 * at their defaults (Sonnet 5 / Gemma 3 1B). */
export async function setCampaignAiMode(page: Page, mode: keyof typeof AI_MODE_OPTION_LABEL): Promise<void> {
  const match = page.url().match(/\/(?:play|codex|settings)\/([^/?#]+)/)
  if (!match) throw new Error(`setCampaignAiMode: no campaign id in URL "${page.url()}"`)
  const campaignId = match[1]

  await page.goto(`/settings/${campaignId}`)
  await page.locator('[data-slot="select-trigger"]').first().click()
  await page.getByRole('option', { name: AI_MODE_OPTION_LABEL[mode] }).click()

  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()
  await page.goto(`/play/${campaignId}`)
}

/**
 * Records every Sonner toast that renders, so a test can assert one never appeared.
 *
 * Needed because the obvious spelling — `expect(page.locator('[data-sonner-toast]')).toHaveCount(0)`
 * — silently can't fail: `toHaveCount` auto-retries, and toasts auto-dismiss after a few seconds,
 * so it passes by *waiting for the toast to disappear*. (Verified: a run whose toast was provably
 * present at assertion time still passed.) A MutationObserver keeps the whole history instead of
 * sampling one instant, which also catches toasts that come and go between assertions.
 *
 * Call before navigating.
 */
export async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as Record<string, unknown>).__toasts = seen
    // Polling rather than a MutationObserver: a freshly-inserted toast has no layout yet, and
    // Sonner may not produce a further childList mutation to trigger a rescan, so an
    // observer-only version silently missed toasts. `textContent` (not `innerText`) for the same
    // no-layout-required reason. Toasts live for seconds, so 40ms cannot miss one.
    setInterval(() => {
      for (const el of document.querySelectorAll('[data-sonner-toast]')) {
        const text = (el.textContent ?? '').trim()
        if (text && !seen.includes(text)) seen.push(text)
      }
    }, 40)
  })
}

/** Every toast text seen so far, in first-appearance order. Requires recordToasts() first. */
export async function getRecordedToasts(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as Record<string, unknown>).__toasts as string[]) ?? [])
}
