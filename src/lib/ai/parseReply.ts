import type { ParsedTurnReply, StateDelta } from '@/types/turn'

export type ParseResult =
  | { ok: true; reply: ParsedTurnReply }
  | { ok: false; error: string; raw: string }

const FENCE_RE = /```(?:state|json)?\s*\n([\s\S]*?)\n?```/g

/** Extracts the narrative prose + trailing ```state fenced JSON block from a pasted (or
 * API-returned) AI reply. Tolerant of ```json fences and stray whitespace/trailing junk. */
export function parseTurnReply(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Reply is empty.', raw }

  const matches = [...trimmed.matchAll(FENCE_RE)]
  if (matches.length === 0) {
    return {
      ok: false,
      error: 'No ```state block found at the end of the reply. Ask the AI to include one and re-paste.',
      raw,
    }
  }

  const last = matches[matches.length - 1]
  const narrative = trimmed.slice(0, last.index).trim()
  const jsonText = last[1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    return {
      ok: false,
      error: "The ```state block isn't valid JSON: " + (err instanceof Error ? err.message : String(err)),
      raw,
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'The ```state block must contain a JSON object.', raw }
  }

  const obj = parsed as Record<string, unknown>
  const state_delta = (obj.state_delta ?? {}) as StateDelta
  const options = Array.isArray(obj.options) ? obj.options.filter((o) => typeof o === 'string') : []
  const summary_update = typeof obj.summary_update === 'string' ? obj.summary_update : undefined

  if (!narrative) {
    return { ok: false, error: 'No narrative text found before the ```state block.', raw }
  }

  return { ok: true, reply: { narrative, state_delta, summary_update, options } }
}
