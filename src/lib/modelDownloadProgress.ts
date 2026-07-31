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
  /** Present on `progress_total` events: `@huggingface/transformers` v4's own per-file breakdown
   * for the from_pretrained() call that emitted it, with sizes known upfront (via a HEAD-request
   * pass) rather than only once each file's own download starts. See createProgressAggregator. */
  files?: Record<string, { loaded: number; total: number }>
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.max(1, Math.round(mb))} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** Fixed, single-shape template — deliberately not varying its wording or word order by status
 * details (e.g. a "resuming" vs "downloading" verb), since that was making the label's length and
 * layout shift on every update, reading as jittery even once the underlying percentage was steady. */
export function describeModelDownloadProgress(p: ModelDownloadProgress, label: string): string {
  if (p.status === 'progress' && typeof p.progress === 'number') {
    const size =
      typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0
        ? ` (${formatBytes(p.loaded)}/${formatBytes(p.total)})`
        : ''
    return `Downloading ${label} - ${Math.round(p.progress)}%${size}`
  }
  if (p.status === 'done') return `Preparing ${label}…`
  return `Fetching ${label}…`
}

/**
 * Wraps a `progress_callback` so several `from_pretrained()` calls sharing it (this app always
 * loads a processor/tokenizer alongside the model weights, as two concurrent calls) report one
 * combined percentage instead of each file's own 0→100 restarting independently.
 *
 * Without this, a caller reading each raw 'progress' event's own `progress` field sees the small
 * tokenizer/config files finish instantly at 100%, then watches the number drop back down when
 * the multi-hundred-MB model shard starts its own 0→100 run — a percentage that has no relation
 * to actual bytes remaining, let alone time left.
 *
 * `@huggingface/transformers` v4's model loader (unlike kokoro-js's older transformers copy,
 * which has no equivalent) separately emits its own `progress_total` aggregate for *that one*
 * `from_pretrained` call, with every file's size known upfront via a HEAD-request pass — its
 * `files` field lists exactly which filenames that covers. Using that (rather than only summing
 * each file's own raw 'progress' events, whose `total` isn't known until that file's download
 * actually starts) matters: without it, this aggregator would only learn a several-hundred-MB
 * shard's size once its first byte arrives, so the percentage would climb toward 100% on the tiny
 * files finishing first, then cliff back down the instant the shard's real size joins the
 * denominator — reproducing the exact bug this exists to fix, just one step later. So a
 * progress_total event's numbers are taken as authoritative for its own files, and only files
 * *outside* that set (e.g. the processor/tokenizer, which has no progress_total of its own) are
 * tracked from raw per-file byte counts, summed in on top.
 *
 * This also happens to answer "is this downloading from scratch or resuming/cached?" honestly
 * without any extra bookkeeping: a file served from this app's IndexedDB cache (localModelCache.ts)
 * or resumed partway through (localModelResumableFetch.ts's replay of already-saved blocks) still
 * reports real 'progress' events with real byte counts — just arriving far faster than a live
 * network fetch — so the aggregate percentage jumps ahead for whatever's already on disk and only
 * crawls for what's genuinely being downloaded, rather than replaying a full 0→100 for bytes that
 * didn't need fetching.
 */
export function createProgressAggregator(
  onProgress: (p: ModelDownloadProgress) => void,
): (p: ModelDownloadProgress) => void {
  const files = new Map<string, { loaded: number; total: number }>()
  // Populated from the latest `progress_total` event, if any — see doc comment above.
  let totalFiles = new Set<string>()
  let totalLoaded = 0
  let totalTotal = 0

  return (p) => {
    if (p.status === 'progress_total' && typeof p.loaded === 'number' && typeof p.total === 'number') {
      totalFiles = new Set(Object.keys(p.files ?? {}))
      totalLoaded = p.loaded
      totalTotal = p.total
      // The raw 'progress' event for the same file always follows immediately (see
      // @huggingface/transformers' DefaultProgressCallback), which is what actually emits —
      // this just updates the authoritative totals it'll read.
      return
    }
    if (p.status === 'progress' && p.file && typeof p.loaded === 'number' && typeof p.total === 'number') {
      // Only track this file ourselves if it isn't already covered by a progress_total group —
      // otherwise its bytes would be counted twice.
      if (!totalFiles.has(p.file)) files.set(p.file, { loaded: p.loaded, total: p.total })
      let loaded = totalLoaded
      let total = totalTotal
      for (const [file, f] of files) {
        if (totalFiles.has(file)) continue
        loaded += f.loaded
        total += f.total
      }
      onProgress({
        status: 'progress',
        file: p.file,
        loaded,
        total,
        progress: total > 0 ? Math.min(100, (loaded / total) * 100) : 0,
      })
      return
    }
    onProgress(p)
  }
}
