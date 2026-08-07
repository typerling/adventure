import { test, expect, type Page } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import {
  getKokoroWorker,
  installControllableWebAudioPlayback,
  installFakeKokoroModule,
  waitForKokoroPlaybackToStabilize,
} from "./mocks/kokoro";
import { createRandomCampaign, setCampaignVoiceProviders, submitFreeTextTurn } from "./helpers";

/**
 * Issue #51: Kokoro TTS gained an opt-in WebGPU backend alongside its original (and still
 * default) WASM one — see kokoroTts.worker.ts's doc comment for the dtype investigation and
 * kokoroConstants.ts's KokoroDevice/KOKORO_WEBGPU_DTYPE for what's actually requested.
 *
 * kokoro-js itself is faked here (see tests/mocks/kokoro.ts) the same way every other Kokoro spec
 * fakes it — a real WebGPU adapter isn't available in this sandbox at all (confirmed while
 * building this feature: `navigator.gpu` stays undefined under headless Chromium here regardless
 * of `--enable-unsafe-webgpu`/`--use-angle=swiftshader`/Vulkan flags, since the container has no
 * `/dev/dri` GPU device nodes whatsoever), so these tests exercise the fallback *logic*
 * (kokoroTts.worker.ts's loadWithFallback/doSpeak/doSpeakStream) against a fake that can simulate
 * both known WebGPU failure modes on demand, not real WebGPU behavior.
 *
 * Turn playback itself (issue #62) uses installControllableWebAudioPlayback rather than real Web
 * Audio here — not because real Web Audio doesn't work in this sandbox (it does, see
 * kokoro-streaming-playback.spec.ts, which uses it deliberately) but because these tests care about
 * backend-fallback *correctness*, not streaming timing, and the fake kokoro-js module's
 * near-zero-length generated audio would otherwise finish playing (and resolve speak()) within
 * microseconds of being scheduled — no stable window to assert "still playing" against. See
 * installControllableWebAudioPlayback's own doc comment.
 */

async function switchKokoroDevice(page: Page, device: "CPU" | "GPU") {
  await page.locator("#kokoro-device").click();
  await page.getByRole("option", { name: device === "GPU" ? /^GPU/ : /^CPU/ }).click();
}

test("Kokoro's backend can be switched to WebGPU in Settings, and each backend's downloaded-state is scoped to its own file", async ({
  page,
}) => {
  await installGoogleApiMock(page);
  await page.goto("/settings");

  await expect(page.locator("#kokoro-device")).toContainText("CPU");
  await expect(page.getByRole("button", { name: "Download voice model now" })).toBeVisible();

  // Seed only the WASM (default, `q8`) build's file.
  await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    await cache.put(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
      new Response(new ArrayBuffer(8)),
    );
  });
  await page.reload();
  await expect(
    page.getByText("Voice model downloaded and ready — playback starts instantly."),
  ).toBeVisible();

  // Switching to WebGPU asks about a *different* file — not downloaded yet, even though the WASM
  // build is.
  await switchKokoroDevice(page, "GPU");
  await expect(page.getByRole("button", { name: "Download voice model now" })).toBeVisible();
  await expect(
    page.getByText("Uses a separate, larger download from the CPU version.", { exact: false }),
  ).toBeVisible();

  // Seed the WebGPU (`fp32`) build's file too — bare "model.onnx", no dtype suffix.
  await page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    await cache.put(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
      new Response(new ArrayBuffer(8)),
    );
  });
  await page.reload();
  await expect(
    page.getByText("Voice model downloaded and ready — playback starts instantly."),
  ).toBeVisible();

  // Switching back to CPU still sees its own (still-cached) file as ready too.
  await switchKokoroDevice(page, "CPU");
  await expect(
    page.getByText("Voice model downloaded and ready — playback starts instantly."),
  ).toBeVisible();
});

test("selecting WebGPU falls back to WASM automatically when no adapter is available, and Settings remembers it", async ({
  page,
}) => {
  // Without kokoroTts.worker.ts's loadWithFallback catching this, KokoroTTS.from_pretrained()
  // rejecting for device: 'webgpu' would surface as a generation error and no audio would ever
  // play — this proves the recovery path, not just that playback works.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { failWebgpuLoad: true });
  await installControllableWebAudioPlayback(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];

  await page.goto("/settings");
  await switchKokoroDevice(page, "GPU");

  await page.goto(`/play/${campaignId}`);
  await submitFreeTextTurn(page, "listen", "A low hum fills the chamber.");
  await expect(page.getByText("A low hum fills the chamber.")).toBeVisible();

  // Nothing has used Kokoro yet in this test, so the worker doesn't exist until this click
  // triggers it — start waiting for it *before* clicking, same as voice-kokoro.spec.ts's
  // established pattern, so the 'worker' event can't be missed by a click that resolves first.
  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  await waitForKokoroPlaybackToStabilize(page);

  const loadDevices = await worker.evaluate(
    () => (self as unknown as { __kokoroLoadDevices?: string[] }).__kokoroLoadDevices ?? [],
  );
  // Attempted webgpu first (and it failed, per failWebgpuLoad), then fell back to wasm.
  expect(loadDevices).toEqual(["webgpu", "wasm"]);

  const generateCalls = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateCalls?: { device: string }[] }).__kokoroGenerateCalls ?? [],
  );
  expect(generateCalls.length).toBeGreaterThan(0);
  expect(generateCalls.every((c) => c.device === "wasm")).toBe(true);

  // Genuinely playing, not just optimistic UI — this stays true because the fake Web Audio
  // context's scheduled sources never fire 'ended' on their own (installControllableWebAudioPlayback).
  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();

  // The fallback is remembered — Settings now shows CPU, not GPU, without needing to fail again.
  await page.goto("/settings");
  await expect(page.locator("#kokoro-device")).toContainText("CPU");
});

