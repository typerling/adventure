import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { DaisyPreview } from './DaisyPreview'

/**
 * Sets daisyUI's `data-theme` attribute on a wrapper `<section>` around the story, driven by the
 * `daisyTheme` Storybook global (preview.tsx). Deliberately scoped to that wrapper rather than
 * `document.documentElement`, for two reasons:
 *
 * 1. Isolation — this whole Phase 1 PR must not change how any real page renders. Every other
 *    story file's `.dark`/`.light` toggle already lives on `document.documentElement` (see
 *    preview.tsx's `WithTheme`); adding a second, unrelated attribute to that same shared element
 *    from a different decorator is an easy way to create surprising interaction between two
 *    theming systems that this PR's whole point is to prove *don't* interact. A scoped wrapper
 *    makes that isolation structural instead of just "true today."
 * 2. It mirrors daisyUI's own multi-theme model: `data-theme` is meant to be settable on *any*
 *    element (that's what lets Phase 3 theme one scene's UI without a page navigation or full
 *    reload), not just `<html>`. Demonstrating it scoped here is a more honest preview of that
 *    future use than always setting it at the root would be.
 *
 * `'system'` removes the attribute entirely, letting the wrapper inherit whatever `:root` already
 * resolves to — daisyUI's own `default`/`prefersdark` theme flags (src/index.css) — the same
 * "system" semantics the existing `theme` global already uses for `.dark`/`.light`.
 */
function WithDaisyTheme(Story: React.ComponentType, context: { globals: { daisyTheme?: string } }) {
  const daisyTheme = context.globals.daisyTheme ?? 'system'
  return (
    <section data-theme={daisyTheme === 'system' ? undefined : daisyTheme}>
      <Story />
    </section>
  )
}

const meta = {
  title: 'DaisyUI Preview (Phase 1)/Theming Review',
  component: DaisyPreview,
  decorators: [WithDaisyTheme],
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "Representative daisyUI-classed mocks (button, card, select, input, badge, dropdown, dialog) for reviewing issue #28's theming approach before any real `src/components/ui/*` primitive migrates. Use the toolbar's **daisyUI theme** control (separate from the existing **Theme** control, which only affects real shadcn/Radix components) to flip between the app's two baseline themes.",
      },
    },
  },
} satisfies Meta<typeof DaisyPreview>

export default meta
type Story = StoryObj<typeof meta>

/** Whatever the toolbar's daisyUI theme control is currently set to (defaults to 'system'). */
export const Default: Story = {}

export const AdventureLightDesktop: Story = {
  name: 'Adventure Light — Desktop',
  globals: { daisyTheme: 'adventure-light', viewport: { value: 'desktop' } },
}

export const AdventureLightMobile: Story = {
  name: 'Adventure Light — Mobile',
  globals: { daisyTheme: 'adventure-light', viewport: { value: 'mobile' } },
}

export const AdventureDarkDesktop: Story = {
  name: 'Adventure Dark — Desktop',
  globals: { daisyTheme: 'adventure-dark', viewport: { value: 'desktop' } },
}

export const AdventureDarkMobile: Story = {
  name: 'Adventure Dark — Mobile',
  globals: { daisyTheme: 'adventure-dark', viewport: { value: 'mobile' } },
}

// Proves the toggle actually does something to real rendered pixels, not just that the attribute
// gets set — reads a computed style driven by daisyUI's theme tokens (the primary button's
// background-color, which comes from --color-primary) under both themes and asserts they differ.
// This is the "actually drive it, don't just claim it works" check from the Phase 1 spec, run
// through `npm run test:stories` rather than only eyeballed manually.
export const ThemeTogglesRenderedColor: Story = {
  name: 'Theme toggle changes rendered color (interaction test)',
  globals: { daisyTheme: 'adventure-light' },
  play: async ({ canvasElement }) => {
    const section = canvasElement.querySelector('section[data-theme]') as HTMLElement | null
    if (!section) throw new Error('Expected the WithDaisyTheme wrapper <section> to be present')

    const button = section.querySelector('.btn-primary') as HTMLElement | null
    if (!button) throw new Error('Expected a .btn-primary element to be present')

    const lightBackground = getComputedStyle(button).backgroundColor

    section.setAttribute('data-theme', 'adventure-dark')
    const darkBackground = getComputedStyle(button).backgroundColor

    await expect(darkBackground).not.toBe(lightBackground)

    // Leave the section back where the story's own globals put it, so re-running this play
    // function (or a later assertion in the same session) isn't affected by this mutation.
    section.setAttribute('data-theme', 'adventure-light')
  },
}

// Opens the native <dialog> so its themed .modal-box is visible in a screenshot too — the other
// stories above only show the "Open dialog" trigger, since a <dialog> renders in the top layer
// closed by default.
export const DialogOpenAdventureDark: Story = {
  name: 'Dialog open — Adventure Dark',
  globals: { daisyTheme: 'adventure-dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Open dialog' }))
    // Radix's own stories (see this repo's dialog.stories.tsx) hit the same class of issue:
    // daisyUI's `.modal` becomes visible via a `visibility: hidden -> visible` CSS transition
    // (`allow-discrete`), so the very first post-click style recalculation can still read
    // "hidden" — wrap in waitFor rather than asserting immediately after the click.
    await waitFor(() =>
      expect(canvas.getByRole('heading', { name: 'A turn requires confirmation' })).toBeVisible(),
    )
  },
}

// Sanity check that the two theming systems really are inert with respect to each other: toggling
// daisyUI's data-theme on the wrapper must not touch document.documentElement's .dark/.light
// class, and vice versa — the concrete claim this PR's "coexist, don't replace yet" decision
// rests on.
export const DaisyThemeDoesNotTouchDocumentClass: Story = {
  name: 'daisyTheme does not touch document.documentElement (interaction test)',
  globals: { daisyTheme: 'adventure-dark' },
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.documentElement
    const classesBefore = root.className

    const section = canvasElement.querySelector('section[data-theme]') as HTMLElement | null
    if (!section) throw new Error('Expected the WithDaisyTheme wrapper <section> to be present')
    expect(section.getAttribute('data-theme')).toBe('adventure-dark')

    await expect(root.className).toBe(classesBefore)
    await expect(root.hasAttribute('data-theme')).toBe(false)
  },
}
