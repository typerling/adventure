import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { ChevronRight, Compass, Feather, Footprints, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock } from '@/types/turn'

/** Options are arbitrary AI-generated strings with no inherent icon/color meaning — these just
 * cycle to give the choice list the same varied, illustrated-card look as a fixed icon per option
 * would, without pretending to understand what each option is about. */
const OPTION_ICONS = [Footprints, Compass, Feather, Sparkles]
const OPTION_COLORS = [
  'bg-primary text-primary-foreground',
  'bg-secondary text-secondary-foreground',
  'bg-accent text-accent-foreground',
]

/** Maps markdown elements to this app's narrative typography (font-serif body text, matching the
 * plain `<p>` this replaces). Deliberately only the "safe" elements react-markdown produces by
 * default — no `rehype-raw`, since this renders unsanitized AI output directly and that safety
 * property is load-bearing (see contract.ts / DESIGN.md §5). */
const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="font-serif text-base leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="font-heading text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="font-heading text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="font-heading text-base font-semibold">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 font-serif text-base leading-relaxed">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 font-serif text-base leading-relaxed">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 font-serif text-base leading-relaxed text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
}

function ProseBlock({ markdown }: { markdown: string }) {
  return (
    <div className="flex flex-col gap-3">
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{markdown}</ReactMarkdown>
    </div>
  )
}

interface OptionsBlockViewProps {
  items: { label: string; manus: string }[]
  onSelect: (label: string) => void
  disabled?: boolean
}

function OptionsBlockView({ items, onSelect, disabled }: OptionsBlockViewProps) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((opt, i) => {
        const Icon = OPTION_ICONS[i % OPTION_ICONS.length]
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => onSelect(opt.label)}
            disabled={disabled}
            className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
          >
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-xl',
                OPTION_COLORS[i % OPTION_COLORS.length],
              )}
            >
              <Icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1 font-heading text-base leading-snug text-foreground">{opt.label}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        )
      })}
    </div>
  )
}

interface RendererContext {
  onSelectOption?: (label: string) => void
  disabled?: boolean
}

/** A small per-block-type renderer registry — the actual extensibility point this ticket exists
 * for. A future block type (a dice-roll result, an item card, ...) registers a case here and adds
 * itself to the `TurnBlock` union in src/types/turn.ts; nothing else in this component changes. */
const BLOCK_RENDERERS: {
  [K in TurnBlock['type']]: (block: Extract<TurnBlock, { type: K }>, ctx: RendererContext, key: number) => ReactNode
} = {
  prose: (block, _ctx, key) => <ProseBlock key={key} markdown={block.markdown} />,
  // Options only render as interactive when a handler is supplied — omitted for historical
  // (already-acted-on) turns, so options never reappear for past turns, matching today's
  // behavior where only the latest turn's options are ever selectable.
  options: (block, ctx, key) =>
    ctx.onSelectOption ? (
      <OptionsBlockView key={key} items={block.items} onSelect={ctx.onSelectOption} disabled={ctx.disabled} />
    ) : null,
}

export interface TurnContentProps {
  /** The sequence of prose/options/... blocks to render, in order — see `turnBlocks.ts`. */
  blocks: TurnBlock[]
  /** Handles a click on an option's label. Omit for read-only/historical turns. */
  onSelectOption?: (label: string) => void
  /** Disables option buttons while a turn is generating, same as any other in-flight action. */
  disabled?: boolean
}

/** Renders one turn's content — narrative markdown and, inline at the position the AI placed the
 * `{{options}}` token (or appended at the end as a fallback — see `splitNarrativeIntoBlocks`),
 * the turn's options. This is what replaced the old flat `<p>{narrative}</p>` plus a separate
 * fixed options panel: options now scroll up with the rest of the text instead of sitting pinned
 * below it. See `src/lib/ai/contract.ts` for the AI-facing format this all comes from. */
export function TurnContent({ blocks, onSelectOption, disabled }: TurnContentProps) {
  const ctx: RendererContext = { onSelectOption, disabled }
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => {
        const renderer = BLOCK_RENDERERS[block.type] as (
          b: TurnBlock,
          c: RendererContext,
          k: number,
        ) => ReactNode
        return renderer(block, ctx, i)
      })}
    </div>
  )
}
