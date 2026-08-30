import type { ClaudeModel } from '@/types/campaign'
import { getClaudeApiKey } from './claudeKey'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
// Enough for a narrative paragraph or two plus the trailing ```state JSON block without
// truncating mid-reply — a truncated block would fail parseTurnReply downstream anyway, and the
// code turns `stop_reason: 'max_tokens'` into a hard error rather than retrying.
const MAX_TOKENS = 8192

interface ContentBlock {
  type: string
  text?: string
}

interface MessagesResponse {
  content: ContentBlock[]
  stop_reason: string
  error?: { message?: string }
}

/**
 * Calls the Claude API directly from the browser — no backend, matching this app's
 * no-server design (DESIGN.md §11). Requires `anthropic-dangerous-direct-browser-access`
 * (undocumented-but-real header, verified against Anthropic's SDK source) since the API
 * otherwise blocks cross-origin browser requests: the API key is visible in DevTools to
 * anyone with access to this browser, which is the accepted tradeoff of a bring-your-own-key
 * client-only app (see claudeKey.ts).
 */
export async function generateClaudeReply(prompt: string, model: ClaudeModel): Promise<string> {
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
    }),
  })

  const data = (await res.json().catch(() => null)) as MessagesResponse | null

  if (!res.ok) {
    const message = data?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`Claude API request failed: ${message}`)
  }
  if (!data) {
    throw new Error('Claude API returned an unreadable response.')
  }

  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined to respond to this prompt. Try rephrasing your action.')
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error("Claude's reply was cut off before finishing — try again.")
  }

  const text = data.content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('')
  if (!text.trim()) {
    throw new Error('Claude API returned no text content.')
  }
  return text
}
