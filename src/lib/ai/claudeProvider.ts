import type { ClaudeModel } from '@/types/campaign'
import { getClaudeApiKey } from './claudeKey'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
// Enough for a narrative paragraph or two plus the trailing ```state JSON block without
// truncating mid-reply — a truncated block would fail parseTurnReply downstream anyway, and the
// code turns `stop_reason: 'max_tokens'` into a hard error rather than retrying.
const MAX_TOKENS = 8192

interface NonStreamingErrorResponse {
  error?: { message?: string }
}

/** The handful of Messages API SSE event shapes this module actually reads. Streaming emits many
 * more event types (message_start, content_block_start/stop, ping, …) — anything not listed here
 * is safe to ignore entirely, since the only state this function accumulates is the concatenated
 * text of `text_delta` events and the final `stop_reason`. See Anthropic's streaming reference for
 * the full event set; this repo calls the API directly via `fetch` (no SDK — see this file's own
 * module doc comment below), so this is a deliberately minimal hand-rolled parser, not a generic
 * SSE client. */
interface ContentBlockDeltaEvent {
  delta?: { type?: string; text?: string }
}
interface MessageDeltaEvent {
  delta?: { stop_reason?: string | null }
}
interface StreamErrorEvent {
  error?: { message?: string }
}

export interface GenerateClaudeReplyOptions {
  /** Called with the accumulated narrative text so far as content_block_delta events arrive.
   * Mirrors localModel.ts's GenerateLocalReplyOptions.onToken shape/naming so Play.tsx can treat
   * both auto modes' live preview the same way. This is purely a live preview: the trailing
   * ```state fenced block can't be parsed/validated until the fence actually closes, so nothing
   * reads `onToken`'s text as anything other than raw display text — parseTurnReply/
   * validateStateDelta/applyStateDelta only ever run against this function's final, complete
   * return value, once the stream is fully done (see the loop below: nothing is returned, and no
   * caller is notified of completion, until the stream's `done` signal). */
  onToken?: (textSoFar: string) => void
}

/**
 * Calls the Claude API directly from the browser — no backend, matching this app's
 * no-server design (DESIGN.md §11). Requires `anthropic-dangerous-direct-browser-access`
 * (undocumented-but-real header, verified against Anthropic's SDK source) since the API
 * otherwise blocks cross-origin browser requests: the API key is visible in DevTools to
 * anyone with access to this browser, which is the accepted tradeoff of a bring-your-own-key
 * client-only app (same reasoning as ElevenLabs — see claudeKey.ts).
 *
 * Streams the reply (`"stream": true`) and parses the Messages API's Server-Sent Events itself —
 * this repo has no `@anthropic-ai/sdk` dependency (see CLAUDE.md's "no AI vendor SDK" rule), so
 * there's no client-provided stream helper to lean on; `readSseStream` below is a small, purpose-
 * built reader for exactly the event shapes this function needs (see its own doc comment). Only
 * `onToken` sees anything before the stream completes — this function's own return value (and so
 * the whole downstream parse/validate/apply pipeline in Play.tsx/useCampaign.ts) is unchanged from
 * the previous non-streaming implementation: the full accumulated text, once the stream is done.
 */
export async function generateClaudeReply(
  prompt: string,
  model: ClaudeModel,
  opts: GenerateClaudeReplyOptions = {},
): Promise<string> {
  const apiKey = getClaudeApiKey()
  if (!apiKey) {
    throw new Error('Add your Claude API key in Settings first.')
  }

  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      // Explicitly off. Omitting `thinking` leaves the 4.6+ models (including the default
      // claude-sonnet-5) on adaptive thinking, where thinking and visible output share the
      // max_tokens budget — so reasoning could eat the budget and truncate the reply. Following a
      // fixed output format doesn't benefit from thinking anyway, and skipping it is faster.
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  })

  // A request that fails before any streaming begins (bad key, rate limit, invalid model, …)
  // still comes back as a single ordinary JSON body, not SSE — same shape and same handling as
  // before streaming was added.
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as NonStreamingErrorResponse | null
    const message = data?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`Claude API request failed: ${message}`)
  }
  if (!res.body) {
    throw new Error('Claude API returned no readable stream.')
  }

  let text = ''
  let stopReason: string | null = null
  let streamErrorMessage: string | null = null

  for await (const { event, data } of readSseStream(res.body)) {
    switch (event) {
      case 'content_block_delta': {
        const payload = data as ContentBlockDeltaEvent
        if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
          text += payload.delta.text
          opts.onToken?.(text)
        }
        break
      }
      case 'message_delta': {
        const payload = data as MessageDeltaEvent
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        break
      }
      // Sent when something goes wrong *after* streaming has already started (e.g. an overloaded
      // upstream) — the one mid-stream event this function treats as fatal rather than ignoring.
      case 'error': {
        const payload = data as StreamErrorEvent
        streamErrorMessage = payload.error?.message ?? 'Unknown streaming error'
        break
      }
      // message_start/content_block_start/content_block_stop/message_stop/ping all carry nothing
      // this function needs — see the interface doc comment above.
    }
  }

  if (streamErrorMessage) {
    throw new Error(`Claude API request failed: ${streamErrorMessage}`)
  }
  if (stopReason === 'refusal') {
    throw new Error('Claude declined to respond to this prompt. Try rephrasing your action.')
  }
  if (stopReason === 'max_tokens') {
    throw new Error("Claude's reply was cut off before finishing — try again.")
  }
  if (!text.trim()) {
    throw new Error('Claude API returned no text content.')
  }
  return text
}

interface SseEvent {
  event: string
  data: unknown
}

/**
 * Minimal Server-Sent Events reader for the Messages API's streaming format: repeated
 * `event: <name>\ndata: <json>\n\n` blocks. Deliberately not a generic SSE client — no retry/id
 * field handling, no multi-line `data:` continuation — because that's everything the Messages API
 * itself actually sends (verified against Anthropic's streaming reference).
 *
 * `event:`/`data:` lines can arrive split across separate `reader.read()` chunks (there's no
 * guarantee a chunk boundary lines up with a line boundary, let alone an event boundary), so this
 * buffers undecoded text across reads and only emits a line once a full `\n` has actually arrived
 * — the `data:` line for one event is always preceded by that same event's `event:` line, so a
 * single `currentEvent` variable carried across reads (not reset per chunk) is enough to pair them
 * correctly regardless of where the chunk boundaries fall.
 */
async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  function* processLine(line: string): Generator<SseEvent> {
    if (line === '') {
      currentEvent = ''
      return
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim()
      return
    }
    if (line.startsWith('data:')) {
      const raw = line.slice('data:'.length).trim()
      if (!raw) return
      try {
        yield { event: currentEvent, data: JSON.parse(raw) as unknown }
      } catch {
        // A malformed data line is dropped rather than thrown — the caller only acts on event
        // types it recognizes anyway, and losing one unparseable line shouldn't abort a reply
        // that's otherwise streaming fine.
      }
    }
    // Any other line (e.g. a `:` comment/heartbeat line) is ignored.
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // The last element is whatever's after the final '\n' seen so far — either '' (buffer ended
      // exactly on a line boundary) or a genuinely incomplete line still waiting on more bytes.
      // Either way it isn't a complete line yet, so it goes back in the buffer rather than being
      // processed now.
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        yield* processLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
      }
    }
    // Flush anything left in the decoder/buffer once the stream itself is done, in case the final
    // event wasn't followed by a trailing newline.
    buffer += decoder.decode()
    if (buffer) {
      yield* processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
    }
  } finally {
    reader.releaseLock()
  }
}
