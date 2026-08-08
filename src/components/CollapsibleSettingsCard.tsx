import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
 */
export function CollapsibleSettingsCard({
  title,
  description,
  defaultOpen,
  children,
  testId,
}: CollapsibleSettingsCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Card data-testid={testId}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid={testId ? `${testId}-toggle` : undefined}
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
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-4 pt-4">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
