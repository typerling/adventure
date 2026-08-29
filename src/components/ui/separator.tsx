import * as React from "react"

import { cn } from "@/lib/utils"

// Phase 2 tier 1 (issue #91): previously wrapped Radix's `Separator` primitive, which itself just
// renders a plain `<div>` with an ARIA role/orientation attribute — no focus/keyboard behavior to
// reproduce (unlike Label below), so this drops the Radix dependency for a native element with the
// same accessibility semantics implemented by hand. Renders via daisyUI's `.divider` — the same
// class this app already uses/reviewed in Phase 1's `daisyui-preview` — rather than shadcn's
// `bg-border` line: `.divider` draws its line via `:before`/`:after` pseudo-elements colored with
// `--color-base-content` (aliased in `src/index.css`'s Phase 2 bridge block onto this app's own
// `--foreground`, so it still tracks `.dark`/`.light`), and with no children (the only way this
// component is ever used — verified via grep, no real call site passes children) those two
// pseudo-elements render as one continuous line with no gap between them, matching a plain rule.
// Note this app's own current call sites don't actually render this component today (verified via
// grep — Codex/Dashboard/NewCampaign/Play/Settings don't import it), so nothing here changes any
// real page's visuals; this is a like-for-like API migration for whenever it is used.
//
// Two deliberate visual differences from the old shadcn line, both accepted as "genuinely adopt
// daisyUI's own divider" rather than fought: (1) daisyUI's `.divider` bakes in `margin: 1rem 0`
// by default (a spacer, not a flush hairline) — left as-is rather than reset, so a bare
// `<Separator />` gets sensible spacing for free; a caller can still override it with its own
// margin className same as before. (2) the vertical case (`divider-horizontal`, daisyUI's actual —
// if confusing — class name for "the divider that separates horizontally-arranged content",
// verified against the installed package's compiled CSS) reserves 1rem of width around a 2px line
// rather than being flush 1px. `self-stretch` (a plain Tailwind utility, not fought over by
// daisyUI's own CSS — its divider rules never set `align-self`) reproduces the old vertical "fill
// the available cross-axis height" behavior on top of daisyUI's `height: auto`.
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
}) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      role={decorative ? "none" : "separator"}
      aria-orientation={
        !decorative && orientation === "vertical" ? "vertical" : undefined
      }
      className={cn(
        "divider",
        orientation === "vertical" && "divider-horizontal self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
