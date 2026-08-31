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
 * parseSpokenSegments before stripMarkdownToPlainText is applied per-piece.
 *
 * `endsAtRealBreak` distinguishes two reasons a span can end where it does: a genuine paragraph
 * break (or the end of the block's text) versus being cut short by an upcoming speaker token —
 * see buildSpokenSegments' doc comment for why that distinction is load-bearing (found in
 * independent review of the first version of this feature): stripMarkdownToPlainText's "append a
 * period if this paragraph doesn't already end in one" rule is only correct when the text handed
 * to it genuinely IS a whole paragraph. A span like "muttering " that only ends where it does
 * because a `{{v:Guard}}` token happens to start right there is not a complete paragraph — forcing
 * terminal punctuation on it fabricates a full stop mid-sentence. `false` here means "this span's
 * last internal chunk was truncated by a token, not a real break — don't force punctuation there." */
interface RawSpan {
  text: string
  speaker: string | null
  endsAtRealBreak: boolean
}

/** A blank line (two-or-more newlines) — the same paragraph-break definition
 * stripMarkdownToPlainText already uses below, reused here so "ends at the paragraph break" means
 * the same thing in both places. Never given the `g` flag: it's only ever used via a single
 * `.exec()` per call, and a stateful `lastIndex` would corrupt the next call. */
const PARAGRAPH_BREAK_RE = /\n{2,}/
/** Whether a chunk ends with a run of blank lines (with only trailing whitespace after it, if
 * any) — i.e. it genuinely reaches a paragraph boundary rather than being cut off mid-paragraph
 * by an upcoming speaker token. Anchored, unlike PARAGRAPH_BREAK_RE, which only needs to find a
 * break *somewhere* for the force-close check above. */
const ENDS_AT_BREAK_RE = /\n{2,}\s*$/

/** Merges consecutive same-speaker spans together (e.g. a stray `{{/v}}` with nothing open just
 * disappears rather than leaving a pointless zero-width split in otherwise-continuous narration).
 * Order-preserving, and safe on an already-minimal list (a single span merges with nothing). */
