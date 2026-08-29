import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Phase 2 tier 2 (issue #93): renders via daisyUI's `.btn` + color-variant modifier classes
// (`btn-primary`, `btn-outline`, ...) instead of shadcn's own Tailwind utilities, following tier
// 1's (issue #91) established convention. Colors come entirely from daisyUI's own tokens
// (`--color-primary`, `--color-error`, ...) via the `--btn-color`/`--btn-fg` custom properties
// `.btn`'s compiled CSS reads, which `src/index.css`'s Phase 2 bridge block already aliases onto
// this app's `.dark`/`.light`-tracking variables (see that block's comment) — no new bridging
// needed here, tier 1 already covered every color token this component touches.
//
// **Sizing deliberately does NOT use daisyUI's own `.btn-xs`/`.btn-sm`/`.btn-lg`/`.btn-xl`
// modifiers.** Checked against the installed package's compiled `button.css`: daisyUI's un-sized
// `.btn` alone is already 2.5rem/40px tall (`--size:calc(var(--size-field)*10)`), and its size
// modifiers step from there — noticeably taller than this app's actual button density (`h-8`/32px
// default, `h-9`/36px at "lg"). Rather than fight that with a plain Tailwind `h-*` utility (an
// unnecessary cascade-order gamble between two same-specificity single-class rules), each size
// variant below sets the exact custom properties `.btn`'s own CSS already reads for size
// (`--size`, `--btn-p` horizontal padding, `--fontsize`) and radius (`--radius-field`, which the
// button's border-*-radius longhands read via `var(--join-ss, var(--radius-field))` etc.) to the
// precise pixel values the old CVA config used — genuinely driven by daisyUI's own sizing
// mechanism, just parameterized to this app's existing density instead of accepting the stock
// steps. Verified against real rendered buttons with a computed-style probe (padding/height/
// border-radius), not assumed from reading the CSS alone.
//
// **`--border` collision**: `.btn` reads `--border` as a length (`border-width:var(--border)`),
// confirmed in the installed package's compiled `button.css` — the same collision tier 1 fixed for
// `.badge`. `.btn` is added to `src/index.css`'s scoped `--border: 1px` override alongside
// `.badge`. (`.card` itself does NOT read `--border` — only its unused `.card-border`/`.card-dash`
// modifiers do, see card.tsx's comment — so `.card` is deliberately left out of that list; `.input`
// and `.textarea` do read it and are added too.)
//
// **Depth/noise are already zeroed** by tier 1's `adventure-light`/`adventure-dark` theme blocks
// (`--depth: 0`, `--noise: 0`), which is what keeps daisyUI's built-in glossy inset-shadow/border
// system from fighting this app's flat button look — no extra work needed here, just relying on
// what Phase 1 already set up.
// Note: deliberately no base `border-transparent` (shadcn's old base class had one). `.btn`'s own
// compiled CSS already sets `border-color:var(--btn-border)` per variant (transparent for ghost/
// link, a real color for outline, and a color that blends invisibly into the flat `--depth:0`
// background for solid variants) — a same-specificity `border-transparent` utility here would win
// the cascade unpredictably and silently strip the outline variant's actual visible border. Caught
// by the computed-style probe this task requires, not a screenshot: `outline`'s border-color came
// back fully transparent until this was removed.
// Note: also deliberately no base `text-sm` (same reasoning as dropping `border-transparent`
// above) — `.btn` sets `font-size:var(--fontsize,.875rem)`, and a same-specificity `text-sm`
// utility here would win the cascade for every size, flattening the per-size `--fontsize` value
// each size variant below actually sets. Caught the same way: every size probed back at a uniform
// 14px until this was removed.
const buttonVariants = cva(
  "btn group/button inline-flex shrink-0 items-center justify-center bg-clip-padding font-medium whitespace-nowrap normal-case shadow-none transition-all outline-none select-none focus-visible:!border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:!border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:!border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [--radius-field:1rem]",
  {
    variants: {
      variant: {
        default: "btn-primary",
        outline:
          "btn-outline aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary: "btn-secondary aria-expanded:bg-secondary/80",
        ghost:
          "btn-ghost aria-expanded:bg-muted aria-expanded:text-foreground",
        // daisyUI's `.btn-soft` (a translucent tint of `--btn-color`) is the closest match to
        // shadcn's old `bg-destructive/10` treatment — the same pairing badge.tsx's `destructive`
        // variant already established for this app (`badge-error badge-soft`).
        destructive: "btn-error btn-soft",
        link: "btn-link no-underline hover:underline",
      },
      size: {
        default:
          "[--size:2rem] [--btn-p:0.625rem] [--fontsize:0.875rem] gap-1.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "[--size:1.5rem] [--btn-p:0.5rem] [--fontsize:0.75rem] [--radius-field:min(0.625rem,var(--radius-md))] gap-1 in-data-[slot=button-group]:[--radius-field:1rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "[--size:1.75rem] [--btn-p:0.625rem] [--fontsize:0.8rem] [--radius-field:min(0.75rem,var(--radius-md))] gap-1 in-data-[slot=button-group]:[--radius-field:1rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "[--size:2.25rem] [--btn-p:0.625rem] [--fontsize:0.875rem] gap-1.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "btn-square [--size:2rem]",
        "icon-xs": "btn-square [--size:1.5rem] [--radius-field:min(0.625rem,var(--radius-md))] in-data-[slot=button-group]:[--radius-field:1rem] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "btn-square [--size:1.75rem] [--radius-field:min(0.75rem,var(--radius-md))] in-data-[slot=button-group]:[--radius-field:1rem]",
        "icon-lg": "btn-square [--size:2.25rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
