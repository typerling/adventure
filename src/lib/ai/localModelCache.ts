/**
 * A minimal Cache-API-compatible store (match/put) for @huggingface/transformers' `env.customCache`
 * hook, backed by IndexedDB instead of the browser's Cache Storage API. @huggingface/transformers
 * already caches downloaded model files by default via Cache Storage, but that API requires a
 * secure context (HTTPS, or the `localhost` exception) — this app's local AI mode is meant to be
 * tested on a phone's real GPU over a plain-HTTP LAN connection to the dev server (per
 * DESIGN.md/README), which is exactly the case Cache Storage can't cover. Without a working cache,
 * the ~2.9GB Gemma download repeats on every reload and even on every generation. IndexedDB has no
 * such restriction, so this is used unconditionally rather than only as a fallback.
 */

const DB_NAME = 'adventure-local-model-cache'
const STORE_NAME = 'responses'
const DB_VERSION = 1

interface StoredEntry {
  url: string
  status: number
  statusText: string
  headers: [string, string][]
  body: ArrayBuffer
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'url' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open local model cache database'))
  })
}

function keyFor(request: string | Request): string {
  return typeof request === 'string' ? request : request.url
}

export const localModelCache = {
  async match(request: string | Request): Promise<Response | undefined> {
    const db = await openDb()
    try {
      const entry = await new Promise<StoredEntry | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).get(keyFor(request))
        req.onsuccess = () => resolve(req.result as StoredEntry | undefined)
        req.onerror = () => reject(req.error ?? new Error('Failed to read from local model cache'))
      })
      if (!entry) return undefined
      return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers: entry.headers })
    } finally {
      db.close()
    }
  },

  async put(request: string | Request, response: Response): Promise<void> {
    const entry: StoredEntry = {
      url: keyFor(request),
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body: await response.arrayBuffer(),
    }
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).put(entry)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('Failed to write to local model cache'))
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
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).count()
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
