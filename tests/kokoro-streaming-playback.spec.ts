import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import { getKokoroWorker, installFakeKokoroModule, installKokoroSourceTracking } from "./mocks/kokoro";
import { createRandomCampaign, setCampaignVoiceProviders, submitFreeTextTurn } from "./helpers";

/**
 * Issue #62: Kokoro TTS now plays a turn's narration continuously as it generates, instead of
 * waiting for the whole turn (issue #44's original design) before any audio plays at all. Issue #68
 * (investigating reported playback artifacts) refined this further: rather than scheduling chunk 1
 * the instant it arrives, `speak()` now buffers the first `KOKORO_PLAYBACK_BUFFER_CHUNKS` (2)
 * generated chunks before starting playback, giving generation a head start over playback — see
 * kokoroTts.ts's module doc comment for the full design (playback engine, falling-behind handling,
 * the startup buffer, WebGPU-restart de-duplication) — this spec exercises the actual behavior
 * change plus the guarantees that behavior change put at risk (stop() truly silencing everything
 * immediately).
 *
 * Unlike every other Kokoro spec, these tests deliberately use *real*, unfaked Web Audio
 * (`installKokoroSourceTracking` only instruments `AudioBufferSourceNode.start()`/`.stop()`, it
 * doesn't replace them) rather than a fully faked AudioContext — the whole point here is to prove
 * real scheduling behavior, not just that the surrounding UI reacts correctly. This is possible at
 * all because headless Chromium's Web Audio API genuinely works in this sandbox with no real audio
 * hardware present: verified directly before writing this suite (a throwaway probe test —
 * `new AudioContext()`, schedule a 0.2s silent buffer, and confirm `AudioBufferSourceNode.onended`
 * fires and `ctx.currentTime` has advanced) — result: `state: "running"` with no resume() needed,
 * and `onended` fired with `ctx.currentTime` at `0.2003` after scheduling a 0.2s buffer, i.e. the
 * audio clock tracks real wall-clock time closely enough to build a timing-based test against. What
 * this sandbox still can't verify is whether a *real* audio output device/driver reproduces that
 * scheduling gaplessly — see kokoroTts.ts's doc comment for that documented limitation.
 */

