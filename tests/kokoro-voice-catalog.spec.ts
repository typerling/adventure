import { test, expect } from '@playwright/test'
import { KOKORO_VOICE_CATALOG } from '../src/lib/voice/kokoroVoiceCatalog'

/**
 * Pure Node-side test — no `page`, no browser — proving two things for issue #98's static voice
 * catalog (`src/lib/voice/kokoroVoiceCatalog.ts`):
 *
 * 1. The shortcut its doc comment describes really works: `KokoroTTS.prototype`'s `voices` getter
 *    is reachable with no real instance and no model load at all, since the minified getter
 *    (`get voices(){return $}`) never reads `this`. Verified here by literally doing it — not
 *    re-asserting the doc comment's claim, but exercising it — against the real installed
 *    `kokoro-js` package, the same one the app depends on.
 * 2. `KOKORO_VOICE_CATALOG` is a byte-for-byte mirror of what that getter actually returns today,
 *    so upstream drift (a new voice, a changed grade) fails this test loudly instead of silently
 *    producing a prompt that recommends a voice id the installed kokoro-js doesn't recognize.
 *
 * Deliberately NOT part of the browser-driven Playwright suite's page-level tests: this needs no
 * `page`, so it runs as fast as any other Node unit test despite living in `tests/*.spec.ts` —
 * same pattern `backward-compat-row-shapes.spec.ts`'s "row codec tolerates a short row" test
 * already uses for a pure-function contract.
 */
test('KOKORO_VOICE_CATALOG matches the real kokoro-js package\'s own voices getter', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kokoroJs: any = await import('kokoro-js')
  const descriptor = Object.getOwnPropertyDescriptor(kokoroJs.KokoroTTS.prototype, 'voices')
  expect(descriptor?.get, 'kokoro-js should still expose a `voices` getter on the prototype').toBeTruthy()

  // The whole point being verified: call the getter with no `this` at all.
  const realVoices = descriptor!.get!.call(undefined)

  expect(Object.keys(realVoices).sort()).toEqual(Object.keys(KOKORO_VOICE_CATALOG).sort())
  expect(realVoices).toEqual(KOKORO_VOICE_CATALOG)
})
