import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import {
  createRandomCampaign,
  expandSettingsCard,
  setCampaignAiMode,
  setCampaignVoiceProviders,
} from "./helpers";

/**
 * Issue #22: Settings was restructured into three headed sections ("This campaign" / "AI & voice
 * providers" / "Account"), and its two always-visible download-management cards ("Local AI
 * models", "Kokoro voice model") became collapsed-by-default disclosures — expanded by default
 * only when the campaign currently open already uses that mode. This file covers the restructure
 * itself (headings present/absent, default collapsed/expanded state per context, and that
 * toggling doesn't disturb the underlying download-management functionality); the download flows
 * themselves stay covered in depth by ai-local-mode.spec.ts and voice-kokoro.spec.ts (both updated
 * for the new collapsed-by-default state — see their use of expandSettingsCard).
 */

test.describe("Settings restructure (issue #22)", () => {
  test("the global Settings page (no campaign open) shows only the account-wide sections", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "This campaign" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "AI & voice providers" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

    // The two download-management cards' titles are still discoverable...
    await expect(
      page.getByText("Local AI models", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Kokoro voice model", { exact: true }),
    ).toBeVisible();
    // ...but collapsed: no campaign context to judge relevance from.
    await expect(page.getByTestId("local-models-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByTestId("kokoro-model-card-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("a per-campaign Settings page shows all three sections, in order", async ({
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
  });

  test("a campaign that doesn't use local mode or Kokoro leaves both download-management cards collapsed", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    // A fresh campaign defaults to manual AI mode and browser TTS — neither card's mode.
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

  test("a campaign using local AI mode defaults the Local AI models card open, but not the Kokoro one", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    await setCampaignAiMode(page, "local");
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignId}`);

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

  test("a campaign using Kokoro for text-to-speech defaults the Kokoro voice model card open, but not the Local AI models one", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignId}`);

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
    // Found in independent review of #76: CollapsibleSettingsCard's remount key was originally
    // derived from `localModelsDefaultOpen` itself (i.e. from `settings?.aiMode === 'local'`
    // directly) — the same live value the "This campaign" section's own AI-mode dropdown edits in
    // real time, with no Save required. Editing that dropdown therefore changed the key too,
    // forcing an unwanted remount that silently threw away whatever the player had just manually
    // toggled. The fix keys on "has settings finished its async load" instead, which only changes
    // once per campaign — this reproduces the exact scenario the fix is for.
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    await setCampaignAiMode(page, "local");
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];
    await page.goto(`/settings/${campaignId}`);

    // Campaign uses local mode, so the card starts expanded (its documented default).
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
    // browsing the dropdown, which is enough to update `settings.aiMode` in memory either way.
    await page
      .locator('[data-testid="campaign-settings"] [data-slot="select-trigger"]')
      .first()
      .click();
    await page.getByRole("option", { name: "Manual (copy/paste into claude.ai or chatgpt.com)" }).click();
    await page
      .locator('[data-testid="campaign-settings"] [data-slot="select-trigger"]')
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
