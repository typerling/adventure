import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    __splitChunks: (text: string) => Promise<string[]>
  }
}

/**
 * Regression coverage for a real, silent bug: Kokoro's `generate()` tokenizes with
 * `truncation: true` against a 512-token context (510 usable phoneme tokens + 2 specials — the
 * hardcoded `509` style-vector cap in its `generate_from_ids` is the same limit). Passing a whole
 * turn's narrative in one call therefore cut the audio off mid-sentence with no error at all. The
 * narrative below is the exact one from the bug report: 687 characters, and playback stopped at
 * "sensation" — character 474 — which is where the phoneme budget ran out.
 *
 * Only the sentence splitting is exercised here (kokoro-js's TextSplitterStream is pure string
 * processing, no model needed); actually generating speech needs a real model download, which
 * voice-kokoro.spec.ts explains is out of scope for automated tests.
 */

const REPORTED_NARRATIVE =
  'You brace yourself, your fingers gripping the cold brass of the cabinet lock. You try to force ' +
  'it, to wedge something into the mechanism, but it is stubbornly sealed. The metal resists your ' +
  'pressure, the old mechanism seeming to reject your intrusion. A sharp, grinding sound echoes in ' +
  'the small room, and the air around the lock suddenly grows noticeably colder, as if something ' +
  'has just shifted inside. You feel a faint, almost imperceptible vibration through the wood, a ' +
  'sensation that makes the hairs on your arms rise. The silence is shattered by a faint, dry ' +
  'whisper that seems to come from the very wood of the cabinet itself, too indistinct to form ' +
  'words, but undeniably present.'

/** The budget splitIntoSpeakableChunks enforces (MAX_CHUNK_CHARS in kokoroTts.ts). */
const MAX_CHUNK_CHARS = 320

test.describe('Kokoro splits narration so it is never silently truncated', () => {
  test('the narrative that got cut off is split into chunks that each fit the token budget', async ({
    page,
  }) => {
    await page.goto('/tests/fixtures/kokoro-chunking-harness.html')

    const chunks = await page.evaluate((text) => window.__splitChunks(text), REPORTED_NARRATIVE)

    // The whole point: it is no longer handed to the model as one over-long request.
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    }

    // Nothing is dropped or reordered — every word still gets spoken, in order. (Comparing
    // whitespace-normalised text, since splitting trims around sentence boundaries.)
    const normalise = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(normalise(chunks.join(' '))).toBe(normalise(REPORTED_NARRATIVE))

    // Specifically, the text after the old cut-off point ("sensation", char 474) survives — that's
    // exactly what was being lost before.
    expect(normalise(chunks.join(' '))).toContain('undeniably present.')
  })

  test('a single sentence too long on its own is split further rather than truncated', async ({ page }) => {
    await page.goto('/tests/fixtures/kokoro-chunking-harness.html')

    // One sentence, no interior punctuation to split on — TextSplitterStream alone would emit this
    // as a single over-budget chunk, so the word-boundary fallback has to catch it.
    const runOn = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}.`
    expect(runOn.length).toBeGreaterThan(MAX_CHUNK_CHARS)

    const chunks = await page.evaluate((text) => window.__splitChunks(text), runOn)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    }
    // Split on word boundaries, so no word is sliced in half.
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(runOn)
  })

  test('short text stays a single chunk', async ({ page }) => {
    await page.goto('/tests/fixtures/kokoro-chunking-harness.html')

    const chunks = await page.evaluate(
      (text) => window.__splitChunks(text),
      'The door creaks open.',
    )
    expect(chunks).toEqual(['The door creaks open.'])
  })
})
