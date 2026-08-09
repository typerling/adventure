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
        <CardDescription>
          The one setting genuinely tied to this particular story, stored in this campaign's
          settings.md (issue #77 moved everything else to a global store — see below).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Card content goes here.</p>
      </CardContent>
    </Card>
  )
}

/** One of Settings.tsx's headed groups (issue #22, revised by #77) — a heading, an optional
 * description, and whatever cards are passed as children. */
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

/** The "AI & voice providers" section's real copy (issue #77) — a description explaining these
 * settings are global to this device, not saved per campaign the way "This campaign" once
 * implied for the whole page. */
export const WithDescription: Story = {
  args: {
    title: 'AI & voice providers',
    description:
      'The same AI mode, models, and voice choices apply to every campaign on this device — not saved per campaign, and not synced to other devices signed into the same Google account (see below).',
    children: <ExampleCard />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: 'AI & voice providers' })).toBeVisible()
    await expect(canvas.getByText(/apply to every campaign on this device/)).toBeVisible()
  },
}
