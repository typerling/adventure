import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import {
  installControllableAudioPlayback,
  installFakeAudioPlayback,
} from "./mocks/elevenLabs";
import {
  getKokoroWorker,
  installControllableWebAudioPlayback,
  installFakeKokoroModule,
} from "./mocks/kokoro";
import {
  createRandomCampaign,
  expandSettingsCard,
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
  await page.goto("/settings");

  // AI mode (0), Speech-to-text (1), Text-to-speech (2) — manual AI mode (the default) adds no
  // extra select before these.
  const ttsTrigger = page
    .locator('[data-testid="global-settings"] [data-slot="select-trigger"]')
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
  // No campaign open, so this card starts collapsed (issue #22).
  await expandSettingsCard(page, "kokoro-model-card");
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
  // `model_quantized.onnx` is the real filename the default 'wasm'/`q8` backend downloads (issue
  // #51's KOKORO_DTYPE_SUFFIX) — hasDownloadedKokoroModel() is now scoped to the selected
  // backend's own file, so this has to match exactly, not just contain "Kokoro" anywhere.
  await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    await cache.put(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
      new Response(new ArrayBuffer(8)),
    );
  });

  await page.reload();
  await expandSettingsCard(page, "kokoro-model-card");
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
    // recorded onto the worker's own self.__kokoroGenerateCalls so this can assert the exact
    // voice used.
    await page.getByRole("button", { name: "Preview Adam" }).click();
    await expect(
      page.getByRole("button", { name: "Stop preview of Adam" }),
    ).toBeVisible();
    // KokoroTTS.generate() runs inside kokoroTts.worker.ts (#44) — a separate realm from the page,
    // so this call is recorded onto the worker's own `self`, not `window`.
    const worker = await getKokoroWorker(page);
    const generateCalls = await worker.evaluate(
      () =>
        (
          self as unknown as {
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

    await page.getByRole("button", { name: "Browse voices" }).click();
    await expect(
      page.getByRole("dialog", { name: "Choose a Kokoro voice" }),
    ).toBeVisible();
    // Wait for the voice list itself, not just the dialog — confirms kokoroTts.worker.ts (#44) has
    // actually spawned and finished its 'load'/'listVoices' round trip, so the gate installed next
    // is in place before the "Preview Adam" click below can race it.
    await expect(page.getByRole("button", { name: /^Adam/ })).toBeVisible();

    // Gate the fake model's generate() so the preview call hangs until explicitly released. Set on
    // the worker's own `self` via Worker.evaluate() — not page.evaluate() — since KokoroTTS.generate()
    // now runs inside kokoroTts.worker.ts (#44), a separate realm from the page.
    const worker = await getKokoroWorker(page);
    await worker.evaluate(() => {
      const w = self as unknown as {
        __kokoroGeneratePause?: Promise<void>;
        __releaseKokoroGenerate?: () => void;
      };
      w.__kokoroGeneratePause = new Promise<void>((resolve) => {
        w.__releaseKokoroGenerate = resolve;
      });
    });

    await page.getByRole("button", { name: "Preview Adam" }).click();
    // The call is recorded as soon as it starts, even though the fake is holding it open.
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (self as unknown as { __kokoroGenerateCalls?: unknown[] })
              .__kokoroGenerateCalls?.length ?? 0,
        ),
      )
      .toBe(1);

    // Select a voice while that preview is still generating — this closes the dialog.
    await page.getByRole("button", { name: /^Adam/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Now let the delayed generate() resolve.
    await worker.evaluate(() =>
      (
        self as unknown as { __releaseKokoroGenerate?: () => void }
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

    // KokoroTTS.generate() runs inside kokoroTts.worker.ts (#44) — a separate realm from the page.
    const worker = await getKokoroWorker(page);
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (
              self as unknown as {
                __kokoroGenerateCalls?: { text: string; voice: string }[];
              }
            ).__kokoroGenerateCalls?.length ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    const generateCalls = await worker.evaluate(
      () =>
        (
          self as unknown as {
            __kokoroGenerateCalls?: { text: string; voice: string }[];
          }
        ).__kokoroGenerateCalls ?? [],
    );
    // Every chunk of the narrative was spoken with the campaign's chosen voice, not the default.
    expect(generateCalls.every((c) => c.voice === "am_adam")).toBe(true);
  });

  test("starting playback drives the OS Media Session (#39)", async ({
    page,
  }) => {
    // #39: the Media Session wiring is provider-agnostic (driven from Play.tsx's single
    // speakText, not per-provider) — confirm it actually engages for Kokoro too, not just the
    // browser provider covered in depth by media-session.spec.ts. Not the auto-ending fake — this
    // needs a stable window where playback is still genuinely "playing". installControllableAudioPlayback
    // (a `new Audio()` fake) no longer does anything for Kokoro turn playback since issue #62 moved
    // it onto the Web Audio API — installControllableWebAudioPlayback is its equivalent for that:
    // real Web Audio genuinely works headlessly here, but the fake kokoro-js module's near-zero-length
    // generated audio would otherwise finish playing within microseconds of being scheduled.
    await installGoogleApiMock(page);
    await installFakeKokoroModule(page);
    await installControllableWebAudioPlayback(page);

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

    await submitFreeTextTurn(page, "listen", "A low hum fills the chamber.");
    await expect(page.getByText("A low hum fills the chamber.")).toBeVisible();

    await page.getByRole("button", { name: "Play this turn aloud" }).click();
    await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();

    expect(
      await page.evaluate(() => navigator.mediaSession.metadata?.title),
    ).toBe("Turn 1");
    expect(
      await page.evaluate(() => navigator.mediaSession.playbackState),
    ).toBe("playing");
  });

  test("starting a second turn's playback while the first is still pre-generating stops the first from generating further chunks", async ({
    page,
  }) => {
    // Flagged in PR #48's review: kokoroTts.worker.ts dispatched every 'speak' request
    // immediately with no queue, so clicking a different turn's play button while an earlier
    // turn's (now much longer, since #44) pre-generation was still running could run two
    // generations against the shared model at once, and a superseded turn kept generating chunks
    // nothing would ever play. Turn 1 here has 3 sentences (3 chunks); gating generate() lets this
    // supersede it after only its first chunk is in flight.
    await installGoogleApiMock(page);
    await installFakeKokoroModule(page);
    // See the Media Session test above for why this (not installControllableAudioPlayback) is the
    // right fake now — real turn playback needs a stable "still playing" window for turn 2's
    // assertions below, same reasoning, applied here on top of the generate()-gating this test
    // already does for turn 1's supersession.
    await installControllableWebAudioPlayback(page);

    await createRandomCampaign(page);
    await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

    await submitFreeTextTurn(
      page,
      "look around",
      "The first room is cold. The second room is silent. The third room is sealed shut.",
    );
    await expect(page.getByText("Turn applied.")).toBeVisible();
    await page.addStyleTag({ content: "[data-toast-viewport] { display: none !important; }" });
    await submitFreeTextTurn(page, "move on", "A short hallway leads onward.");
    await expect(page.getByText("A short hallway leads onward.")).toBeVisible();

    const playButtons = page.getByRole("button", { name: "Play this turn aloud" });
    // Nothing has used Kokoro yet in this test, so the worker doesn't exist until this click
    // triggers it — start waiting for it *before* clicking (not after), so the 'worker' event
    // (which fires the instant the Worker object is constructed, well before its script has even
    // loaded) can't be missed by a click that resolves first.
    const [worker] = await Promise.all([getKokoroWorker(page), playButtons.first().click()]); // turn 1

    // The worker script (fetched over the intercepted route) still has to load and execute
    // KokoroTTS.from_pretrained() before the first generate() call — gate it now, ahead of that.
    await worker.evaluate(() => {
      const w = self as unknown as {
        __kokoroGeneratePause?: Promise<void>;
        __releaseKokoroGenerate?: () => void;
      };
      w.__kokoroGeneratePause = new Promise<void>((resolve) => {
        w.__releaseKokoroGenerate = resolve;
      });
    });

    // turn 1 (3 chunks) — its first chunk's generate() hangs on the gate just installed.
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls
              ?.length ?? 0,
        ),
      )
      .toBe(1);

    // Start turn 2 while turn 1's job is still queued/paused on its first chunk.
    await playButtons.first().click(); // now the only remaining button — turn 2's

    // Release the gate — turn 1's paused first-chunk generate() resolves, its staleness check
    // (now superseded by turn 2) makes it bail without generating chunks 2/3; the queue then runs
    // turn 2's job fresh.
    await worker.evaluate(() =>
      (self as unknown as { __releaseKokoroGenerate?: () => void }).__releaseKokoroGenerate?.(),
    );

    // Turn 2 actually completes and plays — not stuck behind turn 1's abandoned job.
    await expect(page.getByRole("button", { name: "Stop playback" })).toHaveCount(1);
    await expect
      .poll(async () =>
        page.evaluate(() => navigator.mediaSession.metadata?.title),
      )
      .toBe("Turn 2");

    const generateCalls = await worker.evaluate(
      () =>
        (self as unknown as { __kokoroGenerateCalls?: { text: string }[] }).__kokoroGenerateCalls ??
        [],
    );
    // Only turn 1's first chunk was ever generated — the second and third sentences never were.
    // Without the fix, the superseded job would have kept generating all 3 (they were only ever
    // discarded on the *main thread* via playToken, never stopped at the source), so this would
    // include "second room"/"third room" calls too.
    const turn1Calls = generateCalls.filter((c) => /room is (cold|silent)|sealed shut/.test(c.text));
    expect(turn1Calls).toHaveLength(1);
    expect(turn1Calls[0].text).toContain("first room is cold");
    // Turn 2 still completed in full (its narrative, spoken via the same 'speak' job that replaced
    // turn 1's) — this fix isn't just "stop the old job," it has to let the new one actually finish.
    expect(generateCalls.some((c) => c.text.includes("short hallway"))).toBe(true);
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
        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
        new Response(new ArrayBuffer(8)),
      );
    });
    await page.reload();
    await expandSettingsCard(page, "kokoro-model-card");
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
    // KokoroTTS.from_pretrained() runs inside kokoroTts.worker.ts (#44) — a separate realm from
    // the page — so this count is recorded onto the worker's own `self`, not `window`. The worker
    // is a page-lifetime singleton (kokoroTts.ts never tears it down), so the same handle is valid
    // across the remove-and-reopen below too.
    const worker = await getKokoroWorker(page);
    await expect
      .poll(() =>
        worker.evaluate(
          () => (self as unknown as { __kokoroLoadCalls?: number }).__kokoroLoadCalls ?? 0,
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
        worker.evaluate(
          () => (self as unknown as { __kokoroLoadCalls?: number }).__kokoroLoadCalls ?? 0,
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
