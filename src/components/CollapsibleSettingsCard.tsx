import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface CollapsibleSettingsCardProps {
  title: string
  description: ReactNode
  /** Only read on mount — this component owns its own open/closed state after that, so a parent
   * re-render (e.g. `settings` finishing its Drive load) can't yank a card the player just
   * expanded/collapsed back to some newly-recomputed default. Callers that need the *initial*
   * open state to reflect data that loads asynchronously (this card's two Settings.tsx callers
   * both do — see that file) should key this component so it remounts (and re-reads the new
   * default) exactly once when that data first arrives — but key on a value that only changes
   * when there's genuinely new initial data to reflect (e.g. "has the async load completed yet"),
   * **not** on `defaultOpen` itself or anything it's derived from. A prior version of this
   * component's callers did exactly that and it silently discarded a player's manual toggle
   * every time they edited the live setting `defaultOpen` was computed from, since editing it
   * changed the key too, forcing an unwanted remount (found in independent review of #76). */
  defaultOpen: boolean
  children: ReactNode
  /** Stamped onto the card (`{testId}`) and its disclosure trigger (`{testId}-toggle`) as
   * `data-testid`s for Playwright — the card's own content already carries its own testids
   * (e.g. `local-model-row-*`) so this is only needed for the disclosure chrome itself. */
  testId?: string
}

/**
 * A Card whose body is collapsed behind a disclosure toggle (issue #22's restructure) — used for
 * the "Local AI models" and "Kokoro voice model" download-management cards, which are unconditionally
 * useful account-wide but irrelevant clutter for a player who has never touched local/on-device
 * mode. The title stays visible either way (so the card is still discoverable/searchable-by-eye
 * and existing "is this section present" assertions keep working); only the body — the actual
 * catalog/download UI — collapses.
 *
 * Phase 2 tier 3 (issue #95) dropped Radix's `Collapsible` primitive entirely rather than
 * reaching for daisyUI's `.collapse`/native `<details>` — this component already owned its own
 * `open` boolean and hand-rolled its own visual trigger (a plain `<button>` with a
 * chevron rotated via React state, not any Radix `data-state` attribute), and a repo-wide grep
 * turned up no CSS anywhere keyed to Radix's `data-state`/height-animation machinery for this
 * component, so there was no behavior actually worth preserving through a wrapper — same call
 * tier 2 made when `progress.tsx` dropped `Progress` (see DESIGN.md §3). `aria-expanded` and
 * `aria-controls`/`id` are set by hand so screen-reader semantics don't regress, and the content
 * is a genuine conditional render (unmounted while closed, not just visually hidden) — matching
 * both Radix's own prior behavior and `CollapsibleSettingsCard.stories.tsx`'s existing
 * `not.toBeInTheDocument()` expectations.
 */
export function CollapsibleSettingsCard({
  title,
  description,
  defaultOpen,
  children,
  testId,
}: CollapsibleSettingsCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()

  return (
    <Card data-testid={testId}>
      <button
        type="button"
        data-testid={testId ? `${testId}-toggle` : undefined}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        className="group/collapsible-trigger flex w-full items-start gap-2 px-(--card-spacing) text-left"
      >
        <ChevronRight
          className={cn(
            'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <div className="flex flex-1 flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </button>
      {open && (
        <CardContent id={contentId} className="flex flex-col gap-4 pt-4">
          {children}
        </CardContent>
      )}
    </Card>
  )
}
