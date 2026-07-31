/**
 * A minimal Cache-API-compatible store (match/put) for @huggingface/transformers' `env.customCache`
 * hook, backed by IndexedDB instead of the browser's Cache Storage API. @huggingface/transformers
 * already caches downloaded model files by default via Cache Storage, but that API requires a
 * secure context (HTTPS, or the `localhost` exception) — this app's local AI mode is meant to be
 * tested on a phone's real GPU over a plain-HTTP LAN connection to the dev server (per
 * DESIGN.md/README), which is exactly the case Cache Storage can't cover. Without a working cache,
 * a several-hundred-MB-to-multi-GB model download (see localModel.ts's LOCAL_MODELS) repeats on
 * every reload and even on every generation. IndexedDB has no such restriction, so this is used
 * unconditionally rather than only as a fallback. Shared by every model rather than one database
 * per model — cache keys are the full source URL (see urlBelongsToModel below), which already
 * includes the model ID, so one store naturally partitions by model without needing one.
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

// Cache keys are the exact request URL (buildResourcePaths() in the installed package's
// hub.js — https://huggingface.co/<modelId>/resolve/<revision>/<file> — falls back to that as the
// cache key for any non-filesystem cache, which this is), so a model's own files can always be
// picked out by URL prefix without needing a separate per-model index.
const MODEL_HOSTS = ['huggingface.co', 'hf.co']

function urlBelongsToModel(url: string, modelId: string): boolean {
  return MODEL_HOSTS.some((host) => url.startsWith(`https://${host}/${modelId}/`))
}

/** Deletes one model's meta record and every block belonging to it, within a single transaction —
 * used by both hasCachedLocalModelFiles (indirectly, via matching) and clearLocalModelCache. */
function deleteModelEntry(db: IDBDatabase, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BLOCK_STORE, META_STORE], 'readwrite')
    tx.objectStore(META_STORE).delete(url)
    const cursorReq = tx.objectStore(BLOCK_STORE).openCursor(IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER]))
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      cursor.delete()
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear local model cache entry'))
  })
}

/** URLs of every cached file (any model) currently in META_STORE — walked with a cursor since
 * IndexedDB has no "key starts with" query, only exact/range lookups on the actual key (`url`
 * alone isn't indexed for prefix matching here). */
function getAllCachedUrls(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly')
    const cursorReq = tx.objectStore(META_STORE).openCursor()
    const urls: string[] = []
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) {
        resolve(urls)
        return
      }
      urls.push((cursor.value as StoredMeta).url)
      cursor.continue()
    }
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('Failed to scan local model cache'))
  })
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
        // A rejection here only reaches `cancel()` if the *consumer* cancels the stream — the
        // Streams spec doesn't call it when the underlying source's own pull() throws, so without
        // this the connection would leak on any read failure instead of just erroring the stream.
        let bytes: Uint8Array | undefined
        try {
          bytes = await readBlock(db, url, index)
        } catch (err) {
          db.close()
          throw err
        }
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

/** Whether any complete file for the given model is currently cached — lets Settings show
 * "downloaded" state even on a fresh page load, before anything in this session has touched it.
 * Scoped to one model so having a different model cached doesn't falsely read as this one being
 * ready — several models can each have their own cached files at once. */
export async function hasCachedLocalModelFiles(modelId: string): Promise<boolean> {
  const db = await openDb()
  try {
    const urls = await getAllCachedUrls(db)
    return urls.some((url) => urlBelongsToModel(url, modelId))
  } finally {
    db.close()
  }
}

/** Deletes every cached file belonging to one model, freeing the space it takes up on-device —
 * other models' cached files are untouched. */
export async function clearLocalModelCache(modelId: string): Promise<void> {
  const db = await openDb()
  try {
    const urls = await getAllCachedUrls(db)
    const matching = urls.filter((url) => urlBelongsToModel(url, modelId))
    for (const url of matching) await deleteModelEntry(db, url)
  } finally {
    db.close()
  }
}