test("a WebGPU device lost mid-generation falls back to WASM and restarts the whole turn there, not just the failed chunk", async ({
  page,
}) => {
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { failWebgpuGenerate: true });
  await installControllableWebAudioPlayback(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];

  await page.goto("/settings");
  await switchKokoroDevice(page, "GPU");

  await page.goto(`/play/${campaignId}`);
  // Three sentences => multiple chunks (plus a couple more for the spoken "Your options: ..."
  // trailer — see turnBlocks.ts's blockToSpokenText — so the exact chunk count isn't asserted
  // here, just that every one of them shows up again on wasm).
  await submitFreeTextTurn(
    page,
    "look around",
    "The first room is cold. The second room is silent. The third room is sealed shut.",
  );
  await expect(page.getByText("The first room is cold.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  await waitForKokoroPlaybackToStabilize(page);

  const attempts = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateAttempts?: { text: string; device: string }[] })
        .__kokoroGenerateAttempts ?? [],
  );
  const generateCalls = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateCalls?: { text: string; device: string }[] })
        .__kokoroGenerateCalls ?? [],
  );

  // Exactly one attempt failed (the very first, on webgpu) — everything else succeeded on wasm.
  // The whole job restarted from chunk 0 on wasm rather than resuming from wherever the GPU left
  // off, so every successful call is on wasm and there's exactly one more of them than there were
  // failed attempts.
  expect(attempts[0].device).toBe("webgpu");
  expect(attempts.filter((a) => a.device === "webgpu")).toHaveLength(1);
  expect(generateCalls.every((c) => c.device === "wasm")).toBe(true);
  expect(generateCalls.length).toBe(attempts.length - 1);
  expect(generateCalls.length).toBeGreaterThan(1);
  // The specific chunk that failed on webgpu was retried (not skipped) — its exact text reappears
  // among the wasm calls that actually produced audio.
  expect(generateCalls.some((c) => c.text === attempts[0].text)).toBe(true);

  // Issue #62: this worker-level restart-from-0 is only half the story — kokoroTts.ts's main-thread
  // de-duplication (nextExpectedChunkIndex) is what actually keeps the player from *hearing* a
  // chunk twice. Every wasm call above regenerated a chunk that hadn't been scheduled for playback
  // yet (webgpu failed on the very first chunk here, before anything reached the main thread), so
  // every one of them should reach playback exactly once — the count below would exceed
  // generateCalls.length if any chunk were scheduled twice.
  const sourceStartCount = await page.evaluate(
    () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
  );
  expect(sourceStartCount).toBe(generateCalls.length);

  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();

  await page.goto("/settings");
  await expect(page.locator("#kokoro-device")).toContainText("CPU");
});

test("a WebGPU device lost after several chunks already played does not replay those chunks after the WASM restart", async ({
  page,
}) => {
  // Strengthens the test above for the case it explicitly couldn't cover: failWebgpuGenerate: true
  // fails on the very first webgpu chunk, so nothing had reached the main thread yet when the
  // restart happened. Here failWebgpuGenerate is a count (2) instead — the first two chunks
  // genuinely succeed on webgpu, stream to the main thread, and get scheduled for playback *before*
  // the third chunk's device-lost failure triggers the WASM restart from chunk 0. This is the
  // scenario kokoroTts.ts's own doc comment ("De-duplication after a WebGPU-fallback restart")
  // describes: chunks 0-1 must not play a second time once the WASM restart regenerates them.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { failWebgpuGenerate: 2 });
  await installControllableWebAudioPlayback(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];

  await page.goto("/settings");
  await switchKokoroDevice(page, "GPU");

  await page.goto(`/play/${campaignId}`);
  await submitFreeTextTurn(
    page,
    "look around",
    "The first room is cold. The second room is silent. The third room is sealed shut.",
  );
  await expect(page.getByText("The first room is cold.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  await waitForKokoroPlaybackToStabilize(page);

  const attempts = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateAttempts?: { text: string; device: string }[] })
        .__kokoroGenerateAttempts ?? [],
  );
  const generateCalls = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateCalls?: { text: string; device: string }[] })
        .__kokoroGenerateCalls ?? [],
  );
  // Two chunks succeeded on webgpu before the third's device-lost failure (attempts has 2 webgpu
  // successes plus 1 webgpu failure); the restart then regenerated every chunk on wasm from 0.
  expect(attempts.filter((a) => a.device === "webgpu")).toHaveLength(3);

  const sourceStartCount = await page.evaluate(
    () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
  );
  // generateCalls includes every *successful* attempt on either backend — the 2 webgpu chunks that
  // succeeded before the failure, plus every chunk regenerated on wasm after the restart (all of
  // them, restart-from-0) — so it double-counts the 2 chunks that succeeded twice. The wasm subset
  // alone is the final, unique chunk count: what the whole turn resolved to. The whole point of
  // this test: playback count matches *that*, not generateCalls.length (which would mean the first
  // 2 chunks played twice — once from their webgpu success, once from the wasm restart).
  const finalChunkCount = generateCalls.filter((c) => c.device === "wasm").length;
  expect(sourceStartCount).toBe(finalChunkCount);
  expect(sourceStartCount).toBeLessThan(generateCalls.length);
  expect(sourceStartCount).toBeLessThan(attempts.length);

  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
});
