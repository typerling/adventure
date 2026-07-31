/**
 * A drop-in replacement for `env.fetch` (see localModel.ts) that resumes an interrupted model
 * download instead of restarting it from byte 0 — the ~1GB Gemma download otherwise has to start
 * over every time the page is refreshed (or the network drops) mid-download, which on a slow or
 * flaky connection can mean it never finishes at all.
 *
 * How it works: downloaded bytes are mirrored into IndexedDB in ~4MB blocks as they stream past.
 * On the next attempt for the same URL, a `Range: bytes=<alreadyHave>-` request picks up from
 * there; the stored blocks are replayed first, then the live network stream continues seamlessly
 * behind a single synthesized `Response` — @huggingface/transformers' own file-loading code (see
 * `readResponse`/`loadResourceFile` in the installed package) sees one normal 200 response with
 * the *full* file's total Content-Length, identical to an uninterrupted download. Once a file
 * finishes, its partial-download record is deleted — localModelCache.ts's complete-file cache
 * takes over from there, and this code never runs again for that URL.
 */

const DB_NAME = 'adventure-local-model-partial'
const BLOCK_STORE = 'blocks'
const META_STORE = 'meta'
const DB_VERSION = 1
const BLOCK_SIZE = 4 * 1024 * 1024

interface PartialMeta {
  url: string
  receivedBytes: number
  blockCount: number
  etag: string | null
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore(BLOCK_STORE, { keyPath: ['url', 'blockIndex'] })
      db.createObjectStore(META_STORE, { keyPath: 'url' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open partial-download database'))
  })
}

async function getMeta(url: string): Promise<PartialMeta | undefined> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly')
      const req = tx.objectStore(META_STORE).get(url)
      req.onsuccess = () => resolve(req.result as PartialMeta | undefined)
      req.onerror = () => reject(req.error ?? new Error('Failed to read partial-download metadata'))
    })
  } finally {
    db.close()
  }
}

async function putMeta(meta: PartialMeta): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite')
      tx.objectStore(META_STORE).put(meta)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to write partial-download metadata'))
    })
  } finally {
    db.close()
  }
}

async function getBlock(url: string, blockIndex: number): Promise<Uint8Array | undefined> {
  const db = await openDb()
  try {
    const record = await new Promise<{ bytes: Uint8Array } | undefined>((resolve, reject) => {
      const tx = db.transaction(BLOCK_STORE, 'readonly')
      const req = tx.objectStore(BLOCK_STORE).get([url, blockIndex])
      req.onsuccess = () => resolve(req.result as { bytes: Uint8Array } | undefined)
      req.onerror = () => reject(req.error ?? new Error('Failed to read partial-download block'))
    })
    return record?.bytes
  } finally {
    db.close()
  }
}

async function putBlock(url: string, blockIndex: number, bytes: Uint8Array): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BLOCK_STORE, 'readwrite')
      tx.objectStore(BLOCK_STORE).put({ url, blockIndex, bytes })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to write partial-download block'))
    })
  } finally {
    db.close()
  }
}

async function clearPartial(url: string, blockCount: number): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOCK_STORE, META_STORE], 'readwrite')
      tx.objectStore(META_STORE).delete(url)
      const blockStore = tx.objectStore(BLOCK_STORE)
      for (let i = 0; i < blockCount; i++) blockStore.delete([url, i])
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear partial download'))
    })
  } finally {
    db.close()
  }
}

/** Deletes every in-progress partial download, if any — used when removing the model entirely
 * (localModel.ts's removeLocalModel), so a stale partial doesn't linger after a fresh download. */
export function clearAllPartialModelDownloads(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('Failed to clear partial model downloads'))
    req.onblocked = () => resolve()
  })
}

function mergeChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/** Replays any already-downloaded blocks for `url`, then continues from the live network stream
 * — mirroring new bytes into IndexedDB in BLOCK_SIZE batches as they pass through — and clears
 * the partial-download record once the stream naturally ends (the file is now complete). */
