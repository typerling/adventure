/**
 * Shared shape/formatting for on-device model download progress. Both on-device models report
 * progress the same way (@huggingface/transformers' `progress_callback`), so the local Gemma text
 * model (src/lib/ai/localModel.ts) and the Kokoro voice model (src/lib/voice/kokoroTts.ts) format
 * their status lines identically — only the model's name differs.
 */

export interface ModelDownloadProgress {
  status: string
  file?: string
  progress?: number
  /** Bytes loaded/total, summed across every file tracked by the aggregator this event came
   * through (see createProgressAggregator) — present on 'progress' events once at least one file
   * has reported a byte count. */
  loaded?: number
  total?: number
  /** True once any file in this load resumed a previously-interrupted download rather than
   * starting from byte 0 — see localModelResumableFetch.ts's `onResume`. Distinguishes "this
   * jumped ahead because it's picking up where it left off" from "this is just a fast network." */
  resuming?: boolean
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.max(1, Math.round(mb))} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function describeModelDownloadProgress(p: ModelDownloadProgress, label: string): string {
  if (p.status === 'progress' && typeof p.progress === 'number') {
    const size =
      typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0
        ? ` (${formatBytes(p.loaded)} / ${formatBytes(p.total)})`
        : ''
    const verb = p.resuming ? 'Resuming download of' : 'Downloading'
    return `${verb} ${label}${size}… ${Math.round(p.progress)}%`
  }
  if (p.status === 'done') return `Preparing ${label}…`
  return `Fetching ${label}…`
}

/**
 * Wraps a `progress_callback` so several `from_pretrained()` calls sharing it (this app always
 * loads a processor/tokenizer alongside the model weights, as two concurrent calls) report one
 * combined, monotonic percentage instead of each file's own 0→100 restarting independently.
 *
 * Without this, a caller reading each raw 'progress' event's own `progress` field sees the small
 * tokenizer/config files finish instantly at 100%, then watches the number drop back down when
 * the multi-hundred-MB model shard starts its own 0→100 run — a percentage that has no relation
 * to actual bytes remaining, let alone time left. `@huggingface/transformers` v4's model loader
 * separately emits its own aggregate `progress_total` (summed across just *that one*
 * `from_pretrained` call, using file sizes it fetches upfront via HEAD requests, which is also why
 * it can't see files from a sibling call) — dropped here in favor of computing one aggregate
 * ourselves from raw per-file byte counts, since that spans every call sharing this instance and
 * (unlike the library's version) works identically for kokoro-js's older transformers copy, which
 * doesn't emit `progress_total` at all.
 *
 * This also happens to answer "is this downloading from scratch or resuming/cached?" honestly
 * without any extra bookkeeping: a file served from this app's IndexedDB cache (localModelCache.ts)
 * or resumed partway through (localModelResumableFetch.ts) still reports real 'progress' events
 * with real byte counts — just arriving far faster than a live network fetch — so the aggregate
 * percentage jumps ahead for whatever's already on disk and only crawls for what's genuinely being
 * downloaded, rather than replaying a full 0→100 for bytes that didn't need fetching.
 */
export function createProgressAggregator(
  onProgress: (p: ModelDownloadProgress) => void,
): (p: ModelDownloadProgress) => void {
  const files = new Map<string, { loaded: number; total: number; resuming: boolean }>()
  return (p) => {
    if (p.status === 'progress_total') return
    if (p.status === 'progress' && p.file && typeof p.loaded === 'number' && typeof p.total === 'number') {
      files.set(p.file, { loaded: p.loaded, total: p.total, resuming: !!p.resuming })
      let loaded = 0
      let total = 0
      let resuming = false
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
        resuming ||= f.resuming
      }
      onProgress({
        status: 'progress',
        file: p.file,
        loaded,
        total,
        resuming,
        progress: total > 0 ? (loaded / total) * 100 : 0,
      })
      return
    }
    onProgress(p)
  }
}
