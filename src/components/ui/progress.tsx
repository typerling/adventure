import * as React from "react"

import { cn } from "@/lib/utils"

// Phase 2 tier 2 (issue #93): dropped the Radix `Progress` primitive for daisyUI's `.progress`
// class on a plain native `<progress>` element. Radix's `Progress` here was never doing much
// beyond ARIA plumbing to begin with (`role="progressbar"` + `aria-valuenow`/`aria-valuemax` on a
// div, no keyboard/focus behavior of its own) — a native `<progress>` element gets equivalent (in
// fact more standard) accessibility semantics for free, and is what daisyUI's `.progress` is
// actually built for: the compiled `progress.css` styles `appearance:none` on the progress element
// itself and its `::-webkit-progress-bar`/`::-moz-progress-bar` pseudo-elements, not a div+div
// composition. `value`/`max` map straight onto the native element's own attributes instead of a
// hand-computed `translateX` transform.
//
// The fill color comes from `currentColor` (`.progress`'s `background-color:color-mix(in oklab,
// currentcolor 20%, transparent)` for the track, with the filled portion painted at full
// `currentColor`) — daisyUI's own `.progress-primary` modifier (`color:var(--color-primary)`, the
// same token this app's bridge already aliases onto `--primary`) sets it, matching the old
// `bg-primary` indicator.
//
// No `--border` collision: verified against the installed package's compiled `progress.css` —
// unlike `.btn`/`.input`/`.textarea`, `.progress` never reads `--border` at all.
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<"progress">) {
  return (
    <progress
      data-slot="progress"
      className={cn("progress progress-primary h-1 w-full", className)}
      value={value ?? 0}
      max={100}
      {...props}
    />
  )
}

export { Progress }
