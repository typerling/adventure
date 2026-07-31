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
}

export function describeModelDownloadProgress(p: ModelDownloadProgress, label: string): string {
  if (p.status === 'progress' && typeof p.progress === 'number') {
    return `Downloading ${label}${p.file ? ` (${p.file})` : ''}… ${Math.round(p.progress)}%`
  }
  if (p.status === 'done') return `Preparing ${label}…`
  return `Fetching ${label}…`
}
