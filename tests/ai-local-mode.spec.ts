import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import {
  createRandomCampaign,
  expandSettingsCard,
  setCampaignAiMode,
} from "./helpers";

/**
 * Real, on-device model generation via WebGPU can't practically run as an automated test here:
 * Playwright's Chromium actually feature-detects `navigator.gpu` as present (Chrome ships WebGPU
 * by default now — verified directly, not assumed), so `isLocalModelSupported()` says yes and the
 * code proceeds to actually try downloading a several-hundred-MB-to-multi-GB model from Hugging
 * Face over the real network. That's not something to build CI coverage on regardless of GPU
 * availability. So the network path to huggingface.co is blocked below to force a fast,
 * deterministic load failure — this is also a realistic failure mode (an offline device, a
 * captive network) which the app needs to survive with a clear error, not a hang or a crash.
 */

// Must match localModelCache.ts's own DB_VERSION. Opening at an older version would trigger that
// file's upgrade handler, which deliberately drops everything rather than migrating — so a stale
// value here silently wipes the very cache entry these tests seed.
const CACHE_DB_VERSION = 3;
// The default model a fresh campaign's localModelId points at (see DEFAULT_SETTINGS in
// src/types/campaign.ts) — the one actually exercised when a turn is generated.
const DEFAULT_MODEL_ID = "onnx-community/gemma-3-1b-it-ONNX";
const DEFAULT_MODEL_ROW = `[data-testid="local-model-row-${DEFAULT_MODEL_ID}"]`;

