/** Turns a turn's offered options into a single spoken line, chained onto the end of narrating
 * that turn (Play.tsx's useTtsPlayback) so audio-only play doesn't go silent right at the
 * decision point. Exported for tests. */
export function describeOptionsForSpeech(options: string[]): string {
  if (options.length === 0) return ''
  return `Your options: ${options.map((opt, i) => `${i + 1}. ${opt}.`).join(' ')}`
}
