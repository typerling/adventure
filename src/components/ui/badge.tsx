import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Phase 2 tier 1 (issue #91): renders via daisyUI's `.badge` + variant modifier classes instead
// of shadcn's own Tailwind utilities, using the same markup/class pairing already reviewed in
// Phase 1's `src/components/daisyui-preview/DaisyPreview.tsx` (`badge badge-primary`, etc.) rather
// than inventing a new convention. Colors come entirely from daisyUI's own tokens
// (`--color-primary`, `--color-error`, ...), which `src/index.css`'s Phase 2 bridge block aliases
// onto this app's existing `--primary`/`--destructive`/... variables so they still track the
// app's real `.dark`/`.light` (and system-preference) toggle — see that block's comment.
const badgeVariants = cva(
  "group/badge badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:outline-2 aria-invalid:outline-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "badge-primary",
        secondary: "badge-secondary",
        // daisyUI's `.badge-soft` (a translucent tint of `--badge-color`) is the closest match to
        // shadcn's old `bg-destructive/10` treatment — a muted rather than solid destructive fill.
        destructive: "badge-error badge-soft",
        outline: "badge-outline",
        ghost: "badge-ghost",
        // daisyUI has no "link"-styled badge — this variant isn't used at any real call site
        // (verified via grep), but stays in the exported type/API for parity with shadcn's set;
        // layered on top of the same `.badge` shape/sizing, just recolored with existing tokens.
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
