import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { SettingsSection } from './SettingsSection'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const meta = {
  title: 'App/SettingsSection',
  component: SettingsSection,
  tags: ['autodocs'],
  // A heading + stacked cards reflows identically at both widths (see CLAUDE.md's Storybook
  // section) — both viewports are covered here per the epic's working agreement, even though
  // nothing about this component is viewport-conditional itself.
  globals: { viewport: { value: 'mobile' } },
} satisfies Meta<typeof SettingsSection>

export default meta
type Story = StoryObj<typeof meta>

function ExampleCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>This campaign</CardTitle>
        <CardDescription>AI mode and voice provider choices, stored in this campaign's settings.md.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Card content goes here.</p>
      </CardContent>
    </Card>
  )
}

/** One of Settings.tsx's three headed groups (issue #22) — a heading, an optional description, and
 * whatever cards are passed as children. */
export const Default: Story = {
  args: {
    title: 'This campaign',
    children: <ExampleCard />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'This campaign' })).toBeVisible()
    await expect(canvas.getByText('Card content goes here.')).toBeVisible()
  },
}

export const DefaultDesktop: Story = {
  ...Default,
  globals: { viewport: { value: 'desktop' } },
}

/** The "AI & voice providers" section's real copy — a description explaining these settings are
 * account-wide, distinct from "This campaign"'s per-campaign framing. */
export const WithDescription: Story = {
  args: {
    title: 'AI & voice providers',
    description:
      'Account-wide — apply to every campaign on this device, not just the one currently open.',
    children: <ExampleCard />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'AI & voice providers' })).toBeVisible()
    await expect(canvas.getByText(/Account-wide/)).toBeVisible()
  },
}