test("playback of chunks 1-2 starts while chunk 3 is still generating", async ({ page }) => {
  // Chunks 1-2 (call indices 0-1) generate and resolve for real, at full (fake) speed — filling
  // issue #68's startup buffer (KOKORO_PLAYBACK_BUFFER_CHUNKS = 2); chunk 3 (call index 2) hangs
  // indefinitely until explicitly released — baked in at install time so there's no race between
  // setting this up and the worker racing ahead of it (see pauseAtCallIndex's doc comment). If
  // chunks 1-2 only started playing *after* the whole turn finished generating (issue #44's old
  // behavior), nothing would ever play at all here, since chunk 3 never finishes in this test.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { pauseAtCallIndex: 2 });
  await installKokoroSourceTracking(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

  // Two prose sentences plus the spoken options trailer (see turnBlocks.ts's blockToSpokenText)
  // guarantee at least 3 chunks — exactly what this test needs to distinguish the buffered pair
  // from the still-generating third chunk.
  await submitFreeTextTurn(page, "look around", "The hallway is silent. A door stands ajar.");
  await expect(page.getByText("The hallway is silent.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  // Both buffered chunks have finished generating and been scheduled together — this can only
  // happen while chunk 3 is (permanently, in this test) still generating, since nothing else is
  // holding it up.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2);

  // The core assertion: chunks 1-2 reached playback while chunk 3 is confirmed still generating,
  // not finished — proving playback started *before* the whole turn was ready, not after (issue
  // #44's old behavior, where nothing would ever reach playback in this test at all since chunk 3
  // never finishes here). __kokoroGenerateCalls records a call the instant it *starts* (see the
  // fake's own comment on why, and pauseAtCallIndex), so a count of 3 here means "chunk 3's
  // generate() has started" — proving the worker is genuinely working ahead — not "chunk 3 is
  // done"; the progress text is what proves chunk 3 hasn't actually completed/reached playback yet.
  const [generateCallCount, sourceStartCount] = await Promise.all([
    worker.evaluate(
      () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
    ),
    page.evaluate(
      () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
    ),
  ]);
  expect(generateCallCount).toBe(3);
  expect(sourceStartCount).toBe(2);
  // Play.tsx's generation-progress status line (describeKokoroGenerateProgress) only advances once
  // a chunk is actually accepted (kokoroTts.ts's onChunkAudio handler, which now runs on arrival —
  // before scheduling — for a buffered chunk too) — still reading "part 2" confirms chunk 3 hasn't
  // reached that point, independent of the worker-side call count.
  await expect(page.getByText("Generating narration — part 2 of", { exact: false })).toBeVisible();

  // Release chunk 3 so the turn (and the test) can finish cleanly rather than leaving the worker
  // permanently hung for the rest of the suite.
  await worker.evaluate(() =>
    (self as unknown as { __releaseKokoroGenerate?: () => void }).__releaseKokoroGenerate?.(),
  );
});

test("stop() immediately silences playback and no further chunk starts afterward", async ({ page }) => {
  // Deterministic, not timing-based (see the previous test's identical reasoning): chunks 1-2
  // generate and play for real (filling issue #68's startup buffer); chunk 3 hangs indefinitely at
  // the gate until explicitly released, well after stop() has already been clicked — so there's no
  // window in which chunk 3 could legitimately race stop() by finishing first.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { pauseAtCallIndex: 2 });
  await installKokoroSourceTracking(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

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
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBe(2);
  // Confirms chunk 3's generate() call has genuinely started (and is now hung on the gate) before
  // stop() below — otherwise a slow chunk 3 could still be queued up *behind* stop() rather than
  // actually racing it, which would prove less.
  await expect
    .poll(() =>
      worker.evaluate(
        () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
      ),
    )
    .toBe(3);

  await page.getByRole("button", { name: "Stop playback" }).click();
  // The UI reverts immediately — stop() doesn't wait on anything async.
  await expect(page.getByRole("button", { name: "Play this turn aloud" })).toBeVisible();

  // The nodes that had actually started were told to stop — silenced immediately, not left
  // playing out to their own natural end.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __kokoroSourceStops?: unknown[] }).__kokoroSourceStops?.length ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(2);

  // Now release chunk 3 — generation in the worker isn't cancelled by stop() (kokoro-js has no
  // abort primitive — see kokoroTts.ts's doc comment; stop() itself never even messages the
  // worker), so it — and chunk 4 behind it — finish and are posted to the main thread regardless.
  // This is the literal risk the issue called out: a queued next chunk starting playback after
  // stop() was already called. Waiting for the worker to report all chunks done proves the main
  // thread had every opportunity to (wrongly) schedule the rest, not just that it didn't get around
  // to it yet.
  await worker.evaluate(() =>
    (self as unknown as { __releaseKokoroGenerate?: () => void }).__releaseKokoroGenerate?.(),
  );
  // The exact chunk count depends on sentence splitting (prose + the spoken options trailer — see
  // turnBlocks.ts's blockToSpokenText) and isn't hardcoded here for the same reason
  // kokoro-webgpu-backend.spec.ts's device-lost test doesn't — poll until the worker stops
  // reporting new calls instead.
  let lastCallCount = -1;
  let stableRounds = 0;
  while (stableRounds < 3) {
    const count = await worker.evaluate(
      () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
    );
    stableRounds = count === lastCallCount && count > 1 ? stableRounds + 1 : 0;
    lastCallCount = count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const finalSourceStartCount = await page.evaluate(
    () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
  );
  expect(finalSourceStartCount).toBe(2);
  // The button stays reverted too — a late chunk didn't quietly resurrect "Stop playback".
  await expect(page.getByRole("button", { name: "Play this turn aloud" })).toBeVisible();
});

test("consecutive chunks are scheduled back-to-back with no gap in the AudioContext's own clock", async ({
  page,
}) => {
  // No artificial generate() delay here — the point is to prove the *scheduling math* is
  // sample-accurate when generation keeps up with playback (the design's actual goal), not to
  // reproduce a stall. A non-trivial chunk duration (0.5s) keeps the expected gap between each
  // chunk's scheduled start time well clear of floating-point noise.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { chunkDurationSec: 0.5 });
  await installKokoroSourceTracking(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

  await submitFreeTextTurn(page, "look around", "The hallway is silent. A door stands ajar.");
  await expect(page.getByText("The hallway is silent.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Play this turn aloud" }).click();
  // At least 3 chunks (2 prose sentences + the options trailer, itself split into 2+ sentences —
  // see turnBlocks.ts) — wait for all of them to be scheduled.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);

  const starts = await page.evaluate(
    () =>
      (window as unknown as { __kokoroSourceStarts?: { when: number }[] }).__kokoroSourceStarts ?? [],
  );
  // Each chunk's scheduled start time (the `when` argument passed to AudioBufferSourceNode.start(),
  // i.e. kokoroTts.ts's own computed `nextStartTime` — not wall-clock `performance.now()`) lands
  // exactly 0.5s after the previous one, with no gap and no overlap: this is what
  // "gapless-enough scheduling" reduces to on this code's side of the boundary — see kokoroTts.ts's
  // doc comment for what this can and can't prove about real audio hardware.
  for (let i = 1; i < starts.length; i++) {
    expect(starts[i].when - starts[i - 1].when).toBeCloseTo(0.5, 5);
  }
});

test("speak() settles a superseded call's own promise instead of leaving it pending forever", async ({
  page,
}) => {
  // Found in independent review of this issue's PR: a speak() call superseded by a *new* speak()
  // call (not stop()) — the routine case for switching turns, since Play.tsx's speakText() never
  // calls stop() before starting a new one, see its own comments — left its own returned promise
  // pending forever. Its onChunkAudio callback bails out via isStale() on every later chunk
  // without ever reaching the resolve() that only fires for the (here, never-reached, since
  // superseded) last chunk, and settleCurrent — the mechanism meant to catch exactly this — was
  // silently overwritten by the newer call's own assignment before the older call got a chance to
  // use it. Exercised directly against the provider (bypassing Play.tsx) since the hang itself has
  // no UI-visible symptom — Play.tsx's own `.finally()` side effects are already token-guarded
  // against a stale call taking effect, so this is a resource leak, not a rendering bug; the only
  // way to observe it is to hold a reference to the call's own promise, same as this test does.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { pauseAtCallIndex: 1 });

  await page.goto("/");
  const workerPromise = getKokoroWorker(page);

  // Chunk 1 (index 1) of a two-sentence turn hangs indefinitely — call 1's own last chunk, so its
  // promise cannot ever settle "naturally," isolating this test from any race with call 1
  // finishing on its own before call 2 below has a chance to supersede it.
  await page.evaluate(async () => {
    const mod = await import("/src/lib/voice/kokoroTts.ts");
    const w = window as unknown as {
      __kokoroTestProvider?: ReturnType<typeof mod.createKokoroTtsProvider>;
      __kokoroTestFirstSettled?: boolean;
    };
    const provider = mod.createKokoroTtsProvider();
    w.__kokoroTestProvider = provider;
    w.__kokoroTestFirstSettled = false;
    provider.speak("First sentence stays. Second sentence stays stuck.", {}).finally(() => {
      w.__kokoroTestFirstSettled = true;
    });
  });

  const worker = await workerPromise;
  // Call 1's first chunk has genuinely started generating — proof its own speak() call has
  // already progressed past its two synchronous-ish isStale() checks and into its Promise
  // executor (settleCurrent assigned to call 1's own resolve) before call 2 below supersedes it,
  // not raced ahead of it.
  await expect
    .poll(() =>
      worker.evaluate(
        () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(1);

  // Confirms it genuinely hasn't settled yet, so the poll below is proving something rather than
  // observing an already-true value.
  expect(
    await page.evaluate(
      () => (window as unknown as { __kokoroTestFirstSettled?: boolean }).__kokoroTestFirstSettled,
    ),
  ).toBe(false);

  // Supersede call 1 with a second, unrelated speak() call before its own last chunk ever reaches
  // playback.
  await page.evaluate(() => {
    const w = window as unknown as {
      __kokoroTestProvider?: { speak: (text: string, opts: Record<string, never>) => Promise<void> };
    };
    void w.__kokoroTestProvider?.speak("Unrelated second turn.", {});
  });

  // The core assertion: call 1's promise settles promptly once it's superseded, rather than
  // hanging until this poll's default timeout is exhausted.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __kokoroTestFirstSettled?: boolean }).__kokoroTestFirstSettled,
      ),
    )
    .toBe(true);

  // Release chunk 1's gate so nothing is left permanently hung in the worker after the test ends.
  await worker.evaluate(() =>
    (self as unknown as { __releaseKokoroGenerate?: () => void }).__releaseKokoroGenerate?.(),
  );
});

/**
 * Issue #68: reported Kokoro playback artifacts, investigated as a possible consequence of #62's
 * "start on chunk 1" design falling behind generation. Real (unfaked) Kokoro CPU inference in this
 * sandbox (kokoro-js's Node/onnxruntime-node backend — see kokoroTts.ts's "Startup playback buffer"
 * doc comment) found every generated chunk already has a clean silent taper at both ends — ruling
 * out an in-model boundary defect — and only a ~30% generation-speed margin over real-time even on
 * that favorable backend, making "falling behind" the most plausible surviving explanation. The fix:
 * `speak()` now buffers the first `KOKORO_PLAYBACK_BUFFER_CHUNKS` (2) generated chunks before
 * starting playback, rather than scheduling chunk 0 the instant it arrives, giving generation a real
 * head start. These tests prove that buffering behavior directly, the same way the tests above prove
 * the pre-buffer streaming/stop() guarantees — real, unfaked Web Audio scheduling.
 */
test("playback buffers two chunks before starting, instead of starting on chunk 1 alone", async ({
  page,
}) => {
  // Chunk 0 (call index 0) generates and resolves for real; chunk 1 (call index 1) hangs
  // indefinitely until released. If #62's original "start on chunk 1" behavior were still in
  // effect, chunk 0 alone finishing would already have scheduled and started playback — the whole
  // point of this test is proving that no longer happens.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { pauseAtCallIndex: 1 });
  await installKokoroSourceTracking(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

  await submitFreeTextTurn(page, "look around", "The hallway is silent. A door stands ajar.");
  await expect(page.getByText("The hallway is silent.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  // Chunk 1's generate() call has genuinely started (and is now hung on the gate) — proof chunk 0
  // has already finished and its audio has already reached the main thread's onChunkAudio handler,
  // not just that the turn hasn't gotten far enough yet to say anything either way.
  await expect
    .poll(() =>
      worker.evaluate(
        () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
      ),
    )
    .toBe(2);

  // The core regression assertion: chunk 0's audio arrived, but nothing has been scheduled for
  // playback yet, because the startup buffer is still waiting on chunk 1. Held for a short stretch
  // (not just checked once) so a delayed-but-still-happening schedule wouldn't be missed.
  for (let i = 0; i < 5; i++) {
    const count = await page.evaluate(
      () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
    );
    expect(count).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Releasing chunk 1 lets the buffer fill — both chunk 0 and chunk 1 should now be scheduled
  // together, back-to-back, in the same flush.
  await worker.evaluate(() =>
    (self as unknown as { __releaseKokoroGenerate?: () => void }).__releaseKokoroGenerate?.(),
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2);

  const starts = await page.evaluate(
    () => (window as unknown as { __kokoroSourceStarts?: { at: number }[] }).__kokoroSourceStarts ?? [],
  );
  // Both chunks were scheduled essentially simultaneously (the same synchronous flush), not one
  // waiting on the other's playback to begin first — proof they were flushed together, not that
  // chunk 1 merely followed chunk 0 the normal (post-buffer) way.
  expect(starts[1].at - starts[0].at).toBeLessThan(50);
});

test("a turn with fewer chunks than the startup buffer still plays once it's fully ready", async ({
  page,
}) => {
  // Exercised directly against the provider (like the "settles a superseded call" test above) so a
  // genuinely single-chunk turn can be produced without turnBlocks.ts's options-trailer sentences
  // pushing the chunk count up — the point here is proving flushPending's min(bufferSize, total)
  // logic doesn't wait forever for a second chunk a one-chunk turn will never produce.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page);
  await installKokoroSourceTracking(page);

  await page.goto("/");
  const workerPromise = getKokoroWorker(page);

  await page.evaluate(async () => {
    const mod = await import("/src/lib/voice/kokoroTts.ts");
    const w = window as unknown as { __kokoroTestSettled?: boolean };
    w.__kokoroTestSettled = false;
    mod.createKokoroTtsProvider().speak("Just one short sentence with no other sentences", {}).finally(() => {
      w.__kokoroTestSettled = true;
    });
  });
  await workerPromise;

  // Plays (and the call settles) without waiting on a second chunk that was never going to arrive.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
      ),
    )
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __kokoroTestSettled?: boolean }).__kokoroTestSettled))
    .toBe(true);
});
