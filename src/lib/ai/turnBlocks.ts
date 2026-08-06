import type { TurnBlock, TurnOption } from '@/types/turn'

/** The token the AI is instructed (contract.ts) to place in the narrative at the point the
 * options should render inline. Not hardcoded to appear last — see splitNarrativeIntoBlocks. */
const OPTIONS_TOKEN = '{{options}}'

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

/** Strips common markdown markup down to plain text, for speaking a prose block aloud — a TTS
 * provider reading literal asterisks/hashes/brackets would sound broken. Not a full markdown
 * parser; just enough to handle what the AI is realistically going to produce (headers, emphasis,
 * lists, links, code, blockquotes). */
export function stripMarkdownToPlainText(markdown: string): string {
  const withoutMarkup = markdown
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

/** Concatenates every block's spoken form in sequence into one script for a TTS provider — so a
 * listener hears the prose, then the options read aloud in order, satisfying voice-only play
 * (picking an option by speaking it back). */
export function buildSpokenScript(blocks: TurnBlock[]): string {
  return blocks
    .map(blockToSpokenText)
    .filter((text) => text.length > 0)
    .join(' ')
}
