import * as React from "react"

import { cn } from "@/lib/utils"

// Phase 2 tier 2 (issue #93): renders via daisyUI's `.input` class instead of shadcn's own
// Tailwind utilities. Applied directly to the real `<input>` element (no wrapping `<label>`) — the
// installed package's compiled `input.css` shows `.input` supports both daisyUI's icon/addon
// wrapper pattern (`<label class="input"><input/></label>`, via its nested `.input input{...}`
// reset rule) *and* being placed straight on a bare `<input>` (daisyUI's own docs show both); this
// component has no icon/addon slot at any real call site, so the direct form keeps the existing
// single-native-element API (`React.ComponentProps<"input">`) unchanged.
//
// Several of `.input`'s own hardcoded declarations (not exposed as an overridable custom property)
// are deliberately overridden with Tailwind's `!` modifier rather than left to a same-specificity
// cascade-order guess: `padding-inline:.75rem` and `width:clamp(3rem,20rem,100%)` are fixed values
// in the compiled CSS, and `border`/`background-color` there both bake in daisyUI's own color
// logic (`--input-color`, derived from `--color-base-content`) rather than this app's dedicated,
// intentionally-softer `--input`/`--border` tokens — using daisyUI's own input-color would render a
// noticeably darker, foreground-tinted border than this app's actual design. `!important` on a
// longhand always wins over a non-important shorthand for that property regardless of layer/source
// order (verified with a real computed-style probe, not just this reasoning). `--size` (height) and
// `--radius-field` (the border-radius the component's own longhand corner rules read via
// `var(--join-ss, var(--radius-field))`) ARE genuine overridable hooks `.input` exposes, so those
// are set via custom properties instead, matching button.tsx's approach.
//
// **`--border` collision**: `.input` reads `--border` as a length (`border:var(--border) solid
// ...`), the same collision tier 1 fixed for `.badge` — added to `src/index.css`'s scoped
// `--border: 1px` override list alongside `.badge`/`.btn`/`.textarea`.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "input [--size:2rem] [--radius-field:1rem] h-8 w-full min-w-0 !w-full !px-2.5 !py-1 text-base !font-normal transition-colors !outline-none focus:!outline-none focus-within:!outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground !border-input !bg-transparent focus-visible:!border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:!bg-input/50 disabled:opacity-50 aria-invalid:!border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:!bg-input/30 dark:disabled:!bg-input/80 dark:aria-invalid:!border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
