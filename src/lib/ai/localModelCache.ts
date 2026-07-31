/**
 * A minimal Cache-API-compatible store (match/put) for @huggingface/transformers' `env.customCache`
 * hook, backed by IndexedDB instead of the browser's Cache Storage API. @huggingface/transformers
 * already caches downloaded model files by default via Cache Storage, but that API requires a
 * secure context (HTTPS, or the `localhost` exception) — this app's local AI mode is meant to be
 * tested on a phone's real GPU over a plain-HTTP LAN connection to the dev server (per
 * DESIGN.md/README), which is exactly the case Cache Storage can't cover. Without a working cache,
 * the ~2.9GB Gemma download repeats on every reload and even on every generation. IndexedDB has no
 * such restriction, so this is used unconditionally rather than only as a fallback.
 *
 * Stored in ~4MB blocks (mirroring localModelResumableFetch.ts's partial-download cache) rather
 * than one blob per file. The old one-blob approach called `response.arrayBuffer()` in `put()` —
 * on a Response @huggingface/transformers already built from a fully-read, in-memory buffer, so
 * that call made a second full-size copy of a file that can be ~1.5GB, at exactly the moment
 * memory pressure from the download is already highest — and `match()` had to load an entire
 * stored blob back into memory before it could return anything. `match()` reads blocks back one
 * at a time via a stream. `put()`'s common case — @huggingface/transformers always hands it a
 * Response already fully read into one buffer — slices that single chunk directly via `subarray`
 * (a view, not a copy) rather than duplicating it; only genuinely smaller chunks (not expected in
 * practice, but not assumed against either) go through a copy, and only once a block's worth has
 * accumulated, not per chunk.
 */

const DB_NAME = 'adventure-local-model-cache'
const BLOCK_STORE = 'blocks'
const META_STORE = 'meta'
const DB_VERSION = 2
const BLOCK_SIZE = 4 * 1024 * 1024

interface StoredMeta {
  url: string
  status: number
  statusText: string
  headers: [string, string][]
  blockCount: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // v1 stored one blob per file under a 'responses' store, replaced by blocks/meta below —
      // not worth migrating, since this is a disposable cache that just re-downloads on a miss.
      if (db.objectStoreNames.contains('responses')) db.deleteObjectStore('responses')
      if (!db.objectStoreNames.contains(BLOCK_STORE)) {
        db.createObjectStore(BLOCK_STORE, { keyPath: ['url', 'blockIndex'] })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'url' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open local model cache database'))
  })
}

function keyFor(request: string | Request): string {
  return typeof request === 'string' ? request : request.url
}

function getMeta(db: IDBDatabase, url: string): Promise<StoredMeta | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly')
    const req = tx.objectStore(META_STORE).get(url)
    req.onsuccess = () => resolve(req.result as StoredMeta | undefined)
    req.onerror = () => reject(req.error ?? new Error('Failed to read local model cache metadata'))
  })
}

function putMeta(db: IDBDatabase, meta: StoredMeta): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite')
    tx.objectStore(META_STORE).put(meta)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to write local model cache metadata'))
  })
}

function readBlock(db: IDBDatabase, url: string, blockIndex: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOCK_STORE, 'readonly')
    const req = tx.objectStore(BLOCK_STORE).get([url, blockIndex])
    req.onsuccess = () => resolve((req.result as { bytes: Uint8Array } | undefined)?.bytes)
    req.onerror = () => reject(req.error ?? new Error('Failed to read local model cache block'))
  })
}

function writeBlock(db: IDBDatabase, url: string, blockIndex: number, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOCK_STORE, 'readwrite')
    tx.objectStore(BLOCK_STORE).put({ url, blockIndex, bytes })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to write local model cache block'))
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

export const localModelCache = {
  async match(request: string | Request): Promise<Response | undefined> {
    const url = keyFor(request)
    const db = await openDb()
    const meta = await getMeta(db, url).catch((err) => {
      db.close()
      throw err
    })
    if (!meta) {
      db.close()
      return undefined
    }
    // Reads one block at a time as the consumer (@huggingface/transformers' readResponse) pulls
    // from this stream, rather than loading every block into memory up front — same reasoning as
    // localModelResumableFetch.ts's buildResumingStream.
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= meta.blockCount) {
          db.close()
          controller.close()
          return
        }
        const bytes = await readBlock(db, url, index)
        index += 1
        if (bytes) controller.enqueue(bytes)
      },
      cancel() {
        db.close()
      },
    })
    return new Response(stream, { status: meta.status, statusText: meta.statusText, headers: meta.headers })
  },

  async put(request: string | Request, response: Response): Promise<void> {
    const url = keyFor(request)
    const db = await openDb()
    try {
      const reader = response.body?.getReader()
      let blockIndex = 0
      let pendingChunks: Uint8Array[] = []
      let pendingBytes = 0

      async function flushPending(): Promise<void> {
        if (pendingBytes === 0) return
        // Skip the merge copy entirely when there's only one piece to write — the common case
        // below, where this is a lone leftover slice from an already-block-sized chunk.
        const merged = pendingChunks.length === 1 ? pendingChunks[0] : mergeChunks(pendingChunks, pendingBytes)
        await writeBlock(db, url, blockIndex, merged)
        blockIndex += 1
        pendingChunks = []
        pendingBytes = 0
      }

      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // @huggingface/transformers always hands put() a Response already fully read into one
          // buffer (see this file's top comment), so in practice this is a single chunk already
          // at least block-sized. Slice it directly via `subarray` (a view, not a copy — IndexedDB's
          // own write already clones whatever it's given to persist it) rather than funneling it
          // through the same accumulate-then-copy path smaller chunks use below, which would
          // otherwise duplicate a buffer that can be ~1.5GB just to get it into IndexedDB.
          if (pendingBytes === 0 && value.length >= BLOCK_SIZE) {
            let offset = 0
            while (value.length - offset >= BLOCK_SIZE) {
              await writeBlock(db, url, blockIndex, value.subarray(offset, offset + BLOCK_SIZE))
              blockIndex += 1
              offset += BLOCK_SIZE
            }
            if (offset < value.length) {
              pendingChunks = [value.subarray(offset)]
              pendingBytes = value.length - offset
            }
            continue
          }
          // Smaller chunks (or a small leftover from the case above) accumulate here and are only
          // ever copied once, when a block's worth has built up — not on every individual chunk,
          // which would make this quadratic in the number of chunks.
          pendingChunks.push(value)
          pendingBytes += value.length
          if (pendingBytes >= BLOCK_SIZE) await flushPending()
        }
        await flushPending()
      }

      await putMeta(db, {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        blockCount: blockIndex,
      })
    } finally {
      db.close()
    }
  },
}

/** Whether any complete model file is currently cached — lets Settings show "downloaded" state
 * even on a fresh page load, before anything in this session has touched the model. */
export async function hasCachedLocalModelFiles(): Promise<boolean> {
  const db = await openDb()
  try {
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly')
      const req = tx.objectStore(META_STORE).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('Failed to count local model cache entries'))
    })
    return count > 0
  } finally {
    db.close()
  }
}

/** Deletes every cached model file, freeing the ~2.9GB it takes up on-device. */
export function clearLocalModelCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('Failed to clear local model cache'))
    // A database can't be deleted while another connection is still open (openDb always closes
    // its own connection right after use, but guard against it anyway rather than hang forever).
    req.onblocked = () => resolve()
  })
}
