import type { Page } from '@playwright/test'

/**
 * Mocks the Claude Messages API and records what was sent, so tests can assert on it directly.
 *
 * Unlike the other mocks in this directory, this isn't a `page.route` network interception:
 * claudeProvider.ts's `generateClaudeReply` (issue #29) always requests `"stream": true` and
 * parses the response as Server-Sent Events, and Playwright's `route.fulfill()` can only hand back
 * a complete, static body — there's no way to make a routed response arrive in genuinely separate
 * chunks over real time (confirmed empirically: a `route.fulfill`-served body of several hundred
 * KB still arrives at the page's `fetch()` as a single `ReadableStream` read, regardless of size).
 * That's fine for every test that only cares about the *final* applied turn, but not for asserting
 * that narrative text genuinely appears incrementally before the turn is applied — a real, timed
 * partial state has to exist for a test to observe it.
 *
 * So instead this replaces `window.fetch` itself for the Messages API's URL, via `addInitScript`
 * (same "fake a browser API the page calls" pattern `mocks/webSpeech.ts`/`mocks/mediaRecorder.ts`/
 * `mocks/kokoro.ts` already use for other browser globals) — everything else still goes through
 * the real `fetch`, so this coexists with `mocks/googleApi.ts`'s `page.route`-based interception
 * (a route handler sits below `fetch` in the browser's network stack, so it's untouched by this).
 * The replacement builds a real `ReadableStream` and enqueues one SSE event per chunk with a real
 * `setTimeout` between them when `chunkDelayMs` is set — genuine wall-clock pacing a test can
 * observe by polling the DOM, not a simulation of it.
 *
 * `opts.reply` can still be a function of `(prompt, callIndex)` even though it has to run on the
 * Node side (closures, external state, etc. aren't things a string embedded in an init script can
 * carry into the browser) — the in-page fetch override calls back into Node for that decision via
 * `page.exposeFunction`, which also doubles as how `state.requests` gets populated: the override
 * never touches a real network request, so there's nothing for `page.route`'s own request-capture
 * to see.
 */

export interface ClaudeMockState {
  requests: { prompt: string; model: string }[]
}

export interface ClaudeMockOptions {
  /** Text returned as the reply's content — a function to vary the reply by call number
   * (e.g. an invalid first reply, a corrected second reply after a Retry). */
  reply?: string | ((prompt: string, callIndex: number) => string)
  status?: number
  stopReason?: string
  /** Artificial delay before the response starts arriving at all, so a test has a reliable window
   * to observe/interact with the "still generating" UI state instead of racing an otherwise-instant
   * mock response. */
  delayMs?: number
  /** Splits the reply text into this many separate `content_block_delta` SSE events instead of one.
   * Default 1 — every test that doesn't care about the streamed path (nearly all of them) gets a
   * single-event stream, functionally the same "whole reply at once" shape the API had before
   * streaming. Set this (with `chunkDelayMs`) to actually exercise incremental delivery. */
  chunkCount?: number
  /** Real milliseconds to wait between enqueuing successive chunks (only meaningful with
   * `chunkCount` > 1). Default 0 — all chunks enqueue back-to-back with no gap. */
  chunkDelayMs?: number
}

const DEFAULT_NARRATIVE = 'You step forward and the torchlight flickers against the old stone.'

export function defaultValidReply(narrative: string = DEFAULT_NARRATIVE): string {
  return `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {},
    summary_update: narrative,
    options: ['Look around', 'Move on'],
  })}\n\`\`\``
}

/** Playwright gives each test a fresh `Page`, so re-registering the exposed function per call
 * isn't normally needed — guarded anyway since `page.exposeFunction` throws if called twice with
 * the same name on the same page, and nothing here should hard-fail a test that (for whatever
 * reason) installs this mock more than once against one page. */
const exposedOnPage = new WeakSet<Page>()

export async function installClaudeApiMock(page: Page, opts: ClaudeMockOptions = {}): Promise<ClaudeMockState> {
  const state: ClaudeMockState = { requests: [] }
  let callIndex = 0

  if (!exposedOnPage.has(page)) {
    exposedOnPage.add(page)
    await page.exposeFunction(
      '__claudeMockDecide',
      (prompt: string, model: string): { status: number; errorMessage?: string; text?: string; stopReason?: string } => {
        state.requests.push({ prompt, model })
        const thisCall = callIndex
        callIndex += 1

        if (opts.status && opts.status !== 200) {
          return { status: opts.status, errorMessage: 'mocked failure' }
        }
        const text = typeof opts.reply === 'function' ? opts.reply(prompt, thisCall) : (opts.reply ?? defaultValidReply())
        return { status: 200, text, stopReason: opts.stopReason ?? 'end_turn' }
      },
    )
  }

  await page.addInitScript(
    ({ delayMs, chunkCount, chunkDelayMs, endpoint }) => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
        if (url !== endpoint) return originalFetch(input, init)

        const bodyText = typeof init?.body === 'string' ? init.body : ''
        const parsed = bodyText ? (JSON.parse(bodyText) as { model?: string; messages?: { content?: string }[] }) : {}
        const prompt = parsed.messages?.[0]?.content ?? ''
        const model = parsed.model ?? ''

        const decide = (
          window as unknown as {
            __claudeMockDecide: (
              prompt: string,
              model: string,
            ) => Promise<{ status: number; errorMessage?: string; text?: string; stopReason?: string }>
          }
        ).__claudeMockDecide
        const decision = await decide(prompt, model)

        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))

        if (decision.status !== 200) {
          return new Response(JSON.stringify({ error: { message: decision.errorMessage } }), {
            status: decision.status,
            headers: { 'content-type': 'application/json' },
          })
        }

        const text = decision.text ?? ''
        const count = Math.max(1, chunkCount)
        const pieces: string[] = []
        const base = Math.floor(text.length / count)
        let idx = 0
        for (let i = 0; i < count; i++) {
          const len = i === count - 1 ? text.length - idx : base
          pieces.push(text.slice(idx, idx + len))
          idx += len
        }

        const encoder = new TextEncoder()
        const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(sse('message_start', { type: 'message_start' }))
            controller.enqueue(
              sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
            )
            for (const piece of pieces) {
              if (chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs))
              controller.enqueue(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: piece },
                }),
              )
            }
            controller.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
            controller.enqueue(sse('message_delta', { type: 'message_delta', delta: { stop_reason: decision.stopReason } }))
            controller.enqueue(sse('message_stop', { type: 'message_stop' }))
            controller.close()
          },
        })

        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    },
    {
      delayMs: opts.delayMs ?? 0,
      chunkCount: opts.chunkCount ?? 1,
      chunkDelayMs: opts.chunkDelayMs ?? 0,
      endpoint: 'https://api.anthropic.com/v1/messages',
    },
  )

  return state
}
