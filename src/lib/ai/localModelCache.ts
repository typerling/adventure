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
 * at a time via a stream.
 *
 * **Every block handed to IndexedDB must own an exactly-sized buffer** — see `toOwnedBlock`. This
 * is the one non-obvious constraint in this file, and getting it wrong doesn't corrupt anything,
 * it just silently multiplies what's written to disk by the number of blocks in the file.
 */

const DB_NAME = 'adventure-local-model-cache'
const BLOCK_STORE = 'blocks'
const META_STORE = 'meta'
const DB_VERSION = 3
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
      // Every version bump drops whatever was there and starts clean, rather than migrating: this
      // is a disposable cache that just re-downloads on a miss, and each bump so far has existed
      // precisely because the old contents were unusable or unwanted.
      //   v1 → v2: one blob per file, replaced by the blocks/meta pair below.
      //   v2 → v3: blocks written before toOwnedBlock existed each embedded a clone of the whole
      //     file (see toOwnedBlock), so a cached 728MB model could be occupying >100GB. Those
      //     entries read back fine, which is exactly why they'd otherwise linger forever. This
      //     also reclaims orphaned blocks from a put() that died partway: meta is written last, so
      //     an interrupted put() leaves blocks that no meta record points at, which makes them
      //     invisible to both hasCachedLocalModelFiles and clearLocalModelCache.
      for (const name of ['responses', BLOCK_STORE, META_STORE]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
      }
      db.createObjectStore(BLOCK_STORE, { keyPath: ['url', 'blockIndex'] })
      db.createObjectStore(META_STORE, { keyPath: 'url' })
    }
    // `blocked` fires instead of success/error when another tab still holds this database open at
    // an older version, so the upgrade above can't run. Without an explicit reject, that request
    // just sits there and every caller awaiting openDb() hangs indefinitely with no error — the
    // exact failure mode this file's DB_VERSION bump would otherwise be able to cause.
    //
    // It isn't terminal, though: the request stays live and still succeeds if that other tab
    // closes. Since this promise has already settled by then, the connection it hands back would
    // be one nobody ever closes — which would itself block the next upgrade. So track settlement
    // and close it on arrival.
    let settled = false
    req.onblocked = () => {
      settled = true
      reject(new Error('Another open tab is using the local model cache — close it and try again.'))
    }
    req.onsuccess = () => {
      if (settled) req.result.close()
      else {
        settled = true
        resolve(req.result)
      }
    }
    req.onerror = () => {
      settled = true
      reject(req.error ?? new Error('Failed to open local model cache database'))
    }
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

/**
 * Guarantees `bytes` is backed by an ArrayBuffer it covers *exactly*, copying if it isn't.
 *
 * IndexedDB stores values via the structured clone algorithm, and cloning an ArrayBufferView
 * serializes its **entire** `[[ViewedArrayBuffer]]`, not just the region the view spans (per the
 * HTML spec's StructuredSerializeInternal) — the view's offset/length are simply replayed over a
 * full copy of the buffer on the way back out. So handing this store a `subarray` of the big
 * download buffer writes the whole file to disk *per block*: for the 728MB file behind Gemma 3 1B
 * that's 182 blocks × 728MB ≈ 132GB, and for the 461MB Qwen2.5 0.5B file ≈ 53GB.
 *
 * This is invisible to a correctness test — the bytes round-trip exactly either way, which is why
 * the round-trip specs in tests/local-model-cache.spec.ts passed throughout — and surfaces only as
 * `put()` never appearing to return, i.e. a model that downloads to 100% and then sits on
 * "Preparing local model…" forever (see describeModelDownloadProgress, which shows exactly that
 * once every byte has arrived but from_pretrained() hasn't resolved). @huggingface/transformers
 * awaits this cache write inline in its load path (storeCachedResource in its hub.js), so however
 * long it takes is time the model load is blocked.
 *
 * The copy costs one BLOCK_SIZE allocation, not a full-file one — the thing the block-chunked
 * design exists to avoid in the first place.
 */
function toOwnedBlock(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes
  return bytes.slice()
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
    const metaDb = await openDb()
    let meta: StoredMeta | undefined
    try {
      meta = await getMeta(metaDb, url)
    } finally {
      metaDb.close()
    }
    if (!meta) return undefined
    const found = meta

    // The returned Response deliberately holds no open connection of its own until something
    // actually reads from it: @huggingface/transformers calls match() as a pure existence check
    // and discards the Response unread (see storeCachedResource in its hub.js, which bails early
    // if a key is already cached), so a connection opened eagerly here would be left open with no
    // stream event — pull or cancel — ever arriving to close it.
    //
    // Reads one block at a time as the consumer (@huggingface/transformers' readResponse) pulls
    // from this stream, rather than loading every block into memory up front — same reasoning as
    // localModelResumableFetch.ts's buildResumingStream.
    let index = 0
    let db: IDBDatabase | null = null
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= found.blockCount) {
          db?.close()
          db = null
          controller.close()
          return
        }
        // A rejection here only reaches `cancel()` if the *consumer* cancels the stream — the
        // Streams spec doesn't call it when the underlying source's own pull() throws, so without
        // this the connection would leak on any read failure instead of just erroring the stream.
        let bytes: Uint8Array | undefined
        try {
          db ??= await openDb()
          bytes = await readBlock(db, url, index)
        } catch (err) {
          db?.close()
          db = null
          throw err
        }
        index += 1
        if (bytes) controller.enqueue(bytes)
      },
      cancel() {
        db?.close()
        db = null
      },
    })
    return new Response(stream, { status: found.status, statusText: found.statusText, headers: found.headers })
  },

  async put(request: string | Request, response: Response): Promise<void> {
    const url = keyFor(request)
    const db = await openDb()
    try {
      // Drop anything already stored for this URL before rewriting it. The meta record is written
      // last (so a half-finished put() never reads back as a complete file), which means an
      // interrupted put() leaves blocks no meta record points at — unreachable to both
      // hasCachedLocalModelFiles and clearLocalModelCache, and therefore never reclaimable. This
      // also stops a re-put that produces fewer blocks than last time from stranding the tail.
      await deleteModelEntry(db, url)
      const reader = response.body?.getReader()
      let blockIndex = 0
      let pendingChunks: Uint8Array[] = []
      let pendingBytes = 0

      async function flushPending(): Promise<void> {
        if (pendingBytes === 0) return
        // mergeChunks already produces an exactly-sized buffer; a lone chunk is passed through
        // toOwnedBlock instead of copied blindly, since it's usually the trailing slice of the
        // single big chunk below and must not be stored as a view into it.
        const merged =
          pendingChunks.length === 1 ? toOwnedBlock(pendingChunks[0]) : mergeChunks(pendingChunks, pendingBytes)
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
          // buffer (see this file's top comment), so in practice this is a single chunk covering
          // the whole file — cut it straight into blocks here rather than funneling it through the
          // accumulate-then-merge path smaller chunks use below. `slice` (a copy of just this
          // block) rather than `subarray` (a view) is load-bearing, not defensive: see
          // toOwnedBlock. Only the trailing remainder is carried over, and it's owned by the time
          // it reaches IndexedDB via flushPending.
          if (pendingBytes === 0 && value.length >= BLOCK_SIZE) {
            let offset = 0
            while (value.length - offset >= BLOCK_SIZE) {
              await writeBlock(db, url, blockIndex, value.slice(offset, offset + BLOCK_SIZE))
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
