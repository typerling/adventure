import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TurnContent } from '@/components/TurnContent'
import type { TurnBlock } from '@/types/turn'

export interface TurnPagerPage {
  /** The turn number — doubles as this page's stable React key. */
  turn: number
  /** Play.tsx's "Turn N — you: ..." line. Plain text, not a rendered slot — the shared top bar
   * (not each page) owns showing this, for whichever page is current, alongside the pager's own
   * back/forward/jump-to controls. Also doubles as the label for that turn's entry in the
   * jump-to-page dropdown. */
  turnLabel: string
  /** Rendered per-page (not in the shared top bar) — Play.tsx's per-turn play/stop TTS button.
   * Deliberately stays with its own page rather than following "current page" the way turnLabel
   * does: every page's button needs to exist at once regardless of which is current, since a
   * player can start one historical turn's playback and then start another's (see
   * media-session.spec.ts's "a second turn starting playback replaces (not stacks on) the first
   * turn's Media Session state" coverage). */
  actions?: ReactNode
  blocks: TurnBlock[]
  /** Present only for the live/last turn — historical pages render read-only, matching
   * TurnContent's existing behavior (see TurnContent.tsx's BLOCK_RENDERERS). */
  onSelectOption?: (label: string) => void
}

export interface TurnPagerProps {
  pages: TurnPagerPage[]
  /** Disables option buttons on the interactive page while a turn is generating. */
  disabled?: boolean
  /** Called whenever the current page index changes, including once on mount. Play.tsx uses this
   * to gate the free-text input to the newest page instead of duplicating this component's own
   * position tracking. */
  onCurrentIndexChange?: (index: number) => void
  className?: string
}

/** How much of a page must be visible for it to count as "current" — matches the
 * IntersectionObserver threshold below, so the two can't disagree about the same crossing. */
const CURRENT_PAGE_THRESHOLD = 0.5

/**
 * One turn = one horizontally-swipeable page (issue #26). Replaces the old continuously-scrolling
 * log: CSS scroll-snap (`snap-x snap-mandatory` on the container, `snap-start` per page) gives
 * native touch/trackpad swipe and momentum for free — no carousel dependency, consistent with
 * this app's thin-dependency preference (see CLAUDE.md). Arrow keys and the on-screen prev/next
 * buttons drive the *same* scroll container via `scrollTo`, so there's one source of truth for
 * "where am I," and an IntersectionObserver (not three independent mechanisms) is the single
 * source of truth for reading that position back out.
 */
