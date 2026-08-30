import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import { installFakeWebSpeechApi } from "./mocks/webSpeech";
import {
  createRandomCampaign,
  expandSettingsCard,
  setCampaignAiMode,
  setCampaignVoiceProviders,
} from "./helpers";

const GLOBAL_SETTINGS_STORAGE_KEY = "adventure:global-settings";

/**
 * Issue #77: every field that used to live in `CampaignSettings`/`settings.md` except
 * `summarizationCadence` (AI mode, Claude model, local model, STT/TTS provider, ElevenLabs/Kokoro
 * voice IDs) moved to a single global, device-scoped, localStorage-backed store
 * (`src/lib/settings/globalSettings.ts`) — there is no more per-campaign/global split for those
 * fields. This supersedes `settings-restructure.spec.ts` (issue #22), whose coverage assumed that
 * split still existed.
 *
 * Settings' resulting structure: "This campaign" now holds only the summarization-cadence field
 * (the one field issue #77 deliberately kept per-campaign — see CampaignSettings' own doc
 * comment) and only renders when a campaign is open; "AI & voice providers" is unconditional,
 * global, and identical regardless of which campaign (if any) is open; "Account" is unchanged.
 * The two on-device download-management cards ("Local AI models"/"Kokoro voice model") default
 * open/collapsed based on the *global* AI mode/TTS provider now, not which campaign is open.
 */

