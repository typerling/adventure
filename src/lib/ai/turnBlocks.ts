import type { SpokenSegment, TurnBlock, TurnOption } from '@/types/turn'

/** The token the AI is instructed (contract.ts) to place in the narrative at the point the
 * options should render inline. Not hardcoded to appear last — see splitNarrativeIntoBlocks. */
const OPTIONS_TOKEN = '{{options}}'

/** Matches an opening `{{v:Name}}` speaker tag (issue #96) — `Name` is whatever's between the
 * colon and the closing braces, trimmed. Deliberately excludes `{`/`}` from the name so a
 * malformed/unclosed tag can't swallow an unrelated later token. */
const SPEAKER_OPEN_RE = /\{\{v:([^{}]*)\}\}/g
/** Matches the closing `{{/v}}` tag. A stray occurrence with no open tag in effect is simply
 * dropped (see parseSpokenSegments below) rather than treated as an error. */
const SPEAKER_CLOSE = '{{/v}}'
/** Combined scan for either tag, in document order — group 1 is present only for an opener. */
const SPEAKER_TOKEN_RE = /\{\{v:([^{}]*)\}\}|\{\{\/v\}\}/g

/** Strips every `{{v:Name}}`/`{{/v}}` speaker tag from raw text, leaving the dialogue text itself
 * untouched — this is the invisible half of the token contract (contract.ts): the player must
 * never see the literal markup. Safe to call on text with no tokens at all (the common case for
 * every turn logged before this shipped) — it's then a no-op. Deliberately just a substring
 * removal, not markdown-aware, so it can run before *or* after react-markdown parsing without
 * disturbing any markdown syntax the tags happen to sit next to (the tags use only `{`/`}`, which
 * commonmark never treats specially). */
export function stripSpeakerTokens(text: string): string {
  return text.replace(SPEAKER_OPEN_RE, '').replaceAll(SPEAKER_CLOSE, '')
}

/** Splits a turn's narrative on the first `{{options}}` occurrence into prose block(s) around it,
 * with one `options` block inserted at that position. If the token is absent (a weak backend, or
 * a manual-mode paste that hasn't picked up the new contract instructions), falls back to
 * appending the options block at the end — today's effective behavior, now the fallback path
 * instead of the only path. Empty prose segments (e.g. the token at the very start/end, or no
 * options at all) are dropped rather than rendered as blank paragraphs. */
export function splitNarrativeIntoBlocks(narrative: string, options: TurnOption[]): TurnBlock[] {
  const items = options.map((o) => ({ label: o.label, manus: o.manus ?? o.label }))

  const tokenIndex = narrative.indexOf(OPTIONS_TOKEN)
  if (tokenIndex === -1) {
    const blocks: TurnBlock[] = []
    const trimmed = narrative.trim()
    if (trimmed) blocks.push({ type: 'prose', markdown: trimmed })
    if (items.length > 0) blocks.push({ type: 'options', items })
    return blocks
  }

  const before = narrative.slice(0, tokenIndex).trim()
  // Only the first occurrence becomes the split point — a second (AI mistake, or a coincidental
  // repeat) would otherwise survive into the trailing prose as literal, visible `{{options}}`
  // text, since react-markdown has no reason to treat it specially. Strip any leftover
  // occurrences rather than rendering them.
  const after = narrative
    .slice(tokenIndex + OPTIONS_TOKEN.length)
    .replaceAll(OPTIONS_TOKEN, '')
    .trim()

  const blocks: TurnBlock[] = []
  if (before) blocks.push({ type: 'prose', markdown: before })
  // Still render the options block even with zero items, so the placeholder's position is
  // preserved and the prose either side stays split around it rather than silently rejoining —
  // an empty options block just renders nothing extra.
  blocks.push({ type: 'options', items })
  if (after) blocks.push({ type: 'prose', markdown: after })
  return blocks
}

