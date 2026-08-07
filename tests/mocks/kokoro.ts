import type { Page, Worker } from "@playwright/test";

/**
 * Finds the page's kokoroTts.worker.ts instance — needed because #44 moved KokoroTTS itself into
 * that worker, which is a genuinely separate JS realm from the page: `self.__kokoroGenerateCalls`
 * set inside it is not reachable via `page.evaluate()` (that only ever sees `window`), so a test
 * that needs it has to go through Playwright's own `Worker.evaluate()` instead.
 *
 * Checks already-attached workers first (the common case: called after whatever UI action creates
 * the worker has already resolved), falling back to waiting for the `worker` event for the case
 * where this is called before that action's effects have landed yet.
 */
export async function getKokoroWorker(page: Page): Promise<Worker> {
  const existing = page.workers().find((w) => w.url().includes("kokoroTts.worker"));
  if (existing) return existing;
  return page.waitForEvent("worker", {
    predicate: (w) => w.url().includes("kokoroTts.worker"),
    timeout: 15_000,
  });
}

/**
 * Fakes the `kokoro-js` module itself, rather than the network `kokoro-js` talks to — the app's
 * dev server (which `npm run test:e2e` drives, see playwright.config.ts) pre-bundles the whole
 * package plus its own dependencies (including a copy of `@huggingface/transformers`) into one
 * flat file, served at `/node_modules/.vite/deps/kokoro-js.js?v=<hash>`. Intercepting that single
 * request and replacing it with a tiny module exposing the same three exports `kokoroTts.ts`/
 * `kokoroTts.worker.ts` actually import (`KokoroTTS`, `TextSplitterStream`, `env`) means no real
 * network fetch, no real WASM inference, and no multi-hundred-MB download — see
 * voice-kokoro.spec.ts's existing tests for why that's out of scope for automated coverage
 * otherwise (kokoro-chunking.spec.ts is the one exception, since TextSplitterStream there is pure
 * string processing needing no model). Vite serves the same pre-bundled URL to whatever imports the
 * bare `kokoro-js` specifier, whether that's the main thread (splitIntoSpeakableChunks' use of
 * TextSplitterStream) or kokoroTts.worker.ts (KokoroTTS, since #44 moved model loading/generation
 * there) — this one `page.route` covers both.
 *
 * The fake's `generate()` records every (text, voice) call it received onto
 * `self.__kokoroGenerateCalls`, so a test can assert exactly which voice a given preview or
 * speak() call actually used — the one thing that can't be observed just by watching network
 * traffic, since voice selection only affects an in-memory call argument here, not a request.
 * Deliberately `self`, not `window`: since #44, `KokoroTTS` only ever runs inside
 * kokoroTts.worker.ts, which has no `window` — a dedicated Worker's global scope is a *separate*
 * realm from the page's, so state set there isn't reachable via `page.evaluate()` at all. Tests
 * that need it read it via Playwright's `Worker.evaluate()` instead (see getKokoroWorker() in
 * voice-kokoro.spec.ts) — `self` is what's correct to read from either side, since it also means
 * "the current global" on the main thread.
 */

export interface FakeKokoroVoice {
  name: string;
  language: string;
  gender: string;
  traits?: string;
}

export const FAKE_KOKORO_VOICES: Record<string, FakeKokoroVoice> = {
  af_heart: { name: "Heart", language: "en-us", gender: "Female", traits: "❤️" },
  am_adam: { name: "Adam", language: "en-us", gender: "Male" },
};

