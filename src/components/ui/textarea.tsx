import * as React from "react"

import { cn } from "@/lib/utils"

// Phase 2 tier 2 (issue #93): renders via daisyUI's `.textarea` class. Same override approach as
// input.tsx (read that file's comment for the full reasoning) — `.textarea`'s compiled CSS bakes
// in a fixed `min-height:5rem`/`padding-block:.5rem`/`padding-inline:.75rem` and daisyUI's own
// `--input-color`-driven border/background, all overridden with Tailwind's `!` modifier to keep
// this app's actual sizing (`min-h-16`) and dedicated `--input`/`--border` color tokens; radius
// goes through the genuine `--radius-field` custom-property hook instead.
//
// **`--border` collision**: `.textarea` reads `--border` as a length, same as `.input`/`.btn` —
// added to `src/index.css`'s scoped `--border: 1px` override list.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "textarea [--radius-field:1rem] flex field-sizing-content min-h-16 !min-h-16 w-full !w-full !px-2.5 !py-2 text-base !font-normal transition-colors !outline-none focus:!outline-none focus-within:!outline-none placeholder:text-muted-foreground !border-input !bg-transparent focus-visible:!border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:!bg-input/50 disabled:opacity-50 aria-invalid:!border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:!bg-input/30 dark:disabled:!bg-input/80 dark:aria-invalid:!border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
