import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import { createRandomCampaign } from "./helpers";

/**
 * Kokoro (kokoro-js) replaced the "Local Hugging Face model (Phase 2 — coming soon)" placeholder
 * as the on-device TTS option — it's now selectable rather than disabled. Actually generating
 * speech needs a real ~300MB model download and WASM inference, which (like the local Gemma text
 * model) isn't something to run for real in an automated test — see ai-local-mode.spec.ts for the
 * same reasoning. This only checks that Settings actually lets you pick it.
 */
test("Kokoro is selectable as a text-to-speech provider in Settings", async ({
  page,
}) => {
  await installGoogleApiMock(page);
  await createRandomCampaign(page);

  const match = page.url().match(/\/play\/([^/?#]+)/);
  const campaignId = match![1];
  await page.goto(`/settings/${campaignId}`);

  // AI mode (0), Speech-to-text (1), Text-to-speech (2) — manual AI mode (the default) adds no
  // extra select before these.
  const ttsTrigger = page
    .locator('[data-testid="campaign-settings"] [data-slot="select-trigger"]')
    .nth(2);
  await ttsTrigger.click();

  const kokoroOption = page.getByRole("option", {
    name: "Kokoro (on-device, runs locally)",
  });
  await expect(kokoroOption).toBeVisible();
  await expect(kokoroOption).toBeEnabled();

  await kokoroOption.click();
  await expect(ttsTrigger).toContainText("Kokoro");

  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

test("the Kokoro voice model can be downloaded ahead of time from Settings", async ({
  page,
}) => {
  await installGoogleApiMock(page);
  // Force the model download to fail fast instead of really fetching it — same approach (and same
  // reasoning) as the local model download tests in ai-local-mode.spec.ts.
  await page.route(/huggingface\.co|hf\.co/, (route) => route.abort("failed"));

  await page.goto("/settings");

  await expect(
    page.getByText("Kokoro voice model", { exact: true }),
  ).toBeVisible();
  const downloadButton = page.getByRole("button", {
    name: "Download voice model now",
  });
  await expect(downloadButton).toBeVisible();

  await downloadButton.click();
  // Goes into a disabled in-flight state rather than staying idle, so there's visible feedback.
  await expect(
    page.getByRole("button", { name: "Download voice model now" }),
  ).toHaveCount(0);

  // A blocked network surfaces as a clear failure and re-enables the button, rather than getting
  // stuck disabled forever.
  await expect(downloadButton).toBeVisible({ timeout: 20_000 });
  await expect(downloadButton).toBeEnabled();
});

test("an already-downloaded Kokoro voice model shows as ready and can be removed", async ({
  page,
}) => {
  await installGoogleApiMock(page);
  await page.goto("/settings");

  // Seed Cache Storage the way kokoro-js's bundled transformers copy would (its default
  // 'transformers-cache' bucket, keyed by the model's download URL) rather than performing a real
  // download of actual ONNX weights, which a test can't fake. This exercises the same
  // hasDownloadedKokoroModel()/removeKokoroModel() paths a genuine download leaves behind.
  await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    await cache.put(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8.onnx",
      new Response(new ArrayBuffer(8)),
    );
  });

  await page.reload();
  await expect(
    page.getByText(
      "Voice model downloaded and ready — playback starts instantly.",
    ),
  ).toBeVisible();

  const removeButton = page.getByRole("button", {
    name: "Remove downloaded voice model",
  });
  await expect(removeButton).toBeVisible();
  await removeButton.click();

  await expect(
    page.getByText("Voice model removed from this device."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download voice model now" }),
  ).toBeVisible();

  // The cached entry is genuinely gone, not just hidden in the UI.
  const remaining = await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    return keys.filter((r) => r.url.includes("Kokoro")).length;
  });
  expect(remaining).toBe(0);
});