export function TurnPager({ pages, disabled, onCurrentIndexChange, className }: TurnPagerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  // Assumed correct immediately (the newest page) rather than starting at 0 and waiting for the
  // IntersectionObserver to correct it — a resumed campaign with several turns already logged
  // would otherwise flash page 1 before jumping to where the player left off, the exact
  // after-the-fact-correction bug shape isAtBottom's old one-way latch existed to avoid (see
  // Play.tsx's history / CLAUDE.md's issues #16/#17/#35).
  const [currentIndex, setCurrentIndex] = useState(() => Math.max(pages.length - 1, 0))
  // The last index a navigation actually requested — deliberately separate from currentIndex
  // (which only ever comes from the IntersectionObserver confirming where the scroll landed, see
  // below). Prev/next/keyboard math is based on *this*, not currentIndex: a smooth scroll spans
  // several frames, so a second key press or button click before the observer catches up would
  // otherwise compute its delta from a stale confirmed position and land one page short (verified
  // while writing this component's stories — two quick Previous clicks from the last page landed
  // on the second-to-last page, not the first).
  const targetIndexRef = useRef(Math.max(pages.length - 1, 0))

  const setPageRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(index, el)
    else pageRefs.current.delete(index)
  }, [])

  const goTo = useCallback((index: number, behavior: ScrollBehavior) => {
    const container = containerRef.current
    const target = pageRefs.current.get(index)
    if (!container || !target) return
    // Not target.offsetLeft: that's relative to target's nearest *positioned* ancestor, which
    // isn't necessarily (and here, isn't) this container — it's position:static, so offsetLeft
    // would resolve against whatever positioned ancestor sits further up the tree, silently
    // scrolling to the wrong page. Measuring both rects against the viewport and taking the
    // difference is correct regardless of the positioning context in between.
    const left = target.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft
    container.scrollTo({ left, behavior })
  }, [])

  const goToIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, pages.length - 1))
      targetIndexRef.current = clamped
      goTo(clamped, 'smooth')
    },
    [goTo, pages.length],
  )
  const goPrev = useCallback(() => goToIndex(targetIndexRef.current - 1), [goToIndex])
  const goNext = useCallback(() => goToIndex(targetIndexRef.current + 1), [goToIndex])

  // The single mechanism for "where am I": every page is observed at once, and whichever one
  // crosses the visibility threshold becomes current. Prev/next/keyboard navigation and the
  // auto-advance effect below all drive the scroll position, but never set this state directly —
  // it only ever comes from here, so there's nothing for it to disagree with.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio < CURRENT_PAGE_THRESHOLD) continue
          const raw = (entry.target as HTMLElement).dataset.pageIndex
          const idx = raw === undefined ? NaN : Number(raw)
          if (!Number.isNaN(idx)) setCurrentIndex(idx)
        }
      },
      { root: container, threshold: [CURRENT_PAGE_THRESHOLD] },
    )
    for (const el of pageRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [pages.length])

  useEffect(() => {
    // Re-syncs targetIndexRef to reality once it's confirmed — covers a native touch swipe, which
    // moves the scroll container directly and so never goes through goToIndex/targetIndexRef at
    // all. Safe against the double-click case goToIndex's doc comment describes: this only runs
    // when currentIndex itself changes, so it can't fire *between* two rapid clicks whose target
    // page hasn't been confirmed by the observer yet.
    targetIndexRef.current = currentIndex
    onCurrentIndexChange?.(currentIndex)
  }, [currentIndex, onCurrentIndexChange])

  // Auto-advances to the newest page whenever a turn is applied — replaces the old
  // scroll-to-bottom effect, including that it's unconditional: it interrupts a mid-history read
  // the same way the old log's auto-scroll to the bottom did. Keyed on the *last page's own
  // identity* (its turn number), not pages.length, since useCampaign only keeps the most recent
  // few turns — length plateaus once a session passes that, while turn number keeps climbing
  // regardless, which is what should re-arm this on every actual new turn.
  //
  // A layout effect, not a plain effect: the very first run (mount) must land before the browser
  // paints, or a resumed campaign would flash page 1 before instantly jumping to the last page —
  // see currentIndex's initializer above for the matching half of this. Later runs (an actual new
  // turn arriving) animate instead, which is unaffected by which effect flavor triggers it, since
  // a smooth scroll is asynchronous regardless.
  const isFirstRunRef = useRef(true)
  const lastPageTurn = pages.at(-1)?.turn
  useLayoutEffect(() => {
    if (pages.length === 0) return
    const behavior: ScrollBehavior = isFirstRunRef.current ? 'auto' : 'smooth'
    isFirstRunRef.current = false
    targetIndexRef.current = pages.length - 1
    goTo(pages.length - 1, behavior)
    // lastPageTurn is the actual trigger; pages.length/goTo participate so a resize of the
    // dataset (not just its tail) can't leave this stale.
  }, [lastPageTurn, pages.length, goTo])

  // Arrow-key navigation — ignored while focus is in a text field (or contenteditable) so it
  // never hijacks cursor movement in Play.tsx's free-text box, which lives outside this
  // component entirely but can still hold focus while a page is on screen. Also ignored while
  // focus is anywhere inside an open dialog (Radix's Dialog.Content sets role="dialog" by
  // default) — otherwise ArrowLeft/Right pressed while, say, the manual-paste dialog's Cancel
  // button has focus silently paged the *background* content behind the modal (flagged in
  // PR #38's review, reproduced: focus the dialog's Cancel button, press ArrowLeft, the page
  // underneath advances even though the dialog visually didn't change).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (target?.closest('[role="dialog"]')) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goNext, goPrev])

  if (pages.length === 0) return null

  const isFirstPage = currentIndex <= 0
  const isLastPage = currentIndex >= pages.length - 1
  const current = pages[currentIndex]

  return (
    <div className={className}>
      {/* One shared bar, not one per page — reflects whichever page is current. Back is disabled
          (not hidden) at the first page, since there's still a reason to see "you can't go back
          further"; forward is hidden outright at the last/live page, since there's nothing there
          yet to page forward *to* (a disabled button implying otherwise would be misleading, not
          just inactive). Ghost-styled, not outlined — nav chrome, not a primary action. */}
      <div className="mb-2 flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={goPrev}
          disabled={isFirstPage}
          title="Previous turn"
          aria-label="Previous turn"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {current.turnLabel}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 tabular-nums"
              aria-label={`Jump to a turn — currently turn ${currentIndex + 1} of ${pages.length}`}
            >
              {currentIndex + 1}/{pages.length}
            </Button>
          </DropdownMenuTrigger>
          {/* Overrides the shadcn default of matching the trigger's own width (fine for a normal
              menu, but this trigger is just "3/3" — the menu needs to fit each turn's label
              instead), sized to content up to the viewport rather than truncated. */}
          <DropdownMenuContent align="end" className="w-auto max-w-[min(28rem,90vw)] min-w-48">
            {pages.map((page, i) => (
              <DropdownMenuItem key={page.turn} onClick={() => goToIndex(i)}>
                <span className="whitespace-normal">{page.turnLabel}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {!isLastPage && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={goNext}
            title="Next turn"
            aria-label="Next turn"
          >
            <ChevronRight className="size-4" />
          </Button>
        )}
      </div>

      <div
        ref={containerRef}
        data-testid="turn-pager"
        data-current-index={currentIndex}
        role="group"
        aria-label={`Turn ${currentIndex + 1} of ${pages.length}`}
        tabIndex={0}
        className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {pages.map((page, i) => (
          <div
            key={page.turn}
            ref={(el) => setPageRef(i, el)}
            data-page-index={i}
            data-testid={`turn-page-${page.turn}`}
            className="max-h-[70svh] w-full shrink-0 snap-start overflow-y-auto"
          >
            <div className="flex flex-col gap-2 p-4 sm:p-5">
              {page.actions && <div className="flex justify-end">{page.actions}</div>}
              <TurnContent blocks={page.blocks} onSelectOption={page.onSelectOption} disabled={disabled} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