function buildResumingStream(
  url: string,
  startMeta: PartialMeta,
  networkBody: ReadableStream<Uint8Array>,
  blockSize: number,
): ReadableStream<Uint8Array> {
  const networkReader = networkBody.getReader()
  let replayIndex = 0
  let replaying = startMeta.blockCount > 0
  let blockIndex = startMeta.blockCount
  let receivedBytes = startMeta.receivedBytes
  let pendingChunks: Uint8Array[] = []
  let pendingBytes = 0

  async function flushPending(): Promise<void> {
    if (pendingBytes === 0) return
    const merged = mergeChunks(pendingChunks, pendingBytes)
    await putBlock(url, blockIndex, merged)
    blockIndex += 1
    receivedBytes += merged.length
    pendingChunks = []
    pendingBytes = 0
    await putMeta({ url, receivedBytes, blockCount: blockIndex, etag: startMeta.etag })
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replaying) {
        if (replayIndex < startMeta.blockCount) {
          const bytes = await getBlock(url, replayIndex)
          replayIndex += 1
          if (bytes) controller.enqueue(bytes)
          return
        }
        replaying = false
      }
      const { done, value } = await networkReader.read()
      if (done) {
        await flushPending()
        await clearPartial(url, blockIndex).catch(() => {})
        controller.close()
        return
      }
      controller.enqueue(value)
      pendingChunks.push(value)
      pendingBytes += value.length
      if (pendingBytes >= blockSize) await flushPending()
    },
    cancel() {
      networkReader.cancel().catch(() => {})
    },
  })
}

const RESUMABLE_HOSTS = ['huggingface.co', 'hf.co']

function isResumableUrl(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    return RESUMABLE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

/** Wraps `fetch` so requests to the model host resume from wherever a previous, interrupted
 * attempt left off. Everything else (other hosts, non-GET, requests that already specify their
 * own Range header — e.g. transformers.js' own file-size probes, or error responses) passes
 * straight through untouched. */
export function createResumableFetch(baseFetch: typeof fetch, blockSize: number = BLOCK_SIZE): typeof fetch {
  return async function resumableFetch(input, init) {
    if ((init?.method && init.method !== 'GET') || !isResumableUrl(input)) {
      return baseFetch(input, init)
    }
    const requestHeaders = new Headers(init?.headers)
    if (requestHeaders.has('Range')) {
      return baseFetch(input, init)
    }

    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const meta = await getMeta(url).catch(() => undefined)
    const resumeFrom = meta?.receivedBytes ?? 0
    if (resumeFrom > 0) requestHeaders.set('Range', `bytes=${resumeFrom}-`)

    let response = await baseFetch(input, { ...init, headers: requestHeaders })

    // 416 Range Not Satisfiable means the stored offset is past the end of the file — e.g. an
    // interruption right after a block flush landed exactly on the file length, or a clearPartial
    // that never completed. Left alone this is unrecoverable: every retry replays the same bad
    // Range and fails identically forever. Drop the partial and start over.
    if (response.status === 416 && resumeFrom > 0) {
      await response.body?.cancel().catch(() => {})
      if (meta) await clearPartial(url, meta.blockCount).catch(() => {})
      response = await baseFetch(input, { ...init, headers: new Headers(init?.headers) })
      if (response.status !== 200 || !response.body) return response
      return new Response(
        buildResumingStream(url, { url, receivedBytes: 0, blockCount: 0, etag: response.headers.get('ETag') }, response.body, blockSize),
        { status: 200, statusText: 'OK', headers: response.headers },
      )
    }

    // Not a success we know how to resume-wrap (404, 500, a redirect gone wrong, …) — hand it
    // back exactly as received so the caller's normal error handling still sees the real status.
    if ((response.status !== 200 && response.status !== 206) || !response.body) {
      return response
    }

    let startMeta: PartialMeta
    if (resumeFrom > 0 && response.status === 206) {
      const etag = response.headers.get('ETag')
      if (meta!.etag && etag && meta!.etag !== etag) {
        // The file at this URL changed since the partial download started — those bytes are for
        // a different version and can't be combined with this response. Discard both and refetch
        // cleanly from the start rather than risk silently splicing two different files together.
        await response.body.cancel().catch(() => {})
        await clearPartial(url, meta!.blockCount).catch(() => {})
        response = await baseFetch(input, { ...init, headers: new Headers(init?.headers) })
        if (response.status !== 200 || !response.body) return response
        startMeta = { url, receivedBytes: 0, blockCount: 0, etag: response.headers.get('ETag') }
      } else {
        startMeta = meta!
      }
    } else {
      // A fresh request, or the server ignored our Range header and sent everything from byte 0
      // again (some hosts do) — either way, start tracking from scratch.
      if (meta) await clearPartial(url, meta.blockCount).catch(() => {})
      startMeta = { url, receivedBytes: 0, blockCount: 0, etag: response.headers.get('ETag') }
    }

    const totalLength =
      response.status === 206
        ? (() => {
            const remaining = response.headers.get('Content-Length')
            return remaining ? String(startMeta.receivedBytes + parseInt(remaining, 10)) : null
          })()
        : response.headers.get('Content-Length')

    const headers = new Headers(response.headers)
    if (totalLength) headers.set('Content-Length', totalLength)

    return new Response(buildResumingStream(url, startMeta, response.body, blockSize), {
      status: 200,
      statusText: 'OK',
      headers,
    })
  }
}
