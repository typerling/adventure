import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Phase 2 tier 3 (issue #95): dropped Radix's `ScrollArea` primitive entirely in favor of a plain
 * native-scrolling div. Radix's wrapper here was purely custom scrollbar visual chrome
 * (`ScrollBar`/`ScrollAreaThumb`/`Corner`) over native scrolling — no keyboard nav, no focus
 * trapping, nothing else it provided (confirmed the same way tier 2 checked `Progress`: reading
 * what the primitive actually composes, not assuming). Every real call site (Codex's 8 tab
 * panels, Settings' 2 model-catalog lists) keeps the browser's native scrollbar visible rather
 * than the `scrollbar-none` utility (issue #69) used elsewhere for swipe containers — unlike
 * those, these lists have no other affordance hinting more content sits below the fold, so hiding
 * the one native cue would make that content harder to discover, not tidier.
 *
 * `viewportRef` was part of the old public API but unused at every real call site (verified via
 * repo-wide grep before dropping it) — this replacement's prop surface only covers what's
 * actually used, in the same spirit as the sonner→toast replacement below not reproducing API
 * surface nothing here calls.
 *
 * `data-slot="scroll-area-viewport"` is kept on the actual scrolling element so
 * `scroll-area.stories.tsx`'s existing `OverflowsAndScrolls` interaction test (which reads
 * `scrollHeight`/`clientHeight`/`scrollTop` off that selector) keeps working unmodified.
 */
function ScrollArea({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="scroll-area" className={cn("relative", className)} {...props}>
      <div
        data-slot="scroll-area-viewport"
        className="size-full overflow-y-auto rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </div>
    </div>
  )
}

export { ScrollArea }
