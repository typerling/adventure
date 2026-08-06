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
  opts: { voices?: Record<string, FakeKokoroVoice> } = {},
): Promise<void> {
  const voices = opts.voices ?? FAKE_KOKORO_VOICES;
  const fakeModule = `
    const VOICES = ${JSON.stringify(voices)}
    export class KokoroTTS {
      static async from_pretrained(modelId, options) {
        self.__kokoroLoadCalls = (self.__kokoroLoadCalls || 0) + 1
        if (options && options.progress_callback) {
          options.progress_callback({ status: 'ready' })
        }
        return new KokoroTTS()
      }
      get voices() { return VOICES }
      async generate(text, options) {
        const voice = (options && options.voice) || 'af_heart'
        self.__kokoroGenerateCalls = self.__kokoroGenerateCalls || []
        self.__kokoroGenerateCalls.push({ text, voice })
        // Recorded before this optional gate, so a test can observe the call happened while still
        // controlling exactly when it resolves — lets a test simulate acting (selecting a voice,
        // closing the dialog) while a preview is still in flight, deterministically.
        if (self.__kokoroGeneratePause) await self.__kokoroGeneratePause
        // audio/sampling_rate: what kokoroTts.worker.ts's stitchAudio() actually reads off the
        // real RawAudio-shaped return value (see its doc comment) — a couple of silent samples is
        // enough for a valid, playable (silent) clip without faking real speech synthesis. No
        // toBlob() here (unlike the real RawAudio) — production code only ever reads .audio/
        // .sampling_rate directly and builds its own WAV, so a fake toBlob would just be unused
        // surface implying an API nothing calls.
        return {
          audio: new Float32Array([0, 0]),
          sampling_rate: 24000,
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
