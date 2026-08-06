import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import {
  installControllableAudioPlayback,
  installFakeAudioPlayback,
} from "./mocks/elevenLabs";
import { installFakeKokoroModule } from "./mocks/kokoro";
import {
  createRandomCampaign,
  setCampaignVoiceProviders,
  submitFreeTextTurn,
} from "./helpers";

function campaignIdFromUrl(page: import("@playwright/test").Page): string {
  const match = page.url().match(/\/play\/([^/?#]+)/);
  if (!match) throw new Error(`campaignIdFromUrl: no campaign id in URL "${page.url()}"`);
  return match[1];
}

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

test.describe("Kokoro voice picker", () => {
  test("the voice field and Browse voices button are hidden unless the campaign uses Kokoro for text-to-speech", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await createRandomCampaign(page);
    const campaignId = campaignIdFromUrl(page);

    // A fresh campaign defaults to the browser TTS provider — hidden.
    await page.goto(`/settings/${campaignId}`);
    await expect(page.locator("#kokoroVoiceId")).toHaveCount(0);

    // Selecting Kokoro for text-to-speech reveals it.
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    await page.goto(`/settings/${campaignId}`);
    await expect(page.locator("#kokoroVoiceId")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Browse voices" }),
    ).toBeVisible();
  });

  test("voice picker lists Kokoro's voices, previews one, and selecting one sets the voice ID", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await installFakeKokoroModule(page);
    // Not the auto-ending fake — the preview toggle needs a window to click "stop"/observe
    // "Stop preview of…" before playback would resolve on its own (same reasoning as the
    // ElevenLabs picker's equivalent test in voice-elevenlabs.spec.ts).
    await installControllableAudioPlayback(page);

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    const campaignId = campaignIdFromUrl(page);
    await page.goto(`/settings/${campaignId}`);

    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByRole("dialog", { name: "Choose a Kokoro voice" }),
    ).toBeVisible();

    // Metadata from the fake model's own `voices` getter — not a hardcoded list — is rendered:
    // name, language, gender, and (where present) traits.
    await expect(page.getByRole("button", { name: /^Heart/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Adam/ })).toBeVisible();
    await expect(
      page.getByTestId("kokoro-voice-af_heart"),
    ).toContainText("en-us");
    await expect(
      page.getByTestId("kokoro-voice-af_heart"),
    ).toContainText("Female");
    await expect(
      page.getByTestId("kokoro-voice-am_adam"),
    ).toContainText("Male");

    // af_heart is the fallback when nothing is chosen yet — shown as "Default", not "Selected".
    await expect(
      page.getByTestId("kokoro-voice-af_heart").getByText("Default"),
    ).toBeVisible();
    await expect(page.locator("#kokoroVoiceId")).toHaveValue("");

    // Preview generates a clip on-device (via the faked KokoroTTS.generate) and plays it —
    // recorded onto window.__kokoroGenerateCalls so this can assert the exact voice used.
    await page.getByRole("button", { name: "Preview Adam" }).click();
    await expect(
      page.getByRole("button", { name: "Stop preview of Adam" }),
    ).toBeVisible();
    const generateCalls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __kokoroGenerateCalls?: { text: string; voice: string }[];
          }
        ).__kokoroGenerateCalls ?? [],
    );
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0].voice).toBe("am_adam");
    expect(generateCalls[0].text).toBe(
      "Hello, this is a preview of my voice.",
    );

    // Selecting a voice sets the field and closes the picker, without needing the preview
    // stopped first.
    await page.getByRole("button", { name: /^Adam/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#kokoroVoiceId")).toHaveValue("am_adam");

    // Reopening the picker reuses the already-loaded list and shows the new selection.
    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByTestId("kokoro-voice-am_adam").getByText("Selected"),
    ).toBeVisible();
  });

  test("selecting a voice while its own preview is still generating does not play stale audio afterward", async ({
    page,
  }) => {
    // Flagged in PR #42's review: previewKokoroVoice had no cancellation for a still-in-flight
    // generateKokoroPreview() call, so picking a voice (or closing the dialog) while its preview
    // was still generating didn't stop that generation from creating an Audio and calling .play()
    // once it finally resolved — audibly starting playback after the dialog had already closed.
    await installGoogleApiMock(page);
    await installFakeKokoroModule(page);
    // A custom fake distinct from the shared installFakeAudioPlayback/installControllableAudioPlayback
    // helpers: this test needs to count *how many times* play() is called, not just control when
    // playback ends.
    await page.addInitScript(() => {
      class CountingAudio {
        src: string
        onended: (() => void) | null = null
        onerror: ((event?: unknown) => void) | null = null
        constructor(src: string) {
          this.src = src
        }
        play() {
          const w = window as unknown as { __kokoroPreviewPlayCount?: number }
          w.__kokoroPreviewPlayCount = (w.__kokoroPreviewPlayCount ?? 0) + 1
          return Promise.resolve()
        }
        pause() {}
      }
      Object.defineProperty(window, "Audio", { value: CountingAudio, configurable: true })
    })

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    const campaignId = campaignIdFromUrl(page);
    await page.goto(`/settings/${campaignId}`);

    // Gate the fake model's generate() so the preview call hangs until explicitly released.
    await page.evaluate(() => {
      const w = window as unknown as {
        __kokoroGeneratePause?: Promise<void>;
        __releaseKokoroGenerate?: () => void;
      };
      w.__kokoroGeneratePause = new Promise<void>((resolve) => {
        w.__releaseKokoroGenerate = resolve;
      });
    });

    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByRole("dialog", { name: "Choose a Kokoro voice" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Preview Adam" }).click();
    // The call is recorded as soon as it starts, even though the fake is holding it open.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __kokoroGenerateCalls?: unknown[] })
              .__kokoroGenerateCalls?.length ?? 0,
        ),
      )
      .toBe(1);

    // Select a voice while that preview is still generating — this closes the dialog.
    await page.getByRole("button", { name: /^Adam/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Now let the delayed generate() resolve.
    await page.evaluate(() =>
      (
        window as unknown as { __releaseKokoroGenerate?: () => void }
      ).__releaseKokoroGenerate?.(),
    );
    await page.waitForTimeout(300);

    // The superseded preview must not have played audio after the dialog closed.
    const playCount = await page.evaluate(
      () =>
        (window as unknown as { __kokoroPreviewPlayCount?: number })
          .__kokoroPreviewPlayCount ?? 0,
    );
    expect(playCount).toBe(0);
  });

  test("a selected Kokoro voice is threaded into Play.tsx's speak() call", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    await installFakeKokoroModule(page);
    await installFakeAudioPlayback(page);

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    const campaignId = campaignIdFromUrl(page);

    // Set the voice directly via the text field — exercises persistence into
    // CampaignSettings.kokoroVoiceId without needing the picker's own model load.
    await page.goto(`/settings/${campaignId}`);
    await page.locator("#kokoroVoiceId").fill("am_adam");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // Reloading confirms it actually persisted to settings.md, not just component state.
    await page.reload();
    await expect(page.locator("#kokoroVoiceId")).toHaveValue("am_adam");

    await page.goto(`/play/${campaignId}`);
    await page.getByRole("button", { name: "Read new turns aloud" }).click();
    await submitFreeTextTurn(
      page,
      "listen",
      "A low hum fills the chamber.",
    );
    await expect(
      page.getByText("A low hum fills the chamber."),
    ).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __kokoroGenerateCalls?: { text: string; voice: string }[];
              }
            ).__kokoroGenerateCalls?.length ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    const generateCalls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __kokoroGenerateCalls?: { text: string; voice: string }[];
          }
        ).__kokoroGenerateCalls ?? [],
    );
    // Every chunk of the narrative was spoken with the campaign's chosen voice, not the default.
    expect(generateCalls.every((c) => c.voice === "am_adam")).toBe(true);
  });

  test("removing the downloaded voice model resets the picker so reopening it reloads instead of reusing a stale list", async ({
    page,
  }) => {
    // Flagged in PR #42's review: removeVoiceModel() reset the download-management card's own
    // state but not the picker's kokoroVoicesLoadState, so after removal the picker still thought
    // its previously-loaded list was current — reopening it skipped reloading entirely (see
    // openKokoroVoicePicker's early-return for "loaded"/"loading"), silently pointing at a model
    // no longer resident.
    await installGoogleApiMock(page);
    await installFakeKokoroModule(page);

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    const campaignId = campaignIdFromUrl(page);

    // Seed Cache Storage the same way the download-management test above does, so the "Voice
    // model downloaded and ready" card (and its Remove button) shows without a real download.
    await page.goto("/settings");
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

    await page.goto(`/settings/${campaignId}`);

    // Load the picker's voice list once (via the faked kokoro-js module).
    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByRole("dialog", { name: "Choose a Kokoro voice" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Adam/ })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __kokoroLoadCalls?: number }).__kokoroLoadCalls ?? 0,
        ),
      )
      .toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Remove the model via the separate download-management card further down the page.
    await page
      .getByRole("button", { name: "Remove downloaded voice model" })
      .click();
    await expect(
      page.getByText("Voice model removed from this device."),
    ).toBeVisible();

    // Reopening the picker must reload (a fresh from_pretrained call), not silently reuse the
    // list from the model instance that just got evicted.
    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByRole("dialog", { name: "Choose a Kokoro voice" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Adam/ })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __kokoroLoadCalls?: number }).__kokoroLoadCalls ?? 0,
        ),
      )
      .toBe(2);
  });

  test("Browse voices surfaces a clear error when the voice model fails to download", async ({
    page,
  }) => {
    await installGoogleApiMock(page);
    // Force the model download to fail fast instead of really fetching it — same technique as
    // the "download fails fast" test above, applied to the picker's own load-on-open path.
    await page.route(/huggingface\.co|hf\.co/, (route) => route.abort("failed"));

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
    const campaignId = campaignIdFromUrl(page);
    await page.goto(`/settings/${campaignId}`);

    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByText("Couldn't load Kokoro's voice list", { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
