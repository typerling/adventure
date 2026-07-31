import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

declare global {
  interface Window {
    __downloadPartial: (url: string, byteCount: number) => Promise<{ totalRead: number }>
    __downloadFull: (url: string) => Promise<{ status: number; bytes: number[] }>
  }
}

/**
 * Exercises src/lib/ai/localModelResumableFetch.ts directly, via a standalone harness page (see
 * tests/fixtures/resumable-fetch-harness.html) rather than through the real local-model loading
 * pipeline — actually loading the model needs real ONNX/tokenizer data and a working WebGPU
 * adapter, which ai-local-mode.spec.ts already documents as out of scope for automated tests.
 * This targets the actual behavior requested: an interrupted download (e.g. a page refresh)
 * should resume from where it left off, not restart from byte 0.
 */

const FILE_URL = 'https://huggingface.co/test-resumable-file'

function buildFixtureBytes(length: number): number[] {
  return Array.from({ length }, (_, i) => i % 256)
}

/** Serves `content` from a fake HF-hosted file, honoring Range requests like a real static host
 * would — 206 + Content-Range for a Range request, 200 + full body otherwise. */
async function mockRangeAwareFile(page: Page, content: number[]): Promise<{ requests: string[] }> {
  const state = { requests: [] as string[] }
  const buffer = Buffer.from(content)

  await page.route(FILE_URL, async (route: Route) => {
    const rangeHeader = route.request().headers()['range'] ?? ''
    state.requests.push(rangeHeader)

    const match = rangeHeader.match(/bytes=(\d+)-/)
    if (!match) {
      await route.fulfill({ status: 200, headers: { 'Content-Length': String(buffer.length) }, body: buffer })
      return
    }
    const start = parseInt(match[1], 10)
    const slice = buffer.subarray(start)
    await route.fulfill({
      status: 206,
      headers: {
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${buffer.length - 1}/${buffer.length}`,
      },
      body: slice,
    })
  })

  return state
}

test('an interrupted local-model download resumes from where it left off, not from byte 0', async ({ page }) => {
  const fixture = buildFixtureBytes(500)
  const mock = await mockRangeAwareFile(page, fixture)

  await page.goto('/tests/fixtures/resumable-fetch-harness.html')

  // Simulate a page refresh abandoning the download partway through — after this, whatever was
  // already flushed to IndexedDB (in 100-byte blocks, per the harness's block size) should stick.
  const partial = await page.evaluate(([url]) => window.__downloadPartial(url, 250), [FILE_URL])
  expect(partial.totalRead).toBeGreaterThan(0)

  // A real refresh — fresh JS context, but IndexedDB (where the partial blocks live) persists.
  await page.reload()

  const result = await page.evaluate(([url]) => window.__downloadFull(url), [FILE_URL])

  expect(mock.requests).toHaveLength(2)
  expect(mock.requests[0]).toBe('') // first attempt: no Range, starts from scratch
  const secondRangeStart = parseInt(mock.requests[1].match(/bytes=(\d+)-/)![1], 10)
  // The core behavior being tested: it resumes partway through, never restarting at 0. Streams
  // read ahead of what the test's consumer explicitly awaited, so the exact resume point isn't
  // predictable byte-for-byte — but it must be block-aligned (blocks flush every 100 bytes) and
  // short of the full file (the download was genuinely interrupted, not completed).
  expect(secondRangeStart).toBeGreaterThan(0)
  expect(secondRangeStart).toBeLessThan(fixture.length)
  expect(secondRangeStart % 100).toBe(0)

  // End-to-end correctness: the final bytes are the complete, correctly-ordered original file —
  // resuming didn't duplicate, drop, or corrupt anything across the two attempts.
  expect(result.status).toBe(200)
  expect(result.bytes).toEqual(fixture)
})

test('a request with nothing to resume behaves like a normal fetch', async ({ page }) => {
  const fixture = buildFixtureBytes(150)
  const mock = await mockRangeAwareFile(page, fixture)

  await page.goto('/tests/fixtures/resumable-fetch-harness.html')
  const result = await page.evaluate(([url]) => window.__downloadFull(url), [FILE_URL])

  expect(mock.requests).toEqual([''])
  expect(result.status).toBe(200)
  expect(result.bytes).toEqual(fixture)
})
