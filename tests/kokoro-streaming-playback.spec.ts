import { test, expect } from "@playwright/test";
import { installGoogleApiMock } from "./mocks/googleApi";
import { getKokoroWorker, installFakeKokoroModule, installKokoroSourceTracking } from "./mocks/kokoro";
import { createRandomCampaign, setCampaignVoiceProviders, submitFreeTextTurn } from "./helpers";

/**
 * Issue #62: Kokoro TTS now plays a turn's narration continuously as it generates — chunk 1 starts
 * playing as soon as it's ready, while later chunks keep generating in the worker, instead of
 * waiting for the whole turn (issue #44's original design) before any audio plays at all. See
 * kokoroTts.ts's module doc comment for the full design (playback engine, falling-behind handling,
 * WebGPU-restart de-duplication) — this spec exercises the actual behavior change plus the
 * guarantees that behavior change put at risk (stop() truly silencing everything immediately).
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

test("playback of chunk 1 starts while chunk 2 is still generating", async ({ page }) => {
  // Chunk 1 (call index 0) generates and resolves for real, at full (fake) speed; chunk 2 (call
  // index 1) hangs indefinitely until explicitly released — baked in at install time so there's no
  // race between setting this up and the worker racing ahead of it (see pauseAtCallIndex's doc
  // comment). If chunk 1 only started playing *after* the whole turn finished generating (issue
  // #44's old, now-replaced behavior), nothing would ever play at all here, since chunk 2 never
  // finishes in this test.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { pauseAtCallIndex: 1 });
  await installKokoroSourceTracking(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

  // Two prose sentences plus the spoken options trailer (see turnBlocks.ts's blockToSpokenText)
  // guarantee at least 3 chunks — comfortably more than the 2 this test needs to distinguish.
  await submitFreeTextTurn(page, "look around", "The hallway is silent. A door stands ajar.");
  await expect(page.getByText("The hallway is silent.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  // Chunk 1 has finished generating and its AudioBufferSourceNode has been scheduled — this can
  // only happen while chunk 2 is (permanently, in this test) still generating, since nothing else
  // is holding it up.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);

  // The core assertion: chunk 1 reached playback while chunk 2 is confirmed still generating, not
  // finished — proving playback started *before* the whole turn was ready, not after (issue #44's
  // old, now-replaced behavior, where nothing would ever reach playback in this test at all since
  // chunk 2 never finishes here). __kokoroGenerateCalls records a call the instant it *starts* (see
  // the fake's own comment on why, and pauseAtCallIndex), so a count of 2 here means "chunk 2's
  // generate() has started" — proving the worker is genuinely working ahead — not "chunk 2 is
  // done"; the progress text is what proves chunk 2 hasn't actually completed/reached playback yet.
  const [generateCallCount, sourceStartCount] = await Promise.all([
    worker.evaluate(
      () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
    ),
    page.evaluate(
      () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
    ),
  ]);
  expect(generateCallCount).toBe(2);
  expect(sourceStartCount).toBe(1);
  // Play.tsx's generation-progress status line (describeKokoroGenerateProgress) only advances once
  // a chunk is actually accepted for playback (kokoroTts.ts's onChunkAudio handler) — still reading
  // "part 1" confirms chunk 2 hasn't reached that point, independent of the worker-side call count.
  await expect(page.getByText("Generating narration — part 1 of", { exact: false })).toBeVisible();

  // Release chunk 2 so the turn (and the test) can finish cleanly rather than leaving the worker
  // permanently hung for the rest of the suite.
  await worker.evaluate(() =>
    (self as unknown as { __releaseKokoroGenerate?: () => void }).__releaseKokoroGenerate?.(),
  );
});

test("stop() immediately silences playback and no further chunk starts afterward", async ({ page }) => {
  // Deterministic, not timing-based (see the previous test's identical reasoning): chunk 1
  // generates and plays for real; chunk 2 hangs indefinitely at the gate until explicitly released,
  // well after stop() has already been clicked — so there's no window in which chunk 2 could
  // legitimately race stop() by finishing first.
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { pauseAtCallIndex: 1 });
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
    .toBe(1);
  // Confirms chunk 2's generate() call has genuinely started (and is now hung on the gate) before
  // stop() below — otherwise a slow chunk 2 could still be queued up *behind* stop() rather than
  // actually racing it, which would prove less.
  await expect
    .poll(() =>
      worker.evaluate(
        () => (self as unknown as { __kokoroGenerateCalls?: unknown[] }).__kokoroGenerateCalls?.length ?? 0,
      ),
    )
    .toBe(2);

  await page.getByRole("button", { name: "Stop playback" }).click();
  // The UI reverts immediately — stop() doesn't wait on anything async.
  await expect(page.getByRole("button", { name: "Play this turn aloud" })).toBeVisible();

  // The one node that had actually started was told to stop — silenced immediately, not left
  // playing out to its own natural end.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __kokoroSourceStops?: unknown[] }).__kokoroSourceStops?.length ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(1);

  // Now release chunk 2 — generation in the worker isn't cancelled by stop() (kokoro-js has no
  // abort primitive — see kokoroTts.ts's doc comment; stop() itself never even messages the
  // worker), so it — and chunk 3 behind it — finish and are posted to the main thread regardless.
  // This is the literal risk the issue called out: a queued next chunk starting playback after
  // stop() was already called. Waiting for the worker to report all 3 chunks done proves the main
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
  expect(finalSourceStartCount).toBe(1);
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