export async function installFakeKokoroModule(
  page: Page,
  opts: {
    voices?: Record<string, FakeKokoroVoice>;
    /** Simulates "no WebGPU adapter available at all" (issue #51's opt-in WebGPU backend) —
     * `KokoroTTS.from_pretrained()` rejects for `device: 'webgpu'` with the exact message
     * onnxruntime-web uses for that case (verified against the installed package's bundled
     * source, see kokoroTts.worker.ts's isWebgpuFailure doc comment), so
     * kokoroTts.worker.ts's loadWithFallback has something realistic to detect and recover from.
     * `device: 'wasm'` loads are unaffected. */
    failWebgpuLoad?: boolean;
    /** Simulates a WebGPU device lost *after* a successful load. `true` fails every `generate()`
     * call against a `device: 'webgpu'` instance (device lost on the very first chunk); a number N
     * instead lets the first N webgpu calls succeed and fails only the (N+1)th — for issue #62's
     * streaming de-duplication tests, which need some chunks to have genuinely succeeded (and been
     * streamed to the main thread, and scheduled for playback) on webgpu *before* the device is
     * lost, so there's something for the WASM restart to risk re-playing. A `'wasm'`-loaded
     * instance is never affected either way. Every attempt (successful or not) is still recorded
     * onto `self.__kokoroGenerateAttempts` before a throw, so a test can see the failed webgpu
     * attempt(s) as well as the (wasm) calls that actually produced audio. */
    failWebgpuGenerate?: boolean | number;
    /** Seconds of (silent) audio each generated chunk contains — default 2 samples (~0ms), enough
     * for a valid playable buffer but not enough to schedule/measure real playback duration against.
     * kokoro-streaming-playback.spec.ts's gapless-scheduling test sets this to something non-trivial
     * so consecutive chunks' computed AudioContext start times are far enough apart to assert on
     * without floating-point noise. */
    chunkDurationSec?: number;
    /** Hangs the (0-based) `callIndex`th `generate()` call indefinitely until
     * `self.__releaseKokoroGenerate()` is called — baked into the module at install time (unlike
     * `self.__kokoroGeneratePause`, a plain runtime flag) specifically so there's no race between a
     * test setting the gate and the worker racing ahead of it: the worker doesn't even exist until
     * the first call that needs Kokoro, so a runtime flag can't reliably be set before generation
     * starts without first waiting for calls before the one being targeted, which the caller may not
     * want to let run unthrottled. Lets a test allow earlier chunks (e.g. chunk 0) to generate and
     * play for real, deterministically, while halting at a specific later chunk. */
    pauseAtCallIndex?: number;
  } = {},
): Promise<void> {
  const voices = opts.voices ?? FAKE_KOKORO_VOICES;
  const fakeModule = `
    const VOICES = ${JSON.stringify(voices)}
    const FAIL_WEBGPU_LOAD = ${opts.failWebgpuLoad ? "true" : "false"}
    const FAIL_WEBGPU_GENERATE = ${JSON.stringify(opts.failWebgpuGenerate ?? false)}
    const PAUSE_AT_CALL_INDEX = ${JSON.stringify(opts.pauseAtCallIndex ?? null)}
    const SAMPLE_RATE = 24000
    const CHUNK_LENGTH = Math.max(2, Math.round(${opts.chunkDurationSec ?? 0} * SAMPLE_RATE))
    let webgpuSuccessCount = 0
    export class KokoroTTS {
      constructor(device) { this.device = device }
      static async from_pretrained(modelId, options) {
        self.__kokoroLoadCalls = (self.__kokoroLoadCalls || 0) + 1
        const device = (options && options.device) || 'wasm'
        self.__kokoroLoadDevices = self.__kokoroLoadDevices || []
        self.__kokoroLoadDevices.push(device)
        if (FAIL_WEBGPU_LOAD && device === 'webgpu') {
          // The exact string onnxruntime-web throws when device: 'webgpu' is requested with no
          // usable adapter — see ort.webgpu.mjs / ort.all.mjs's shared backend-registration check.
          throw new Error('WebGPU is not supported in current environment')
        }
        if (options && options.progress_callback) {
          options.progress_callback({ status: 'ready' })
        }
        return new KokoroTTS(device)
      }
      get voices() { return VOICES }
      async generate(text, options) {
        self.__kokoroGenerateAttempts = self.__kokoroGenerateAttempts || []
        self.__kokoroGenerateAttempts.push({ text, device: this.device })
        const shouldFailNow =
          this.device === 'webgpu' &&
          (FAIL_WEBGPU_GENERATE === true ||
            (typeof FAIL_WEBGPU_GENERATE === 'number' && webgpuSuccessCount === FAIL_WEBGPU_GENERATE))
        if (shouldFailNow) {
          // Shaped like ONNX Runtime's real "device lost" C++ message — see
          // kokoroTts.worker.ts's isWebgpuFailure doc comment for why this specific wording.
          throw new Error('Device is lost: reason unknown [reset] - description not available')
        }
        if (this.device === 'webgpu') webgpuSuccessCount++
        const voice = (options && options.voice) || 'af_heart'
        self.__kokoroGenerateCalls = self.__kokoroGenerateCalls || []
        const callIndex = self.__kokoroGenerateCalls.length
        self.__kokoroGenerateCalls.push({ text, voice, device: this.device })
        // Recorded before either gate below, so a test can observe the call happened while still
        // controlling exactly when it resolves — lets a test simulate acting (selecting a voice,
        // closing the dialog) while a preview is still in flight, or asserting mid-turn streaming
        // state, deterministically.
        if (self.__kokoroGeneratePause) await self.__kokoroGeneratePause
        // See PAUSE_AT_CALL_INDEX's doc comment above for why this is baked in at install time
        // rather than a runtime-settable flag like the gate above.
        if (PAUSE_AT_CALL_INDEX === callIndex) {
          await new Promise((resolve) => { self.__releaseKokoroGenerate = resolve })
        }
        // audio/sampling_rate: what kokoroTts.worker.ts's doSpeak/doSpeakStream actually read off
        // the real RawAudio-shaped return value (see stitchAudio's doc comment) — a couple of
        // silent samples is enough for a valid, playable (silent) chunk without faking real speech
        // synthesis. No toBlob() here (unlike the real RawAudio) — production code only ever reads
        // .audio/.sampling_rate directly, so a fake toBlob would just be unused surface implying an
        // API nothing calls.
        return {
          audio: new Float32Array(CHUNK_LENGTH),
          sampling_rate: SAMPLE_RATE,
        }
      }
    }
    export class TextSplitterStream {
      constructor() { this._buf = '' }
      push(...parts) { this._buf += parts.join('') }
      close() {}
      [Symbol.iterator]() {
        const sentences = this._buf.split(/(?<=[.!?])\\s+/).filter((s) => s.trim().length > 0)
        return sentences[Symbol.iterator]()
      }
    }
    export const env = { wasmPaths: '' }
  `;
  await page.route("**/kokoro-js.js*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: fakeModule,
    }),
  );
  // Defense in depth: this intercept depends on Vite's current dev-dependency pre-bundling
  // behavior (serving kokoro-js from a `/node_modules/.vite/deps/kokoro-js.js?v=...` URL) — if a
  // future Vite upgrade changes that path/condition, the route above would simply stop matching.
  // Without this, a silently-broken intercept wouldn't fail loudly: kokoroTts.ts would fall
  // through to the real kokoro-js module and attempt a genuine ~300MB model download over the
  // network, hanging/timing out rather than giving a clear "mock didn't intercept" failure.
  // Aborting the real endpoints turns that into an immediate, obvious test failure instead.
  await page.route(/huggingface\.co|hf\.co/, (route) => route.abort("failed"));
}

