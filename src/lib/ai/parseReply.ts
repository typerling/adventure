import type { ParsedTurnReply, StateDelta, TurnOption } from '@/types/turn'

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
  const options = parseOptions(obj.options)
  const summary_update = typeof obj.summary_update === 'string' ? obj.summary_update : undefined

  if (!narrative) {
    return { ok: false, error: 'No narrative text found before the ```state block.', raw }
  }

  return { ok: true, reply: { narrative, state_delta, summary_update, options } }
}

/** Normalizes `options` to the current `{label, manus?}[]` shape. Also accepts the legacy plain
 * `string[]` shape (upconverting each string to `{label: s, manus: s}`) so a manual-mode paste
 * from a chat UI that hasn't picked up the new contract instructions yet doesn't hard-fail. */
function parseOptions(raw: unknown): TurnOption[] {
  if (!Array.isArray(raw)) return []
  const options: TurnOption[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      options.push({ label: entry, manus: entry })
    } else if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).label === 'string') {
      const label = (entry as Record<string, unknown>).label as string
      const manusRaw = (entry as Record<string, unknown>).manus
      options.push({ label, manus: typeof manusRaw === 'string' ? manusRaw : undefined })
    }
  }
  return options
}