/** A raw (still markdown-ish, not yet TTS-normalized) speaker-attributed slice, produced by
 * parseSpokenSegments before stripMarkdownToPlainText is applied per-piece. */
interface RawSpan {
  text: string
  speaker: string | null
}

/** A blank line (two-or-more newlines) — the same paragraph-break definition
 * stripMarkdownToPlainText already uses below, reused here so "ends at the paragraph break" means
 * the same thing in both places. Never given the `g` flag: it's only ever used via a single
 * `.exec()` per call, and a stateful `lastIndex` would corrupt the next call. */
const PARAGRAPH_BREAK_RE = /\n{2,}/

/** Merges consecutive same-speaker spans together (e.g. a stray `{{/v}}` with nothing open just
 * disappears rather than leaving a pointless zero-width split in otherwise-continuous narration).
 * Order-preserving, and safe on an already-minimal list (a single span merges with nothing). */
function mergeAdjacentSpans<T extends { text: string; speaker: string | null }>(spans: T[]): T[] {
  const merged: T[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && last.speaker === span.speaker) {
      last.text += span.text
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

/** Splits one prose block's raw markdown into speaker-attributed spans, tolerant of every
 * malformed-AI-output shape called out in issue #96:
 * - no tokens at all → exactly one span, `speaker: null`, spanning the whole text unchanged (this
 *   is what makes buildSpokenSegments provably behavior-neutral for every turn logged before this
 *   shipped — see its own doc comment).
 * - an unclosed `{{v:Name}}` — nothing ever closes it — is treated as implicitly closed at the
 *   next paragraph break (or end of text, if there isn't one) rather than bleeding the wrong
 *   speaker into all the narration that follows. A `{{/v}}` that shows up after that point is
 *   then just a stray closer (see below), harmless because there's nothing open left to close.
 * - a stray `{{/v}}` with no open tag in effect changes nothing (closing an already-closed span
 *   is a no-op) and leaves no trace in the output text.
 * - a token immediately followed by another open token ("nesting"), e.g.
 *   `{{v:A}}Hi {{v:B}}there{{/v}} friend{{/v}}` — this app has no notion of a speaker *stack*, so
 *   the second opener is treated as an ordinary speaker change: it implicitly closes A's span
 *   (whatever text came between the two openers stays A's) and starts B's. The trailing `{{/v}}`
 *   that would have closed A is then just a stray closer, per the rule above. Deliberately chosen
 *   over "treat the inner opener as literal text," since a model that forgets to close before
 *   switching speakers is a more realistic failure than one that means `{{v:` literally.
 * - a token landing mid-sentence splits the sentence at exactly that point — there's no
 *   sentence-boundary awareness here at all, spans are purely token-position-based, so this falls
 *   out for free rather than needing special-case handling.
 * Every span's `text` is built only from the slices *between* token matches, so no matched token
 * substring — open, close, or a leftover stray one — is ever included in any span's text. */
function parseSpokenSegments(text: string): RawSpan[] {
  const spans: RawSpan[] = []
  let cursor = 0
  let currentSpeaker: string | null = null
  let match: RegExpExecArray | null

  // Pushes the literal text between the previous token and this one, honoring the paragraph-break
  // force-close rule above when a speaker is currently open.
  const pushBetween = (chunk: string, speaker: string | null) => {
    if (speaker !== null) {
      const breakMatch = PARAGRAPH_BREAK_RE.exec(chunk)
      if (breakMatch) {
        const spoken = chunk.slice(0, breakMatch.index)
        const rest = chunk.slice(breakMatch.index + breakMatch[0].length)
        if (spoken) spans.push({ text: spoken, speaker })
        if (rest) spans.push({ text: rest, speaker: null })
        return
      }
    }
    if (chunk) spans.push({ text: chunk, speaker })
  }

  SPEAKER_TOKEN_RE.lastIndex = 0
  while ((match = SPEAKER_TOKEN_RE.exec(text))) {
    pushBetween(text.slice(cursor, match.index), currentSpeaker)
    cursor = match.index + match[0].length
    const isOpen = match[1] !== undefined
    currentSpeaker = isOpen ? match[1].trim() : null
  }
  pushBetween(text.slice(cursor), currentSpeaker)

  return mergeAdjacentSpans(spans)
}

/** Strips common markdown markup down to plain text, for speaking a prose block aloud — a TTS
 * provider reading literal asterisks/hashes/brackets would sound broken. Not a full markdown
 * parser; just enough to handle what the AI is realistically going to produce (headers, emphasis,
 * lists, links, code, blockquotes). Also strips any speaker token (issue #96) that reaches it
 * directly — the normal path (buildSpokenSegments) never hands it one, since token matches are
 * already excluded before this runs, but this stays a second, defensive line so no other/future
 * caller of this function can leak the literal `{{v:...}}`/`{{/v}}` markup into spoken text. */
export function stripMarkdownToPlainText(markdown: string): string {
  const withoutMarkup = stripSpeakerTokens(markdown)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // unordered list markers
    .replace(/^\s*\d+[.)]\s+/gm, '') // ordered list markers
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label text
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2') // bold+italic
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(\*|_)(.+?)\1/g, '$2') // italic
    .replace(/~~(.+?)~~/g, '$1') // strikethrough

  // Paragraph breaks become a pause (a period) — but only where the paragraph doesn't already
  // end in terminal punctuation, or a TTS provider reads an audible-if-subtle double stop
  // ("rhythm.. An altar" instead of "rhythm. An altar").
  return withoutMarkup
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => (/[.!?]$/.test(paragraph) ? paragraph : `${paragraph}.`))
    .join(' ')
    .trim()
}