/**
 * Instruments the *real* Web Audio API (kept genuinely functional — see
 * kokoro-streaming-playback.spec.ts's doc comment for why headless Chromium in this sandbox
 * actually runs it, unlike a real audio device) rather than replacing it, so a test can observe
 * exactly when kokoroTts.ts's playback engine calls `AudioBufferSourceNode.start()`/`.stop()`
 * without altering real scheduling/timing behavior at all. Records each call's `performance.now()`
 * onto `window.__kokoroSourceStarts`/`__kokoroSourceStops` (chronological order), the Web-Audio
 * equivalent of the old per-turn `new Audio()`-construction counter this replaces — proof that a
 * chunk genuinely reached playback, not just that the "Stop playback" button's optimistic UI state
 * flipped (see kokoroTts.ts's own doc comment on why that button alone can't tell "still
 * generating" from "now actually playing").
 */
export async function installKokoroSourceTracking(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = AudioBufferSourceNode.prototype;
    const originalStart = proto.start;
    const originalStop = proto.stop;
    const w = window as unknown as {
      __kokoroSourceStarts?: { at: number; when: number }[];
      __kokoroSourceStops?: { at: number }[];
    };
    w.__kokoroSourceStarts = [];
    w.__kokoroSourceStops = [];
    proto.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof originalStart>) {
      w.__kokoroSourceStarts!.push({ at: performance.now(), when: args[0] ?? 0 });
      return originalStart.apply(this, args);
    };
    proto.stop = function (this: AudioBufferSourceNode, ...args: Parameters<typeof originalStop>) {
      w.__kokoroSourceStops!.push({ at: performance.now() });
      return originalStop.apply(this, args);
    };
  });
}

