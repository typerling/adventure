import * as React from "react"

import { cn } from "@/lib/utils"

// Phase 2 tier 1 (issue #91). Radix's `Label` (`@radix-ui/react-label`'s source, read directly —
// not assumed) renders nothing but a plain native `<label>` under the hood (`Primitive.label`)
// plus exactly one behavior on top: an `onMouseDown` handler that calls `preventDefault()` on a
// double/triple-click (`event.detail > 1`) so clicking a label repeatedly doesn't select its text
// — skipped when the mousedown target is itself a nested button/input/select/textarea, so it never
// interferes with actually using the control the label describes. The *other* thing labels are
// for — clicking the label text to focus/activate the control named by `htmlFor` — was never a
// Radix behavior at all; it's the browser's native `<label for="...">` association, which a plain
// native `<label>` gets for free with zero JS. So this drops Radix entirely (there's no floating
// /focus-trap/keyboard behavior here the way there is for later tiers) but keeps both real
// behaviors: native `htmlFor` association (automatic) and the double-click guard (ported below,
// verified against this app's real `htmlFor` call sites in Settings.tsx/NewCampaign.tsx, several
// of which pair a Label with a Select/Input specifically to get this click-to-focus behavior).
//
// Deliberately NOT using daisyUI's `.label` class (`color: color-mix(in oklab, currentcolor 60%,
// transparent)` — checked the installed package's compiled CSS, not assumed): every real call site
// today renders full-strength, non-muted text (`font-medium`, no opacity reduction), and two call
// sites (Settings.tsx's "Run on" rows) already layer their OWN `text-muted-foreground` on top of
// Label — `.label`'s built-in muting would either get silently overridden by that (redundant) or
// silently override it (breaking the call site's explicit intent), depending on generated-CSS
// order, for no visual benefit either way. Kept the existing Tailwind classes instead — the same
// tokens (`text-sm`/`font-medium`), not new ones, just no longer routed through Radix.
function Label({
  className,
  onMouseDown,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50",
        className
      )}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement
        if (target.closest("button, input, select, textarea")) return
        onMouseDown?.(event)
        if (!event.defaultPrevented && event.detail > 1) event.preventDefault()
      }}
      {...props}
    />
  )
}

export { Label }
