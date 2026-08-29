import * as React from "react"

import { cn } from "@/lib/utils"

// Phase 2 tier 2 (issue #93): the root element now carries daisyUI's `card` class for its base
// mechanics (`position:relative`, `flex-direction:column`, a focus-visible outline for the rare
// clickable-card case) alongside this app's existing bespoke layout/color classes, which are kept
// almost entirely as-is rather than swapped for daisyUI's own `card-body`/`card-title`/
// `card-actions` companions.
//
// **`--border` collision, checked and NOT applicable here**: the installed package's compiled
// `card.css` shows plain `.card` never reads `--border` at all — only its `.card-border`/
// `.card-dash` border-style *modifiers* do (`border: var(--border) solid var(--color-base-200)`),
// and this component deliberately doesn't use either (see below), so unlike `.btn`/`.input`/
// `.textarea`, `.card` needs no entry in `src/index.css`'s scoped `--border` override list.
//
// **Why not `card-border`/the daisyUI color tokens for background**: this app's Card already had
// its own dedicated, correct tokens (`--card`/`--card-foreground`, distinct from daisyUI's more
// generic `--color-base-200`/`--color-base-300` "next surface up" tokens, which tier 1's bridge
// intentionally aliases *differently* per light/dark — see that block's comment) — switching to
// `bg-base-200` here would visibly grey out light-mode cards (base-200 aliases to `--muted`,
// noticeably darker than this app's near-white `--card`) for no benefit. Kept `bg-card`/
// `text-card-foreground`/the existing `ring-1 ring-foreground/10` border treatment unchanged,
// same reasoning as tier 1's `label.tsx` precedent: "use the daisyUI class" is a default, not an
// unconditional rule, when a real call site's own design says otherwise.
//
// **Why not `card-body`/`card-title`/`card-actions`**: daisyUI's card body is a single flat
// padding+gap container, but this app's `CardHeader` is a two-column *grid* (title/description in
// one column, an optional `CardAction` slot in the other) and `CardFooter` carries its own
// top-border + muted background — real structure no real call site can lose. `CardTitle` also
// deliberately keeps `font-heading` (this app's serif narrative-heading font) rather than
// `card-title`'s plain `font-size:1.125rem;font-weight:600` — daisyUI's typography has no concept
// of this app's dual-font (sans body / serif heading) design at all.
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "card group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