/**
 * Fully fakes the Web Audio surface kokoroTts.ts's streaming playback uses (`AudioContext`/
 * `AudioBuffer`/`AudioBufferSourceNode`) — for tests that need a *stable* "still playing" window
 * rather than real timing. Real Web Audio genuinely works headlessly here (see
 * kokoro-streaming-playback.spec.ts), but the fake `kokoro-js` module above generates
 * near-zero-length audio (two samples), so a *real* scheduled buffer would fire 'ended' within
 * microseconds — no usable window for a test to assert "genuinely still playing" against before it
 * naturally ends. Mirrors installFakeAudioPlayback/installControllableAudioPlayback's dual
 * auto-end/never-end split for the old `new Audio()`-per-turn model, applied to the Web Audio
 * surface instead: `autoEnd: true` fires 'ended' on the next macrotask after `start()` (like
 * installFakeAudioPlayback); the default, `autoEnd: false`, never fires it on its own (like
 * installControllableAudioPlayback) — a scheduled source stays "playing" until the test's own
 * assertions are done or the page navigates away, and `.stop()` still fires 'ended' explicitly (a
 * real AudioBufferSourceNode does the same), so kokoroTts.ts's stop()-path resolution still works.
 * Every started source is still recorded onto `window.__kokoroSourceStarts`, same shape as
 * installKokoroSourceTracking, so assertions written against one work against the other.
 */
async function installFakeWebAudio(page: Page, autoEnd: boolean): Promise<void> {
  await page.addInitScript((autoEnd: boolean) => {
    class FakeAudioBuffer {
      numberOfChannels: number;
      length: number;
      sampleRate: number;
      private data: Float32Array;
      constructor(numberOfChannels: number, length: number, sampleRate: number) {
        this.numberOfChannels = numberOfChannels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.data = new Float32Array(length);
      }
      get duration() {
        return this.length / this.sampleRate;
      }
      getChannelData() {
        return this.data;
      }
      copyToChannel(source: Float32Array) {
        this.data.set(source);
      }
    }
    class FakeSourceNode extends EventTarget {
      buffer: FakeAudioBuffer | null = null;
      onended: (() => void) | null = null;
      private startedAt: number | null = null;
      connect() {}
      start(when?: number) {
        this.startedAt = performance.now();
        const w = window as unknown as { __kokoroSourceStarts?: { at: number; when: number }[] };
        w.__kokoroSourceStarts = w.__kokoroSourceStarts ?? [];
        w.__kokoroSourceStarts.push({ at: this.startedAt, when: when ?? 0 });
        if (autoEnd) setTimeout(() => this.onended?.(), 0);
      }
      stop() {
        // Real AudioBufferSourceNode.stop() dispatches 'ended' even when called before the node's
        // scheduled time arrives — mirrored here so kokoroTts.ts's stop()-triggered resolution path
        // (which relies on that for a node that hasn't audibly started yet) works against this fake
        // too, not just against real Web Audio.
        if (this.startedAt !== null) this.onended?.();
      }
    }
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
        return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
      }
      createBufferSource() {
        return new FakeSourceNode();
      }
      resume() {
        this.state = "running";
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", { value: FakeAudioContext, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: FakeAudioContext, configurable: true });
  }, autoEnd);
}

/** Like installFakeAudioPlayback, but for kokoroTts.ts's Web Audio-based turn playback — fires
 * 'ended' on every scheduled chunk almost immediately. */
export async function installFakeWebAudioPlayback(page: Page): Promise<void> {
  await installFakeWebAudio(page, true);
}

/** Like installControllableAudioPlayback, but for kokoroTts.ts's Web Audio-based turn playback —
 * a scheduled chunk never fires 'ended' on its own. */
export async function installControllableWebAudioPlayback(page: Page): Promise<void> {
  await installFakeWebAudio(page, false);
}

/**
 * Waits until no *new* chunk has reached playback (`window.__kokoroSourceStarts` — see
 * installKokoroSourceTracking/installControllableWebAudioPlayback) for a short stretch, then
 * returns however many have. Streaming (issue #62) means a turn's audio is no longer signalled
 * "fully generated" by one single event a test can await (the old model's one `new Audio()`
 * construction, after the whole stitched clip was ready) — a genuinely-complete WebGPU-fallback
 * job in particular streams chunks across *two* generation passes (the failed webgpu attempt(s),
 * then a full WASM restart — see kokoroTts.worker.ts's doSpeakStream), so polling for "at least
 * one chunk started" alone would race a still-in-flight restart. This polls at a fixed, short
 * interval instead of a single blind wait, so it settles as soon as generation genuinely stops
 * producing new chunks rather than always waiting a fixed worst-case duration.
 */
export async function waitForKokoroPlaybackToStabilize(page: Page): Promise<number> {
  let last = -1;
  let stableRounds = 0;
  while (stableRounds < 3) {
    const count = await page.evaluate(
      () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
    );
    stableRounds = count === last && count > 0 ? stableRounds + 1 : 0;
    last = count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}