/** Builds one block's spoken form — the text a TTS provider should read for it. Prose speaks its
 * markdown stripped to plain text; options speak a sentence naming each choice by its `manus`.
 * Extensible per block type, same spirit as TurnContent.tsx's renderer registry. */
export function blockToSpokenText(block: TurnBlock): string {
  switch (block.type) {
    case 'prose':
      return stripMarkdownToPlainText(block.markdown)
    case 'options': {
      if (block.items.length === 0) return ''
      const choices = block.items.map((i) => i.manus).join('. ')
      return `Your options: ${choices}.`
    }
  }
}

/** Builds the ordered, per-speaker spoken segments for a whole turn (issue #96) — the
 * finer-grained sibling of blockToSpokenText/buildSpokenScript that a later ticket (#98/#66) can
 * use to switch Kokoro voices at dialogue boundaries. This ticket ships no playback change at
 * all, so the property that actually matters here is behavior-neutrality: for any prose block
 * with zero `{{v:Name}}...{{/v}}` tokens in it — every turn logged before this shipped, and any
 * turn a weaker backend produces without picking up the new contract instructions — this returns
 * exactly one segment, `speaker: null`, whose `text` is byte-identical to
 * `stripMarkdownToPlainText(block.markdown)` (i.e. today's `blockToSpokenText` for that block).
 * That's not incidental: parseSpokenSegments returns a single whole-text span with no tokens
 * present, and stripMarkdownToPlainText is applied to that single span exactly as it would be to
 * the whole block. An `options` block is untouched by any of this — it always speaks as one
 * narration segment, same as today. */
export function buildSpokenSegments(blocks: TurnBlock[]): SpokenSegment[] {
  const segments: SpokenSegment[] = []
  for (const block of blocks) {
    if (block.type === 'options') {
      const text = blockToSpokenText(block)
      if (text) segments.push({ text, speaker: null })
      continue
    }
    for (const span of parseSpokenSegments(block.markdown)) {
      const text = stripMarkdownToPlainText(span.text)
      if (text) segments.push({ text, speaker: span.speaker })
    }
  }
  return segments
}