test.describe("local (on-device) AI mode", () => {
  test('the "Local AI models" list is on Settings regardless of campaign or AI mode', async ({
    page,
  }) => {
    await installGoogleApiMock(page);

    // No campaign at all — the general Settings page, reached directly. The card's title shows
    // either way (issue #22): only its body — the actual catalog/download UI — starts collapsed
    // here, since there's no campaign context to judge relevance from.
    await page.goto("/settings");
    await expect(
      page.getByText("Local AI models", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(DEFAULT_MODEL_ROW)).toHaveCount(0);
    await expandSettingsCard(page, "local-models-card");
    // One row (and one "Download" button) per catalog entry.
    await expect(page.locator(DEFAULT_MODEL_ROW)).toBeVisible();
    await expect(
      page.locator(DEFAULT_MODEL_ROW).getByRole("button", { name: "Download" }),
    ).toBeVisible();

    // Still there for a campaign whose AI mode is NOT local (manual is the default for a fresh
    // campaign) — this list doesn't depend on the currently-viewed campaign's settings. Since this
    // campaign doesn't use local mode, the card is collapsed by default here too.
    await createRandomCampaign(page);
    const match = page.url().match(/\/play\/([^/?#]+)/);
    const campaignId = match![1];
    await page.goto(`/settings/${campaignId}`);
    await expect(
      page.getByText("Local AI models", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(DEFAULT_MODEL_ROW)).toHaveCount(0);
    await expandSettingsCard(page, "local-models-card");
    await expect(page.locator(DEFAULT_MODEL_ROW)).toBeVisible();
  });

  test("is selectable in Settings, defaults to a specific model, and persists across a reload", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    await setCampaignAiMode(page, "local");

    const match = page.url().match(/\/play\/([^/?#]+)/);
    const campaignId = match![1];
    await page.goto(`/settings/${campaignId}`);

    await expect(
      page
        .locator(
          '[data-testid="campaign-settings"] [data-slot="select-trigger"]',
        )
        .first(),
    ).toContainText("Local model (runs on this device)");
    // The campaign's own model picker (a second select) defaults to Gemma 3 1B and shows its size.
    await expect(
      page
        .locator(
          '[data-testid="campaign-settings"] [data-slot="select-trigger"]',
        )
        .nth(1),
    ).toContainText("Gemma 3 1B");
  });

  test("a model load failure (e.g. no network) surfaces a clear error, not a hang or crash", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    // Force the model download itself to fail fast instead of actually fetching it.
    await page.route(/huggingface\.co|hf\.co/, (route) =>
      route.abort("failed"),
    );

    await createRandomCampaign(page);
    await setCampaignAiMode(page, "local");

    await page.getByPlaceholder("Say or do anything…").fill("look around");
    await page.getByRole("button", { name: "Act", exact: true }).click();

    await expect(page.getByText("Generating on this device")).toBeVisible();
    // The dialog surfaces *some* clear error rather than hanging forever, and offers Retry.
    await expect(page.locator(".text-destructive").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    // The turn was never applied — no crash, no silent partial state. (Turn/location now lives
    // in the header's icon button, not page body text.)
    await expect(page.getByTitle(/^Turn 0/)).toBeVisible();
  });

  test("a model can be downloaded ahead of time from Settings, without acting first", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await page.route(/huggingface\.co|hf\.co/, (route) =>
      route.abort("failed"),
    );

    await createRandomCampaign(page);
    await setCampaignAiMode(page, "local");

    const match = page.url().match(/\/play\/([^/?#]+)/);
    const campaignId = match![1];
    await page.goto(`/settings/${campaignId}`);

    const row = page.locator(DEFAULT_MODEL_ROW);
    const downloadButton = row.getByRole("button", { name: "Download" });
    await expect(downloadButton).toBeVisible();
    await downloadButton.click();

    // Disabled (replaced by a status message) while in flight, no need to visit Play/Act at all.
    await expect(
      row.getByRole("button", { name: "Download", exact: true }),
    ).toHaveCount(0);

    // Blocked network surfaces as a clear failure here too, same as the Act-triggered path —
    // the button becomes available again rather than getting stuck disabled forever.
    await expect(downloadButton).toBeVisible({ timeout: 15_000 });
    await expect(downloadButton).toBeEnabled();

    // A different model's row is unaffected by this one's failed attempt.
    const otherRow = page.locator(
      '[data-testid="local-model-row-onnx-community/Qwen2.5-0.5B-Instruct"]',
    );
    await expect(
      otherRow.getByRole("button", { name: "Download" }),
    ).toBeEnabled();
  });

  test("a downloaded model can be removed from the device", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await page.goto("/settings");

    // Seed the on-device cache directly (src/lib/ai/localModelCache.ts's blocks/meta schema, with
    // a URL shaped like a real cache key for this specific model — see urlBelongsToModel) rather
    // than performing a real download of actual ONNX model data, which isn't something a test can
    // fake — this exercises the same hasDownloadedLocalModel()/removeLocalModel() functions a
    // real download would leave behind.
    await page.evaluate(
      ([modelId, dbVersion]) => {
        const url = `https://huggingface.co/${modelId}/resolve/main/onnx/model_q4f16.onnx`;
        return new Promise<void>((resolve, reject) => {
          const openReq = indexedDB.open(
            "adventure-local-model-cache",
            dbVersion,
          );
          openReq.onupgradeneeded = () => {
            const db = openReq.result;
            db.createObjectStore("blocks", { keyPath: ["url", "blockIndex"] });
            db.createObjectStore("meta", { keyPath: "url" });
          };
          openReq.onsuccess = () => {
            const db = openReq.result;
            const tx = db.transaction(["blocks", "meta"], "readwrite");
            tx.objectStore("blocks").put({
              url,
              blockIndex: 0,
              bytes: new Uint8Array(8),
            });
            tx.objectStore("meta").put({
              url,
              status: 200,
              statusText: "OK",
              headers: [["content-type", "application/octet-stream"]],
              blockCount: 1,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          openReq.onerror = () => reject(openReq.error);
        });
      },
      [DEFAULT_MODEL_ID, CACHE_DB_VERSION] as const,
    );

    await page.reload();
    await expandSettingsCard(page, "local-models-card");
    const row = page.locator(DEFAULT_MODEL_ROW);
    await expect(row.getByText("Downloaded and ready.")).toBeVisible();
    const removeButton = row.getByRole("button", { name: "Remove" });
    await expect(removeButton).toBeVisible();

    await removeButton.click();
    await expect(page.getByText(/removed from this device\.$/)).toBeVisible();
    await expect(row.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(row.getByText("Downloaded and ready.")).toHaveCount(0);

    // The underlying cache is actually gone, not just the UI state.
    const remainingCount = await page.evaluate((dbVersion) => {
      return new Promise<number>((resolve, reject) => {
        const openReq = indexedDB.open(
          "adventure-local-model-cache",
          dbVersion,
        );
        openReq.onupgradeneeded = () => {
          const db = openReq.result;
          db.createObjectStore("blocks", { keyPath: ["url", "blockIndex"] });
          db.createObjectStore("meta", { keyPath: "url" });
        };
        openReq.onsuccess = () => {
          const db = openReq.result;
          const tx = db.transaction("meta", "readonly");
          const countReq = tx.objectStore("meta").count();
          countReq.onsuccess = () => resolve(countReq.result);
          countReq.onerror = () => reject(countReq.error);
        };
        openReq.onerror = () => reject(openReq.error);
      });
    }, CACHE_DB_VERSION);
    expect(remainingCount).toBe(0);
  });

  test("a partially-downloaded model can be cleared even though it was never usable", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await page.goto("/settings");

    // Seed only the partial-download database (src/lib/ai/localModelResumableFetch.ts's schema),
    // simulating an interrupted download — never a complete, usable file.
    await page.evaluate((modelId) => {
      const url = `https://huggingface.co/${modelId}/resolve/main/onnx/model_q4f16.onnx_data`;
      return new Promise<void>((resolve, reject) => {
        const openReq = indexedDB.open("adventure-local-model-partial", 1);
        openReq.onupgradeneeded = () => {
          const db = openReq.result;
          db.createObjectStore("blocks", { keyPath: ["url", "blockIndex"] });
          db.createObjectStore("meta", { keyPath: "url" });
        };
        openReq.onsuccess = () => {
          const db = openReq.result;
          const tx = db.transaction(["blocks", "meta"], "readwrite");
          tx.objectStore("blocks").put({
            url,
            blockIndex: 0,
            bytes: new Uint8Array(8),
          });
          tx.objectStore("meta").put({
            url,
            receivedBytes: 8,
            blockCount: 1,
            etag: null,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        openReq.onerror = () => reject(openReq.error);
      });
    }, DEFAULT_MODEL_ID);

    await page.reload();
    await expandSettingsCard(page, "local-models-card");
    const row = page.locator(DEFAULT_MODEL_ROW);
    // Never fully downloaded, so the primary action is still "Download" — but a partial-clear
    // option is offered alongside it rather than silently discarding the interrupted attempt.
    // exact: true — without it this also matches "Clear partial download" (a real, pre-existing
    // ambiguity this test happened not to hit before: expanding the card now takes just long
    // enough for the async hasPartial check to resolve before this assertion runs, so both
    // buttons are reliably present by the time it does, instead of racing a still-"Download"-only
    // render).
    await expect(
      row.getByRole("button", { name: "Download", exact: true }),
    ).toBeVisible();
    const clearButton = row.getByRole("button", {
      name: "Clear partial download",
    });
    await expect(clearButton).toBeVisible();

    await clearButton.click();
    await expect(page.getByText(/removed from this device\.$/)).toBeVisible();
    await expect(clearButton).toHaveCount(0);
  });
});