function mergeAdjacentSpans<T extends { text: string; speaker: string | null }>(spans: T[]): T[] {
  const merged: T[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && last.speaker === span.speaker) {
      // Any field beyond text/speaker (e.g. RawSpan's endsAtRealBreak) takes the *later* span's
      // value, not the earlier one's — a merged run's properties describe where it actually ends
      // now, which is wherever the last constituent span ended, not the first.
      merged[merged.length - 1] = { ...last, ...span, text: last.text + span.text }
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
  // force-close rule above when a speaker is currently open. `isFinalChunk` is true only for the
  // trailing slice after the last token (or the whole text, if there are no tokens at all) — i.e.
  // nothing else follows in this block, so ending there is never an artificial token-boundary cut.
  const pushBetween = (chunk: string, speaker: string | null, isFinalChunk: boolean) => {
    if (speaker !== null) {
      const breakMatch = PARAGRAPH_BREAK_RE.exec(chunk)
      if (breakMatch) {
        const spoken = chunk.slice(0, breakMatch.index)
        const rest = chunk.slice(breakMatch.index + breakMatch[0].length)
        // `spoken` ends exactly at the break that forced this close — always a real break.
        if (spoken) spans.push({ text: spoken, speaker, endsAtRealBreak: true })
        if (rest) {
          spans.push({ text: rest, speaker: null, endsAtRealBreak: isFinalChunk || ENDS_AT_BREAK_RE.test(rest) })
        }
        return
      }
    }
    if (chunk) {
      spans.push({ text: chunk, speaker, endsAtRealBreak: isFinalChunk || ENDS_AT_BREAK_RE.test(chunk) })
    }
  }

  SPEAKER_TOKEN_RE.lastIndex = 0
  while ((match = SPEAKER_TOKEN_RE.exec(text))) {
    pushBetween(text.slice(cursor, match.index), currentSpeaker, false)
    cursor = match.index + match[0].length
    const isOpen = match[1] !== undefined
    currentSpeaker = isOpen ? match[1].trim() : null
  }
  pushBetween(text.slice(cursor), currentSpeaker, true)

  return mergeAdjacentSpans(spans)
}

/** Strips common markdown markup down to plain text — a TTS provider reading literal asterisks/
 * hashes/brackets would sound broken. Not a full markdown parser; just enough to handle what the
 * AI is realistically going to produce (headers, emphasis, lists, links, code, blockquotes). Also
 * strips any speaker token (issue #96) that reaches it directly — normal callers never hand it
 * one (token matches are already excluded before this runs), but this stays a second, defensive
 * line so no other/future caller can leak the literal `{{v:...}}`/`{{/v}}` markup into spoken
 * text. Shared by stripMarkdownToPlainText (below) and buildSpokenSegments' per-span path, which
 * needs the markup stripped without the paragraph-level punctuation step that follows it there —
 * see normalizeSpokenParagraph and buildSpokenSegments' doc comment for why those are separate. */
function stripMarkdownMarkup(text: string): string {
  return stripSpeakerTokens(text)
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
}

/** Terminal punctuation, optionally followed by a closing quote/bracket — so a paragraph/span
 * ending in reported or quoted dialogue (`she says, "Come with me."`) is recognized as already
 * complete instead of getting a redundant period appended after the closing mark. Pre-existing
 * gap in the original (pre-issue-#96) stripMarkdownToPlainText, fixed here rather than left in
 * place: the plain `/[.!?]$/` check only ever looked at the literal last character, so any
 * quote-terminated paragraph — tokens or not — already produced a doubled `.".` before this. */
const TERMINAL_PUNCTUATION_RE = /[.!?]["'”’)\]]*$/

/** Normalizes one already-markup-stripped paragraph-shaped chunk into its final spoken form:
 * collapses internal newlines/whitespace and trims, then — only when `forceTerminalPunctuation`
 * is true — appends a period if the chunk doesn't already end in terminal punctuation, the same
 * "paragraph breaks become a pause" rule stripMarkdownToPlainText has always applied, just
 * factored out so it can be applied selectively (see buildSpokenSegments). Forcing this on a chunk
 * that ISN'T actually a whole paragraph — one that only ends where it does because a speaker token
 * starts right there — would fabricate a full stop mid-sentence, which is exactly the regression
 * independent review caught in this feature's first version. */
function normalizeSpokenParagraph(text: string, forceTerminalPunctuation: boolean): string {
  const collapsed = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
  if (!collapsed || !forceTerminalPunctuation) return collapsed
  return TERMINAL_PUNCTUATION_RE.test(collapsed) ? collapsed : `${collapsed}.`
}

/** Strips common markdown markup down to plain text, for speaking a prose block aloud. See
 * stripMarkdownMarkup for the markup-stripping rules this applies. */
export function stripMarkdownToPlainText(markdown: string): string {
  // Paragraph breaks become a pause (a period) — but only where the paragraph doesn't already
  // end in terminal punctuation, or a TTS provider reads an audible-if-subtle double stop
  // ("rhythm.. An altar" instead of "rhythm. An altar"). Always forced here: stripMarkdownToPlainText
  // is only ever given a genuinely complete block/paragraph, never a token-truncated fragment.
  return stripMarkdownMarkup(markdown)
    .split(/\n{2,}/)
    .map((paragraph) => normalizeSpokenParagraph(paragraph, true))
    .filter((paragraph) => paragraph.length > 0)
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
    // Built per-block, then merged, so a multi-paragraph block with zero tokens collapses back
    // into a single segment — see the merge step below for why that's not just a nicety.
    const blockSegments: SpokenSegment[] = []
    for (const span of parseSpokenSegments(block.markdown)) {
      // A span's raw text can itself contain more than one real paragraph (e.g. two narration
      // paragraphs with no token between them, still one RawSpan) — split those out here so each
      // gets its own terminal-punctuation treatment, same as stripMarkdownToPlainText would if
      // given this span's text as a whole block. Only the span's *last* internal chunk needs
      // `endsAtRealBreak` to decide whether forcing punctuation is safe; every earlier internal
      // chunk ends at a `\n{2,}` by construction (that's what split just found), so it's always a
      // genuine paragraph end regardless of why the span itself ends where it does.
      const chunks = stripMarkdownMarkup(span.text).split(/\n{2,}/)
      chunks.forEach((chunk, i) => {
        const isLastChunk = i === chunks.length - 1
        const text = normalizeSpokenParagraph(chunk, !isLastChunk || span.endsAtRealBreak)
        if (text) blockSegments.push({ text, speaker: span.speaker })
      })
    }
    // Re-joins adjacent same-speaker paragraph pieces with a space, mirroring
    // stripMarkdownToPlainText's own `.join(' ')` between paragraphs — without this, a
    // multi-paragraph, zero-token block would come out as several separate `speaker: null`
    // segments instead of the single one this function's own doc comment (and
    // stripMarkdownToPlainText's identical behavior) promises. Plain string concatenation, not
    // mergeAdjacentSpans' no-separator append: these pieces came from *different* paragraphs, so
    // the space stripMarkdownToPlainText would have joined them with has to be put back.
    let last: SpokenSegment | undefined
    for (const segment of blockSegments) {
      if (last && last.speaker === segment.speaker) {
        last.text = `${last.text} ${segment.text}`
      } else {
        last = { ...segment }
        segments.push(last)
      }
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

/** Every distinct non-null speaker named across a turn's narrative (issue #98, epic #36's voice-
 * casting groundwork) — real `{{v:Name}}` tokens if present, else the same heuristic fallback
 * `attributeSpeakersHeuristically` uses for a weaker backend's untagged dialogue. This is what
 * `applyDelta.ts` uses to decide which known NPCs need a deterministic fallback `voiceId` this
 * turn: a character who never speaks doesn't need a voice cast for them yet, no matter how much
 * profile detail the AI wrote for them. Built from the whole raw narrative directly (not through
 * `splitNarrativeIntoBlocks`) since speaker attribution has nothing to do with where the
 * `{{options}}` token falls — a plain single prose block is exactly what `buildSpokenSegments`
 * needs. */
export function extractSpeakingNames(narrative: string, knownNames: string[]): Set<string> {
  const segments = buildSpokenSegments([{ type: 'prose', markdown: narrative }])
  const attributed = attributeSpeakersHeuristically(segments, knownNames)
  const names = new Set<string>()
  for (const segment of attributed) {
    if (segment.speaker) names.add(segment.speaker)
  }
  return names
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
