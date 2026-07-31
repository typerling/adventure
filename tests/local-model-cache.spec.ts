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
    __putAndMeasureStorage: (
      url: string,
      byteLength: number,
    ) => Promise<{ payloadBytes: number; storedBytes: number }>
    __hasCached: (modelId: string) => Promise<boolean>
    __clearCache: (modelId: string) => Promise<void>
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
 *
 * URLs are shaped like real cache keys (https://huggingface.co/<modelId>/resolve/main/<file> —
 * see buildResourcePaths() in the installed @huggingface/transformers package) since
 * hasCachedLocalModelFiles()/clearLocalModelCache() now match by that prefix to scope to one
 * model among several sharing the same IndexedDB database.
 */

const BLOCK_SIZE = 4 * 1024 * 1024 // must match localModelCache.ts's own BLOCK_SIZE
const MODEL_A = 'test-org/model-a'
const MODEL_B = 'test-org/model-b'

function fileUrl(modelId: string, file: string): string {
  return `https://huggingface.co/${modelId}/resolve/main/${file}`
}

test.describe('localModelCache block-chunked storage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/fixtures/local-model-cache-harness.html')
    await page.evaluate((modelId) => window.__clearCache(modelId), MODEL_A)
    await page.evaluate((modelId) => window.__clearCache(modelId), MODEL_B)
  })

  test('a payload smaller than one block round-trips exactly, with status/headers intact', async ({ page }) => {
    const result = await page.evaluate(
      ([url, length, chunkSize]) => window.__putAndMatch(url as string, length as number, chunkSize as number),
      [fileUrl(MODEL_A, 'model.onnx'), 1000, 300],
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
      ([url, length, chunkSize]) => window.__putAndMatch(url as string, length as number, chunkSize as number),
      [fileUrl(MODEL_A, 'model_q4f16.onnx_data'), byteLength, 65536],
    )
    expect(result.found).toBe(true)
    expect(result.length).toBe(byteLength)
    expect(result.matches).toBe(true)
  })

  test('a payload that is an exact multiple of the block size round-trips exactly', async ({ page }) => {
    const byteLength = BLOCK_SIZE * 2
    const result = await page.evaluate(
      ([url, length, chunkSize]) => window.__putAndMatch(url as string, length as number, chunkSize as number),
      [fileUrl(MODEL_A, 'model_q4f16.onnx_data'), byteLength, 262144],
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
      ([url, length, chunkSize]) => window.__putAndMatch(url as string, length as number, chunkSize as number),
      [fileUrl(MODEL_A, 'model_q4f16.onnx_data'), byteLength, byteLength],
    )
    expect(result.found).toBe(true)
    expect(result.length).toBe(byteLength)
    expect(result.matches).toBe(true)
  })

  test('storing a multi-block payload writes roughly its own size, not a copy per block', async ({ page }) => {
    // The round-trip tests above all pass whether or not each block is stored as a view into the
    // whole download buffer, because the bytes come back identical either way. What differs is how
    // much gets written: IndexedDB's structured clone serializes a view's entire backing
    // ArrayBuffer, so storing views multiplied a file's on-disk footprint by its block count —
    // 182x for the 728MB file behind Gemma 3 1B, which left put() (awaited inline by
    // @huggingface/transformers' load path) effectively never returning, stranding the UI on
    // "Preparing local model…" right after the download hit 100%. Only a storage-size assertion
    // catches that, so this measures it directly.
    const payloadBytes = BLOCK_SIZE * 4
    const { storedBytes } = await page.evaluate(
      ([url, length]) => window.__putAndMeasureStorage(url as string, length as number),
      [fileUrl(MODEL_A, 'model_q4f16.onnx_data'), payloadBytes],
    )
    // Generous headroom for IndexedDB's own per-record overhead and the granularity of
    // navigator.storage.estimate(): the bug this guards against costs ~4x here (one full-payload
    // clone per block) and grows with file size, so anything near 1x is unambiguously correct.
    expect(storedBytes).toBeLessThan(payloadBytes * 2)
  })

  test('hasCachedLocalModelFiles reflects what has actually been fully stored', async ({ page }) => {
    expect(await page.evaluate((modelId) => window.__hasCached(modelId), MODEL_A)).toBe(false)
    await page.evaluate(([url]) => window.__putAndMatch(url as string, 500, 100), [fileUrl(MODEL_A, 'x.onnx')])
    expect(await page.evaluate((modelId) => window.__hasCached(modelId), MODEL_A)).toBe(true)
  })

  test('matching a URL that was never cached returns undefined, not a crash', async ({ page }) => {
    expect(
      await page.evaluate((url) => window.__matchMissing(url), fileUrl(MODEL_A, 'never-cached.onnx')),
    ).toBe(true)
  })

  test('caching/clearing one model does not affect a different model sharing the same database', async ({
    page,
  }) => {
    await page.evaluate(([url]) => window.__putAndMatch(url as string, 500, 100), [fileUrl(MODEL_A, 'x.onnx')])
    await page.evaluate(([url]) => window.__putAndMatch(url as string, 500, 100), [fileUrl(MODEL_B, 'x.onnx')])
    expect(await page.evaluate((modelId) => window.__hasCached(modelId), MODEL_A)).toBe(true)
    expect(await page.evaluate((modelId) => window.__hasCached(modelId), MODEL_B)).toBe(true)

    await page.evaluate((modelId) => window.__clearCache(modelId), MODEL_A)

    expect(await page.evaluate((modelId) => window.__hasCached(modelId), MODEL_A)).toBe(false)
    expect(await page.evaluate((modelId) => window.__hasCached(modelId), MODEL_B)).toBe(true)
  })
})