test.describe("Settings structure (issue #77)", () => {
  test("the global Settings page (no campaign open) has no 'This campaign' section, but AI & voice providers and Account are unconditional", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "This campaign" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "AI & voice providers" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByText("AI mode", { exact: true })).toBeVisible();

    // The two download-management cards' titles are still discoverable...
    await expect(
      page.getByText("Local AI models", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Kokoro voice model", { exact: true }),
    ).toBeVisible();
    // ...but collapsed: the default global AI mode/TTS provider (manual/browser) use neither.
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByTestId("kokoro-model-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("a per-campaign Settings page adds a 'This campaign' section holding only the summarization cadence", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignId}`);

    const headings = page.getByRole("heading", {
      name: /^(This campaign|AI & voice providers|Account)$/,
    });
    await expect(headings).toHaveCount(3);
    await expect(headings.nth(0)).toHaveText("This campaign");
    await expect(headings.nth(1)).toHaveText("AI & voice providers");
    await expect(headings.nth(2)).toHaveText("Account");

    // "This campaign" holds only the cadence field now — no AI-mode/provider selects moved along
    // with it (those live in the global "AI & voice providers" card instead).
    await expect(page.locator('[data-testid="campaign-cadence"] #cadence')).toBeVisible();
    await expect(
      page.locator('[data-testid="campaign-cadence"] [data-slot="select-trigger"]'),
    ).toHaveCount(0);
  });

  test("a global AI mode/TTS provider of manual/browser leaves both download-management cards collapsed regardless of whether a campaign is open", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignId}`);

    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByTestId("kokoro-model-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("setting the global AI mode to local defaults the Local AI models card open everywhere, but not the Kokoro one", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await setCampaignAiMode(page, "local");

    // No campaign was open when setCampaignAiMode ran (setCampaignAiMode/setCampaignVoiceProviders
    // always operate on the global page — see helpers.ts) — confirm the effect is visible on the
    // bare global Settings page too, not just wherever it happened to be set.
    await page.goto("/settings");
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("kokoro-model-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // And the expanded card's real content is actually visible, not just marked expanded.
    await expect(
      page.locator('[data-testid="local-model-row-onnx-community/gemma-3-1b-it-ONNX"]'),
    ).toBeVisible();
  });

  test("setting the global TTS provider to Kokoro defaults the Kokoro voice model card open everywhere, but not the Local AI models one", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

    await page.goto("/settings");
    await expect(page.getByTestId("kokoro-model-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(
      page.getByRole("button", { name: "Download voice model now" }),
    ).toBeVisible();
  });

  test("expanding and re-collapsing the Local AI models card doesn't disturb its download-management state", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    // Force the model download itself to fail fast — same technique as ai-local-mode.spec.ts,
    // not the point of this test (which only cares about the toggle, not a real download).
    await page.route(/huggingface\.co|hf\.co/, (route) => route.abort("failed"));
    await page.goto("/settings");

    const row = page.locator(
      '[data-testid="local-model-row-onnx-community/gemma-3-1b-it-ONNX"]',
    );
    await expect(row).toHaveCount(0);

    await expandSettingsCard(page, "local-models-card");
    const downloadButton = row.getByRole("button", { name: "Download" });
    await expect(downloadButton).toBeVisible();
    await downloadButton.click();
    await expect(row.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);

    // Collapse mid-download...
    await page.getByTestId("local-models-card-toggle").click();
    await expect(row).toHaveCount(0);

    // ...and re-expand: the in-flight download (a module-level singleton, not tied to this row's
    // mount — see localModel.ts) is still tracked, not reset by the collapse/expand cycle.
    await page.getByTestId("local-models-card-toggle").click();
    await expect(downloadButton).toBeVisible({ timeout: 15_000 });
    await expect(downloadButton).toBeEnabled();
  });

  test("manually collapsing the Local AI models card survives editing the AI-mode dropdown in the same visit", async ({
    page,
  }) => {
    // Found in independent review of #76 (still holds post-#77, now against the global form
    // instead of a per-campaign one): CollapsibleSettingsCard's remount key was originally derived
    // from `localModelsDefaultOpen` itself — the same live value the AI-mode dropdown edits in
    // real time, with no Save required. Editing that dropdown therefore forced an unwanted
    // remount that silently threw away whatever the player had just manually toggled. Since #77,
    // there's no remount key at all: `defaultOpen` is derived from the saved global settings and
    // CollapsibleSettingsCard only reads it once, on mount (see its own doc comment) — a live,
    // unsaved dropdown edit can no longer affect it either way.
    await installGoogleApiMock(page);
    await setCampaignAiMode(page, "local");
    await page.goto("/settings");

    // Global AI mode is 'local', so the card starts expanded (its documented default).
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Player manually collapses it.
    await page.getByTestId("local-models-card-toggle").click();
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Player then flips the AI-mode dropdown away and back to "local" — no Save click, just
    // browsing the dropdown, which is enough to update the in-memory form either way.
    await page
      .locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
      .first()
      .click();
    await page.getByRole("option", { name: "Manual (copy/paste into claude.ai or chatgpt.com)" }).click();
    await page
      .locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
      .first()
      .click();
    await page.getByRole("option", { name: "Local model (runs on this device)" }).click();

    // The player's manual collapse must still hold — not silently reopened by the dropdown edit.
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

/**
 * The issue's own explicit definition-of-done: a setting changed while one campaign is open must
 * be visible when a *different* campaign is opened next — the whole point of collapsing the
 * per-campaign/global split. Genre-agnostic by construction (these fields never touched
 * campaign-specific data), so any two campaigns exercise this identically.
 */
test.describe("a global setting changed for one campaign is visible for another (issue #77 definition of done)", () => {
  test("AI mode + Claude model, changed while campaign A is open, apply to campaign B without being re-set there", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page); // campaign A
    await setCampaignAiMode(page, "api");
    await page.goto("/settings");
    // Bump the Claude model away from its default too, so this isn't just re-proving the default.
    await page
      .locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
      .nth(1)
      .click();
    await page.getByRole("option", { name: /Opus 5/ }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    await createRandomCampaign(page); // campaign B — a second, distinct campaign
    const campaignB = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignB}`);

    const triggers = page.locator('[data-testid="global-settings"] [data-slot="select-trigger"]');
    await expect(triggers.first()).toContainText("Direct API key (Claude)");
    await expect(triggers.nth(1)).toContainText("Opus 5");
  });

  test("TTS provider + Kokoro voice ID, changed while campaign A is open, apply to campaign B", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page); // campaign A
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    await page.goto("/settings");
    await page.locator("#kokoroVoiceId").fill("am_adam");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    await createRandomCampaign(page); // campaign B
    const campaignB = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignB}`);

    const triggers = page.locator('[data-testid="global-settings"] [data-slot="select-trigger"]');
    await expect(triggers.nth(2)).toContainText("Kokoro");
    await expect(page.locator("#kokoroVoiceId")).toHaveValue("am_adam");
  });
});

/**
 * Issue #97 removed ElevenLabs entirely (`STT_PROVIDERS`/`TTS_PROVIDERS` narrowed, the provider
 * implementations deleted). `tests/backward-compat-frontmatter.spec.ts` covers the PRE-#77 case (a
 * `settings.md` still naming ElevenLabs) — `pickLegacyGlobalFields`'s `isOneOf` checks already make
 * that safe for free, since an old settings.md is only ever read through that validating path.
 *
 * This covers the *other*, genuinely new gap #77 introduced: a real `adventure:global-settings`
 * `localStorage` blob written directly by a build shipped AFTER #77 (global settings already
 * exist) but BEFORE #97 (ElevenLabs still a valid choice) — a player who had actually picked it.
 * `getGlobalSettings()`'s `{ ...DEFAULT_GLOBAL_SETTINGS, ...parsed }` merge only fills in *missing*
 * keys, so a *present* `'elevenlabs'` value in that blob is never touched by the merge itself —
 * this is what `coerceLegacyVoiceProviders` (called at the end of `getGlobalSettings()`) exists to
 * fix. See `src/lib/settings/globalSettings.ts` for the implementation.
 */
test.describe("issue #97: a stored GlobalSettings blob naming the since-removed ElevenLabs provider still resolves to working providers", () => {
  test("a post-#77-pre-#97 localStorage blob with sttProvider/ttsProvider: 'elevenlabs' coerces to Settings showing Browser/Browser, not a broken/blank select", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    // Seeds the *current*-format storage key directly, before any app script runs — simulating a
    // real earlier build of this exact app having already written this blob (not a settings.md,
    // not something pickLegacyGlobalFields ever sees).
    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      {
        key: GLOBAL_SETTINGS_STORAGE_KEY,
        value: JSON.stringify({
          aiMode: "manual",
          claudeModel: "claude-sonnet-5",
          localModelId: "onnx-community/gemma-3-1b-it-ONNX",
          sttProvider: "elevenlabs",
          ttsProvider: "elevenlabs",
          elevenLabsVoiceId: "legacy-eleven-voice-id",
        }),
      },
    );

    await page.goto("/settings");
    const triggers = page.locator(
      '[data-testid="global-settings"] [data-slot="select-trigger"]',
    );
    // aiMode is 'manual' here (unaffected by the coercion), so trigger order is
    // [aiMode, sttProvider, ttsProvider] — no Claude-model select inserted.
    await expect(triggers.nth(1)).toContainText("Browser (Web Speech API)");
    await expect(triggers.nth(2)).toContainText("Browser (SpeechSynthesis)");
    // No ElevenLabs voice ID field exists any more to reflect the stale value from either.
    await expect(page.locator("#voiceId")).toHaveCount(0);
  });

  test("that same stored blob resolves to a genuinely working mic button and read-aloud toggle on Play, not just a non-broken Settings page", async ({
    page,
  }) => {
    // Guarantees isSttProviderAvailable('browser')/isTtsProviderAvailable('browser') resolve true
    // in this headless run, so the assertions below prove a *working* fallback, not one that
    // happens to pass only because headless Chromium's own Web Speech support is flaky.
    await installFakeWebSpeechApi(page, { sttSupported: true, ttsSupported: true });
    await installGoogleApiMock(page);
    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      {
        key: GLOBAL_SETTINGS_STORAGE_KEY,
        value: JSON.stringify({
          aiMode: "manual",
          claudeModel: "claude-sonnet-5",
          localModelId: "onnx-community/gemma-3-1b-it-ONNX",
          sttProvider: "elevenlabs",
          ttsProvider: "elevenlabs",
        }),
      },
    );

    await createRandomCampaign(page);
    // Play.tsx's sttAvailable/showReadAloudToggle gate the mic button/read-aloud toggle on
    // isSttProviderAvailable/isTtsProviderAvailable(globalSettings.sttProvider/ttsProvider) —
    // both return false unconditionally for 'elevenlabs' now (the case removed), so without
    // coerceLegacyVoiceProviders these would be silently, permanently absent.
    await expect(
      page.getByRole("button", { name: "Speak your action" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Read new turns aloud" }),
    ).toBeVisible();
  });
});
