import type { Page } from "@playwright/test";

/**
 * Fakes the `kokoro-js` module itself, rather than the network `kokoro-js` talks to — the app's
 * dev server (which `npm run test:e2e` drives, see playwright.config.ts) pre-bundles the whole
 * package plus its own dependencies (including a copy of `@huggingface/transformers`) into one
 * flat file, served at `/node_modules/.vite/deps/kokoro-js.js?v=<hash>`. Intercepting that single
 * request and replacing it with a tiny module exposing the same three exports `kokoroTts.ts`
 * actually imports (`KokoroTTS`, `TextSplitterStream`, `env`) means no real network fetch, no real
 * WASM inference, and no multi-hundred-MB download — see voice-kokoro.spec.ts's existing tests for
 * why that's out of scope for automated coverage otherwise (kokoro-chunking.spec.ts is the one
 * exception, since TextSplitterStream there is pure string processing needing no model).
 *
 * The fake's `generate()` records every (text, voice) call it received onto
 * `window.__kokoroGenerateCalls`, so a test can assert exactly which voice a given preview or
 * speak() call actually used — the one thing that can't be observed just by watching network
 * traffic, since voice selection only affects an in-memory call argument here, not a request.
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
        if (options && options.progress_callback) {
          options.progress_callback({ status: 'ready' })
        }
        return new KokoroTTS()
      }
      get voices() { return VOICES }
      async generate(text, options) {
        const voice = (options && options.voice) || 'af_heart'
        window.__kokoroGenerateCalls = window.__kokoroGenerateCalls || []
        window.__kokoroGenerateCalls.push({ text, voice })
        // Recorded before this optional gate, so a test can observe the call happened while still
        // controlling exactly when it resolves — lets a test simulate acting (selecting a voice,
        // closing the dialog) while a preview is still in flight, deterministically.
        if (window.__kokoroGeneratePause) await window.__kokoroGeneratePause
        return {
          toBlob: () => new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'audio/wav' }),
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
}
