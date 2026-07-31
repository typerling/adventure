import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    __putAndMatch: (
      url: string,
      byteLength: number,
      chunkSize: number,
    ) => Promise<{
      found: boolean
      status?: number
      statusText?: string
      headerValue?: string | null
      length?: number
      matches?: boolean
    }>
    __hasCached: () => Promise<boolean>
    __clearCache: () => Promise<void>
    __matchMissing: (url: string) => Promise<boolean>
  }
}

/**
 * Exercises src/lib/ai/localModelCache.ts's block-chunked put()/match() directly, via a standalone
 * harness page (tests/fixtures/local-model-cache-harness.html) rather than through a real model
 * load — no real ONNX data is needed to verify the storage layer's own correctness, and this can
 * feed payloads through arbitrary chunk sizes to specifically exercise put()'s accumulate-then-
 * merge logic (combining several reads' worth of bytes before writing a block), which a real
 * single-buffer Response wouldn't exercise since it delivers everything in one piece. The
 * harness compares bytes inside the page itself and only returns a boolean — returning a multi-MB
 * array through page.evaluate()'s IPC boundary is dramatically slower than what it'd be testing.
 */

const BLOCK_SIZE = 4 * 1024 * 1024 // must match localModelCache.ts's own BLOCK_SIZE

test.describe('localModelCache block-chunked storage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/fixtures/local-model-cache-harness.html')
    await page.evaluate(() => window.__clearCache())
  })

  test('a payload smaller than one block round-trips exactly, with status/headers intact', async ({ page }) => {
    const result = await page.evaluate(
      ([url, length, chunkSize]) => window.__putAndMatch(url, length, chunkSize),
      ['https://huggingface.co/small.onnx', 1000, 300],
    )
    expect(result.found).toBe(true)
    expect(result.status).toBe(200)
    expect(result.statusText).toBe('OK')
    expect(result.headerValue).toBe('yes')
    expect(result.length).toBe(1000)
    expect(result.matches).toBe(true)
  })

  test('a payload spanning multiple blocks, fed in irregular chunks, round-trips exactly', async ({ page }) => {
    const byteLength = BLOCK_SIZE + 12345 // just over one block
    // Small enough (well under BLOCK_SIZE) to exercise put()'s accumulate-then-merge path over
    // several reads, but not so small that this needs thousands of stream round-trips just to
    // cover one block — that's testing browser stream overhead, not this code.
    const result = await page.evaluate(
      ([url, length, chunkSize]) => window.__putAndMatch(url, length, chunkSize),
      ['https://huggingface.co/multi-block.onnx', byteLength, 65536],
    )
    expect(result.found).toBe(true)
    expect(result.length).toBe(byteLength)
    expect(result.matches).toBe(true)
  })

  test('a payload that is an exact multiple of the block size round-trips exactly', async ({ page }) => {
    const byteLength = BLOCK_SIZE * 2
    const result = await page.evaluate(
      ([url, length, chunkSize]) => window.__putAndMatch(url, length, chunkSize),
      ['https://huggingface.co/exact-blocks.onnx', byteLength, 262144],
    )
    expect(result.found).toBe(true)
    expect(result.length).toBe(byteLength)
    expect(result.matches).toBe(true)
  })

  test('a payload delivered as a single chunk (the real-world case) round-trips exactly', async ({ page }) => {
    // @huggingface/transformers always hands put() a Response already fully read into one
    // buffer — chunkSize >= byteLength makes the harness's stream deliver everything in a single
    // read(), exercising put()'s subarray-slicing fast path rather than the accumulate-then-merge
    // path the other tests above cover.
    const byteLength = BLOCK_SIZE + 12345
    const result = await page.evaluate(
      ([url, length, chunkSize]) => window.__putAndMatch(url, length, chunkSize),
      ['https://huggingface.co/single-chunk.onnx', byteLength, byteLength],
    )
    expect(result.found).toBe(true)
    expect(result.length).toBe(byteLength)
    expect(result.matches).toBe(true)
  })

  test('hasCachedLocalModelFiles reflects what has actually been fully stored', async ({ page }) => {
    expect(await page.evaluate(() => window.__hasCached())).toBe(false)
    await page.evaluate(() => window.__putAndMatch('https://huggingface.co/x.onnx', 500, 100))
    expect(await page.evaluate(() => window.__hasCached())).toBe(true)
  })

  test('matching a URL that was never cached returns undefined, not a crash', async ({ page }) => {
    expect(await page.evaluate(() => window.__matchMissing('https://huggingface.co/never-cached.onnx'))).toBe(true)
  })
})
