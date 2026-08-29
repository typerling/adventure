import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Label } from './label'
import { Input } from './input'

const meta = {
  title: 'UI/Label',
  component: Label,
  tags: ['autodocs'],
} satisfies Meta<typeof Label>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Campaign name',
  },
}

export const PairedWithInput: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="campaign-name-story">Campaign name</Label>
      <Input id="campaign-name-story" placeholder="Dust and Ninety Miles" />
    </div>
  ),
}

// Phase 2 tier 1 (issue #91): the whole reason label.tsx dropped Radix's `Label` for a plain
// native `<label>` instead of assuming it was safe — verifies the one behavior this app's real
// `htmlFor` call sites (Settings.tsx, NewCampaign.tsx) actually depend on: clicking the label
// text focuses/activates the control it names, exactly what a real player does when they click
// "Campaign name" rather than the input itself. This is native `<label for="...">` behavior, not
// anything Radix added — confirmed by reading `@radix-ui/react-label`'s own source (see label.tsx's
// module comment) — so this test is really asserting the browser's own behavior still fires
// through this component, not testing a hand-rolled reimplementation of it.
export const ClickToFocus: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="campaign-name-click-story">Campaign name</Label>
      <Input id="campaign-name-click-story" placeholder="Dust and Ninety Miles" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const label = canvas.getByText('Campaign name')
    const input = canvas.getByPlaceholderText('Dust and Ninety Miles')
    await expect(input).not.toHaveFocus()
    await userEvent.click(label)
    await expect(input).toHaveFocus()
  },
}
