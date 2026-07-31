import type { Page, Route } from '@playwright/test'

/** Mocks the Claude Messages API and records what was sent, so tests can assert on it directly
 * (route handlers run in the Node/test process, same pattern as googleApi.ts). */

export interface ClaudeMockState {
  requests: { prompt: string; model: string }[]
}

export interface ClaudeMockOptions {
  /** Text returned as the reply's content — a function to vary the reply by call number
   * (e.g. an invalid first reply, a corrected second reply after a Retry). */
  reply?: string | ((prompt: string, callIndex: number) => string)
  status?: number
  stopReason?: string
  /** Artificial latency before fulfilling, so a test has a reliable window to observe/interact
   * with the "still generating" UI state instead of racing an otherwise-instant mock response. */
  delayMs?: number
}

const DEFAULT_NARRATIVE = 'You step forward and the torchlight flickers against the old stone.'

export function defaultValidReply(narrative: string = DEFAULT_NARRATIVE): string {
  return `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {},
    summary_update: narrative,
    options: ['Look around', 'Move on'],
  })}\n\`\`\``
}

export async function installClaudeApiMock(page: Page, opts: ClaudeMockOptions = {}): Promise<ClaudeMockState> {
  const state: ClaudeMockState = { requests: [] }
  let callIndex = 0

  await page.route('https://api.anthropic.com/v1/messages', async (route: Route) => {
    const request = route.request()
    const body = request.postDataJSON() as { model: string; messages: { role: string; content: string }[] }
    const prompt = body.messages[0]?.content ?? ''
    state.requests.push({ prompt, model: body.model })
    const thisCall = callIndex
    callIndex += 1

    if (opts.status && opts.status !== 200) {
      await route.fulfill({
        status: opts.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'mocked failure' } }),
      })
      return
    }

    const text = typeof opts.reply === 'function' ? opts.reply(prompt, thisCall) : (opts.reply ?? defaultValidReply())

    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: [{ type: 'text', text }],
        stop_reason: opts.stopReason ?? 'end_turn',
      }),
    })
  })

  return state
}
