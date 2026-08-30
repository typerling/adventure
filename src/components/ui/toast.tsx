import { useEffect, useState } from "react"
import { CircleCheckIcon, OctagonXIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Phase 2 tier 3 (issue #95): hand-rolled replacement for the `sonner` npm package, built on
 * daisyUI's own `.toast`/`.alert` classes rather than continuing to migrate anything Radix — this
 * was never a Radix wrapper (DESIGN.md §3 flags it as a separate product decision), and the
 * project owner decided explicitly to replace it rather than keep the dependency.
 *
 * Public surface is deliberately narrow: `toast.success(message)` / `toast.error(message)` only.
 * A repo-wide grep (`grep -rn "toast(\|toast\[" src/`, excluding this file and its story) found
 * every real call site uses exactly those two — no dynamic variant selection, no promise-based
 * toasts, no custom durations, no action buttons — so this doesn't reproduce sonner's full API
 * surface (positioning options, custom JSX content, `toast.promise`) that nothing here calls.
 *
 * Auto-dismiss is a plain, unconditional `setTimeout` — deliberately NOT pausing while the
 * document/tab lacks focus the way sonner's own timer does. That pausing is specifically why
 * headless Chromium (used by this repo's own Playwright/Storybook-interaction suites) never fired
 * sonner's auto-dismiss timer at all: a headless page never gains real OS focus, so a
 * focus-gated timer simply never counts down. `tests/helpers.ts`'s `hideToasts`/`recordToasts`
 * doc comments document the workarounds that grew up around that fact — this file doesn't need
 * to replicate the bug, but the toast-suppression test helpers below are kept regardless, since a
 * toast lingering for TOAST_DURATION_MS is still enough to intercept a click during a fast
 * Playwright interaction.
 *
 * Root/each-toast elements carry `data-toast-viewport`/`data-toast` (renamed from sonner's own
 * `data-sonner-toaster`/`data-sonner-toast`, since this is no longer sonner) — every reference is
 * updated alongside this file: `tests/helpers.ts` (`hideToasts`, `recordToasts`/
 * `getRecordedToasts`, `createRandomCampaign`'s inline hide/remove), `tests/voice-kokoro.spec.ts`,
 * `tests/media-session.spec.ts` (`tests/voice-elevenlabs.spec.ts` also needed it at the time, but
 * that file was since deleted outright — issue #97). A repo-wide grep for the old `data-sonner-*`
 * names after this change should turn up nothing outside this comment.
 *
 * `next-themes`'s `useTheme()` — previously imported here purely to feed sonner's own `theme`
 * prop (verified via grep that nothing else in the app used the package) — is gone along with the
 * dependency in `package.json`: this app's real dark/light state is the `.dark`/`.light` class
 * toggle (see App.tsx), which `.alert-success`/`.alert-error` already track for free through the
 * tier-1 dark-mode bridge (`src/index.css`) — no new bridging needed here, verified against that
 * bridge's existing `--color-success`/`--color-error`/`*-content` aliases rather than assumed.
 *
 * `--border` collision check (the tier 1/2 pattern — see `src/index.css`'s comment): the
 * installed daisyUI package's compiled `alert.css` reads `--border` as a length
 * (`border-width:var(--border)`), so `.alert` was added to that file's scoped override list.
 * `toast.css` never references `--border` at all, so `.toast` needed no entry.
 */

const TOAST_DURATION_MS = 4000

type ToastVariant = "success" | "error"

interface ToastItem {
  id: number
  variant: ToastVariant
  message: string
}

let toasts: ToastItem[] = []
let nextId = 0
const listeners = new Set<(items: ToastItem[]) => void>()
// Keyed by toast id so a toast's dismiss timer can be cancelled if something else clears it
// first (`resetToastStore` below) — otherwise a stale timer firing later could resurrect an id
// that's already gone, or (harmless but wasteful) just fire into an empty array.
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>()

function notify() {
  for (const listener of listeners) listener(toasts)
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  dismissTimers.delete(id)
  notify()
}

function push(variant: ToastVariant, message: string) {
  const id = ++nextId
  toasts = [...toasts, { id, variant, message }]
  notify()
  dismissTimers.set(
    id,
    setTimeout(() => dismiss(id), TOAST_DURATION_MS),
  )
}

export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
}

/**
 * Drops every current toast and cancels its pending dismiss timer. `Toaster` calls this once on
 * mount — in the real app there's exactly one `Toaster`, mounted once for the app's whole
 * lifetime (see App.tsx), so this is a no-op there. It matters for isolated component tests:
 * Storybook/`@storybook/addon-vitest` mounts a fresh `Toaster` per story, and without this a
 * still-pending toast (and its still-running timer) from a *previous* story would leak into the
 * next one's initial render — found the hard way, this module's own `toast.stories.tsx` failed
 * intermittently with "found multiple elements" until this was added.
 */
function resetToastStore(): void {
  for (const timer of dismissTimers.values()) clearTimeout(timer)
  dismissTimers.clear()
  toasts = []
}

function useToasts(): ToastItem[] {
  const [items, setItems] = useState<ToastItem[]>(toasts)
  useEffect(() => {
    resetToastStore()
    setItems(toasts)
    listeners.add(setItems)
    return () => {
      listeners.delete(setItems)
    }
  }, [])
  return items
}

const VARIANT_ALERT_CLASS: Record<ToastVariant, string> = {
  success: "alert-success",
  error: "alert-error",
}

const VARIANT_ICON: Record<ToastVariant, typeof CircleCheckIcon> = {
  success: CircleCheckIcon,
  error: OctagonXIcon,
}

function Toaster() {
  const items = useToasts()

  return (
    <div data-toast-viewport className="toast toast-end toast-bottom z-[100]">
      {items.map((item) => {
        const Icon = VARIANT_ICON[item.variant]
        return (
          <div
            key={item.id}
            data-toast
            role="status"
            className={cn("alert", VARIANT_ALERT_CLASS[item.variant])}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span>{item.message}</span>
          </div>
        )
      })}
    </div>
  )
}

export { Toaster }
