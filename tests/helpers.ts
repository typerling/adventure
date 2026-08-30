import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Runs the New Campaign wizard's Random quick-fill and creates the campaign, landing on Play.
 * Shared by tests that just need *a* campaign to exist without caring about its specific
 * content — see new-campaign.spec.ts for the full manual wizard walkthrough.
 *
 * Suppresses the "Randomized a starting point…" toast itself rather than leaving it to each
 * caller: this helper clicks straight through the wizard's remaining "Next" steps with no
 * pause, and at narrower viewports that toast pins to the bottom right, over those buttons. The
 * toast lingers for `TOAST_DURATION_MS` (`src/components/ui/toast.tsx`, a few seconds) before
 * auto-dismissing, so under load — four rapid clicks in a row — it can still be sitting there
 * when a click lands, intercepting it. (Historical note: this app used sonner before issue #95's
 * migration, whose own auto-dismiss timer additionally never fired at all in headless Chromium,
 * since it paused while the document lacked real OS focus, which headless never has — the
 * hand-rolled replacement's timer isn't gated on focus, so it does eventually fire headless, but
 * still not fast enough to protect a tight click-loop like this one.) The vulnerable click-loop
 * lives entirely inside this function, so every caller was exposed
 * regardless of whether it happened to call `hideToasts` separately first — found via
 * independent review of PR #94 (issue #93), which reproduced a real failure with this exact
 * signature in a file the PR hadn't touched (`scrollbar-hidden.spec.ts`) and pointed out that a
 * per-file fix (as PR #94 originally shipped, only in `play-dialog-responsive.spec.ts`) left
 * roughly a dozen other callers still exposed.
 *
 * Uses `page.addStyleTag` (see the identical pattern in voice-elevenlabs.spec.ts), *not*
 * `hideToasts`'s `addInitScript`: an init script survives every later navigation for the rest of
 * the test, and several callers go on to call `setCampaignVoiceProviders`/`setCampaignAiMode`
 * afterward, which wait for a "Settings saved." toast to become *visible* — permanently
 * CSS-hiding toasts broke all of those (33 failures, caught by the full e2e run before this
 * landed). But `addStyleTag` isn't scoped to the page *load* either — this app is a client-routed
 * SPA (react-router), so "Create campaign" navigates to `/play/:id` without a real page
 * navigation, and the injected `<style>` node is still sitting in the same document afterward.
 * Left in place, it silently hid the *next* toast a caller actually wanted to see (e.g. `Turn
 * applied.` right after `createRandomCampaign` returns — caught the same way, by the full e2e
 * run). So the style tag is removed again once the wizard is done with it, leaving toasts visible
 * as normal everywhere after this function returns. */
export async function createRandomCampaign(page: Page): Promise<void> {
  await page.goto("/new");
  await page.getByRole("button", { name: "Random campaign" }).click();
  const toastHider = await page.addStyleTag({
    content: "[data-toast-viewport] { display: none !important; }",
  });
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  await page.getByRole("button", { name: "Create campaign" }).click();
  await expect(page).toHaveURL(/\/play\/.+/);
  await toastHider.evaluate((el) => el.remove());
}

/** Drives the manual copy/paste turn dialog end to end with a minimal, always-valid reply
 * (empty state_delta — nothing to fail deterministic validation against). */
export async function submitFreeTextTurn(
  page: Page,
  action: string,
  narrative: string,
): Promise<void> {
  await page.getByPlaceholder("Say or do anything…").fill(action);
  await page.getByRole("button", { name: "Act", exact: true }).click();

  const reply = `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {},
    summary_update: narrative,
    options: ["Look around", "Move on"],
  })}\n\`\`\``;
  await page.getByPlaceholder(/Paste the narrative/).fill(reply);
  await page.getByRole("button", { name: "Apply turn" }).click();
}

/** Switches a campaign's voice providers via its Settings page, saves, and returns to Play.
 * Call while `page` is on /play/:id, /codex/:id, or /settings/:id for that campaign. */
export async function setCampaignVoiceProviders(
  page: Page,
  opts: {
    stt?: "browser" | "elevenlabs";
    tts?: "browser" | "elevenlabs" | "huggingface-local";
  },
): Promise<void> {
  const match = page.url().match(/\/(?:play|codex|settings)\/([^/?#]+)/);
  if (!match)
    throw new Error(
      `setCampaignVoiceProviders: no campaign id in URL "${page.url()}"`,
    );
  const campaignId = match[1];

  await page.goto(`/settings/${campaignId}`);
  // Scoped to the campaign card: the "Local AI models" card below it renders its own selects,
  // and it renders *before* this card does (it doesn't wait on settings loading from Drive), so
  // an unscoped positional lookup can land on a per-model "Run on" select instead.
  const triggers = page.locator(
    '[data-testid="campaign-settings"] [data-slot="select-trigger"]',
  );

  if (opts.stt) {
    await triggers.nth(1).click();
    await page
      .getByRole("option", {
        name:
          opts.stt === "browser"
            ? "Browser (Web Speech API)"
            : "ElevenLabs (Scribe)",
      })
      .click();
  }
  if (opts.tts) {
    await triggers.nth(2).click();
    await page
      .getByRole("option", {
        name:
          opts.tts === "browser"
            ? "Browser (SpeechSynthesis)"
            : opts.tts === "elevenlabs"
              ? "ElevenLabs"
              : "Kokoro (on-device, runs locally)",
      })
      .click();
  }

  await page.getByRole("button", { name: "Save settings" }).click();
  // Save is async (a Drive write) — wait for it to actually land before navigating away, or the
  // Play page reloads and re-fetches the *old* settings.md.
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.goto(`/play/${campaignId}`);
}

const AI_MODE_OPTION_LABEL = {
  manual: "Manual (copy/paste into claude.ai or chatgpt.com)",
  api: "Direct API key (Claude)",
  local: "Local model (runs on this device)",
} as const;

/** Switches a campaign's AI mode (manual copy/paste, direct Claude API, or an on-device local
 * model) via Settings, saves, and returns to Play. Leaves the Claude model / local model choice
 * at their defaults (Sonnet 5 / Gemma 3 1B). */
export async function setCampaignAiMode(
  page: Page,
  mode: keyof typeof AI_MODE_OPTION_LABEL,
): Promise<void> {
  const match = page.url().match(/\/(?:play|codex|settings)\/([^/?#]+)/);
  if (!match)
    throw new Error(`setCampaignAiMode: no campaign id in URL "${page.url()}"`);
  const campaignId = match[1];

  await page.goto(`/settings/${campaignId}`);
  await page
    .locator('[data-testid="campaign-settings"] [data-slot="select-trigger"]')
    .first()
    .click();
  await page.getByRole("option", { name: AI_MODE_OPTION_LABEL[mode] }).click();

  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.goto(`/play/${campaignId}`);
}

/**
 * Records every toast that renders, so a test can assert one never appeared.
 *
 * Needed because the obvious spelling — `expect(page.locator('[data-toast]')).toHaveCount(0)`
 * — silently can't fail: `toHaveCount` auto-retries, and toasts auto-dismiss after a few seconds,
 * so it passes by *waiting for the toast to disappear*. (Verified: a run whose toast was provably
 * present at assertion time still passed.) A MutationObserver keeps the whole history instead of
 * sampling one instant, which also catches toasts that come and go between assertions.
 *
 * Call before navigating.
 */
export async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as Record<string, unknown>).__toasts = seen;
    // Polling rather than a MutationObserver: a freshly-inserted toast has no layout yet, and
    // the toaster may not produce a further childList mutation to trigger a rescan, so an
    // observer-only version silently missed toasts. `textContent` (not `innerText`) for the same
    // no-layout-required reason. Toasts live for seconds, so 40ms cannot miss one.
    setInterval(() => {
      for (const el of document.querySelectorAll("[data-toast]")) {
        const text = (el.textContent ?? "").trim();
        if (text && !seen.includes(text)) seen.push(text);
      }
    }, 40);
  });
}

/**
 * Expands one of Settings' collapsible download-management cards ("Local AI models" / "Kokoro
 * voice model", issue #22) if it isn't already open — both default collapsed except when the
 * currently open campaign already uses that mode (see CollapsibleSettingsCard.tsx and
 * Settings.tsx's `localModelsDefaultOpen`/`kokoroModelDefaultOpen`). `testId` is the card's own
 * `data-testid` (e.g. `"local-models-card"`); the toggle carries `data-testid="{testId}-toggle"`.
 * Safe to call even when the card is already expanded.
 */
export async function expandSettingsCard(page: Page, testId: string): Promise<void> {
  const toggle = page.getByTestId(`${testId}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** Every toast text seen so far, in first-appearance order. Requires recordToasts() first. */
export async function getRecordedToasts(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      ((window as unknown as Record<string, unknown>).__toasts as string[]) ??
      [],
  );
}

/**
 * Hides toasts for the rest of the test, from page load onward. Call before navigating (it
 * installs an init script — see the `document.head` guard below, needed because init scripts run
 * before the document exists, so touching `document.documentElement` directly throws and
 * Playwright silently swallows that).
 *
 * Needed because a toast (`TOAST_DURATION_MS`, `src/components/ui/toast.tsx` — a few seconds) a
 * test doesn't care about can still be on screen when the next assertion/click runs — on a
 * phone-width viewport that's directly over Play's input row, and even at desktop-ish heights the
 * story log (h-[max(50svh,calc(100svh-10rem))] when at the bottom of a turn, see Play.tsx) can
 * leave little enough room below it that a lingering toast intercepts clicks on the Act button.
 * (This app used sonner before issue #95's migration to a hand-rolled toast — sonner's own
 * auto-dismiss timer paused while the document lacked real OS focus, which headless Chromium
 * never has, so it never fired *at all* headless; the replacement's timer isn't focus-gated, so
 * it does eventually fire, but a few seconds is still long enough to need this helper for a test
 * moving faster than that.) Use this when a test has no reason to assert anything about toast
 * content; see the mid-test `addStyleTag` variant in voice-elevenlabs.spec.ts for a test that
 * needs a toast visible *first*, then out of the way.
 */
export async function hideToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const inject = () => {
      const style = document.createElement("style");
      style.textContent = "[data-toast-viewport] { display: none !important; }";
      document.head.appendChild(style);
    };
    if (document.head) inject();
    else document.addEventListener("DOMContentLoaded", inject, { once: true });
  });
}
