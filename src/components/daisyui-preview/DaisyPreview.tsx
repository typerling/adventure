import { useId, useRef } from 'react'

/**
 * Phase 1 theming-review markup for issue #28 — plain daisyUI utility classes on native HTML
 * elements, exactly how Phase 2's real migrated `src/components/ui/*` primitives will eventually
 * render. This is deliberately NOT a reusable component: no `src/pages/*` screen imports it, it
 * takes no props, and it lives in its own `daisyui-preview/` directory rather than
 * `src/components/ui/` specifically so it can never be mistaken for one of the real shadcn/Radix
 * primitives those pages actually use — see the Phase 1 PR description for the full reasoning,
 * and DESIGN.md's UI stack section for the proposed Phase 2 migration order this preview is
 * meant to de-risk.
 *
 * Six representative types per the issue: button, card, select, input, badge, dialog (a native
 * `<dialog>` using daisyUI's v5-recommended `.modal`/`showModal()` pattern, not the older
 * checkbox-toggle hack) — plus a `.dropdown` menu, since the issue named "select/dropdown" as one
 * combined slot and both are cheap to show side by side.
 *
 * Themed entirely by daisyUI's `data-theme` attribute — see `DaisyPreview.stories.tsx`'s
 * `WithDaisyTheme` decorator for how the Storybook toolbar drives that attribute on this
 * component's own wrapper `<section>`, deliberately not on `document.documentElement` (see that
 * file's comment for why).
 */
export function DaisyPreview() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const selectId = useId()
  const inputId = useId()

  return (
    <div className="flex max-w-xl flex-col gap-6 bg-base-100 p-6 text-base-content">
      <section aria-label="Buttons" className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary">
          Primary
        </button>
        <button type="button" className="btn btn-secondary">
          Secondary
        </button>
        <button type="button" className="btn btn-accent">
          Accent
        </button>
        <button type="button" className="btn btn-outline">
          Outline
        </button>
        <button type="button" className="btn btn-ghost">
          Ghost
        </button>
      </section>

      <div className="card card-border bg-base-200">
        <div className="card-body">
          <h3 className="card-title">Card title</h3>
          <p>A representative card body, themed entirely by daisyUI CSS custom properties.</p>
          <div className="card-actions justify-end">
            <button type="button" className="btn btn-primary btn-sm">
              Act
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <fieldset className="fieldset w-full max-w-xs">
          <legend className="fieldset-legend">Difficulty</legend>
          <select id={selectId} className="select w-full max-w-xs" defaultValue="normal">
            <option value="easy">Easy</option>
            <option value="normal">Normal</option>
            <option value="hard">Hard</option>
          </select>
        </fieldset>

        <fieldset className="fieldset w-full max-w-xs">
          <legend className="fieldset-legend">Character name</legend>
          <input id={inputId} type="text" placeholder="Say or do anything…" className="input w-full max-w-xs" />
        </fieldset>
      </div>

      <div aria-label="Badges" className="flex flex-wrap gap-2">
        <span className="badge badge-primary">Primary</span>
        <span className="badge badge-secondary">Secondary</span>
        <span className="badge badge-accent">Accent</span>
        <span className="badge badge-outline">Outline</span>
      </div>

      <div className="dropdown">
        <button type="button" tabIndex={0} className="btn btn-outline">
          Actions
        </button>
        <ul className="menu dropdown-content z-1 w-48 rounded-box bg-base-200 p-2 shadow-sm">
          <li>
            <a>Investigate</a>
          </li>
          <li>
            <a>Retreat</a>
          </li>
          <li>
            <a>Rest</a>
          </li>
        </ul>
      </div>

      <div>
        <button type="button" className="btn" onClick={() => dialogRef.current?.showModal()}>
          Open dialog
        </button>
        <dialog ref={dialogRef} className="modal">
          <div className="modal-box">
            <h3 className="text-lg font-bold">A turn requires confirmation</h3>
            <p className="py-4">
              Representative dialog content, themed the same way as everything else in this preview.
            </p>
            <div className="modal-action">
              <form method="dialog">
                <button type="submit" className="btn">
                  Close
                </button>
              </form>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button type="submit">close</button>
          </form>
        </dialog>
      </div>
    </div>
  )
}