/** Concatenates every block's spoken form in sequence into one script for a TTS provider — so a
 * listener hears the prose, then the options read aloud in order, satisfying voice-only play
 * (picking an option by speaking it back). Implemented in terms of buildSpokenSegments so the two
 * can never drift apart — see its doc comment for the behavior-neutrality guarantee this relies
 * on: today's browser/ElevenLabs/Kokoro providers can't switch voices mid-turn, so this must stay
 * the single flattened script every provider reads, tokens or not. */
export function buildSpokenScript(blocks: TurnBlock[]): string {
  return buildSpokenSegments(blocks)
    .map((s) => s.text)
    .join(' ')
}

/**
 * Fallback speaker attribution for narrative with **no real `{{v:...}}` tokens at all** — manual-
 * mode pastes from a chat UI that hasn't picked up the new contract, or a weaker on-device local
 * model that won't reliably emit new-format tokens (issue #96). Matches each `"quoted"` span to
 * the nearest preceding mention of a name in `knownNames` (typically the current sheet snapshot's
 * NPC names plus the player character's name — see promptBuilder.ts's `namesFromSnapshot`).
 *
 * Deliberately a separate, opt-in pass rather than something `buildSpokenSegments` calls itself:
 * that function's whole contract is "zero tokens in ⇒ one null-speaker segment out" (see its doc
 * comment) — folding heuristic guessing into it would break that equivalence and make this
 * ticket's behavior non-neutral. Callers choose to run this on top when they want the weaker
 * partial-attribution experience instead.
 *
 * A no-op whenever the input already carries a real speaker anywhere (i.e. real tokens were
 * present) — tokens always win over the heuristic, never the other way around. A quote with no
 * preceding known name anywhere in its segment is left as narration (`speaker: null`) rather than
 * guessed at — this is a "when in doubt, don't" heuristic, not a confident one. */
export function attributeSpeakersHeuristically(segments: SpokenSegment[], knownNames: string[]): SpokenSegment[] {
  const names = knownNames.map((n) => n.trim()).filter(Boolean)
  if (names.length === 0) return segments
  if (segments.some((s) => s.speaker !== null)) return segments // real tokens win — no-op

  const result: SpokenSegment[] = []
  for (const segment of segments) {
    result.push(...attributeQuotesInText(segment.text, names))
  }
  return mergeAdjacentSpans(result)
}

const QUOTE_RE = /"([^"]*)"/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The nearest known name mentioned anywhere before `beforeIndex` in `text`, or null if none of
 * them appear there at all — "nearest" meaning latest by position, so of two named characters in
 * one paragraph, whichever was mentioned most recently before the quote wins. Matches whole words
 * only (`\b`), so e.g. "Mari" doesn't spuriously match inside "Marisol". */
function nearestPrecedingName(text: string, beforeIndex: number, names: string[]): string | null {
  let best: { name: string; index: number } | null = null
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index >= beforeIndex) break
      if (!best || m.index > best.index) best = { name, index: m.index }
    }
  }
  return best?.name ?? null
}

/** Splits one narration segment's text into narration/quoted spans, attributing each quote to
 * `nearestPrecedingName` — or leaving it as narration if no known name precedes it at all. */
function attributeQuotesInText(text: string, names: string[]): SpokenSegment[] {
  QUOTE_RE.lastIndex = 0
  const matches = [...text.matchAll(QUOTE_RE)]
  if (matches.length === 0) return [{ text, speaker: null }]

  const out: SpokenSegment[] = []
  let cursor = 0
  for (const m of matches) {
    const index = m.index ?? 0
    const before = text.slice(cursor, index)
    if (before) out.push({ text: before, speaker: null })
    out.push({ text: m[0], speaker: nearestPrecedingName(text, index, names) })
    cursor = index + m[0].length
  }
  const rest = text.slice(cursor)
  if (rest) out.push({ text: rest, speaker: null })
  return out
}
