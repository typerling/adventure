import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { CollapsibleSettingsCard } from './CollapsibleSettingsCard'

const meta = {
  title: 'App/CollapsibleSettingsCard',
  component: CollapsibleSettingsCard,
  tags: ['autodocs'],
  // The disclosure toggle is a real tap target worth checking at phone width specifically (see
  // CLAUDE.md's Storybook section) as well as desktop.
  globals: { viewport: { value: 'mobile' } },
  args: {
    title: 'Local AI models',
    description:
      'Used by any campaign set to "Local model (runs on this device)" — no key, no server.',
    testId: 'local-models-card',
    children: <p className="text-sm text-muted-foreground">Download management UI goes here.</p>,
  },
} satisfies Meta<typeof CollapsibleSettingsCard>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed by default (issue #22's global-settings-page / "campaign doesn't use this mode"
 * case) — the title/description stay visible, but the body (the actual download UI) is hidden
 * until expanded. */
export const CollapsedByDefault: Story = {
  args: { defaultOpen: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Card/CardTitle render as plain styled <div>s (see card.tsx), not semantic headings — the
    // title is queried by text, not role, same as the app's own Playwright specs do for it.
    await expect(canvas.getByText('Local AI models', { exact: true })).toBeVisible()
    // The body is a genuine conditional render, not just visually hidden (issue #95 dropped
    // Radix's Collapsible entirely — see CollapsibleSettingsCard.tsx's own comment) — so the body
    // text isn't just invisible, it isn't in the DOM at all.
    expect(canvas.queryByText('Download management UI goes here.')).not.toBeInTheDocument()

    const toggle = canvas.getByTestId('local-models-card-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    await waitFor(() =>
      expect(canvas.getByText('Download management UI goes here.')).toBeVisible(),
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // Clicking again collapses it back.
    await userEvent.click(toggle)
    await waitFor(() =>
      expect(canvas.queryByText('Download management UI goes here.')).not.toBeInTheDocument(),
    )
  },
}

export const CollapsedByDefaultDesktop: Story = {
  ...CollapsedByDefault,
  globals: { viewport: { value: 'desktop' } },
}

/** Expanded by default — Settings.tsx passes this when the currently open campaign already uses
 * the mode this card manages (e.g. AI mode "local" for this card, or the TTS provider set to
 * Kokoro for its sibling), so the download UI a player is about to need is already in view. */
export const ExpandedByDefault: Story = {
  args: { defaultOpen: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText('Download management UI goes here.')).toBeVisible(),
    )
    expect(canvas.getByTestId('local-models-card-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  },
}

export const ExpandedByDefaultDesktop: Story = {
  ...ExpandedByDefault,
  globals: { viewport: { value: 'desktop' } },
}
