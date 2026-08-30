import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

const meta = {
  title: 'UI/Select',
  component: Select,
  tags: ['autodocs'],
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

// Matches Settings.tsx's AI-mode picker: manual copy/paste, the Claude API, or a local model.
export const Default: Story = {
  render: () => (
    <Select defaultValue="manual">
      <SelectTrigger className="w-64" aria-label="AI mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="manual">Manual (copy/paste into claude.ai or chatgpt.com)</SelectItem>
        <SelectItem value="api">Direct API key (Claude)</SelectItem>
        <SelectItem value="local">Local model (runs on this device)</SelectItem>
      </SelectContent>
    </Select>
  ),
}

export const OpensAndSelects: Story = {
  render: () => (
    <Select defaultValue="manual">
      <SelectTrigger className="w-64" aria-label="AI mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="manual">Manual</SelectItem>
        <SelectItem value="api">Direct API key (Claude)</SelectItem>
        <SelectItem value="local">Local model</SelectItem>
      </SelectContent>
    </Select>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('combobox', { name: 'AI mode' }))

    const body = within(canvasElement.ownerDocument.body)
    const option = await waitFor(() => body.getByRole('option', { name: 'Direct API key (Claude)' }))
    await userEvent.click(option)

    // Radix's `position="popper"` unmounts the closing popup's Portal (and the aria-hidden it
    // puts on the rest of the tree while open) one tick later than `item-aligned` did — a
    // real, harmless implementation-timing difference, not something a user would ever notice,
    // but the very next assertion can otherwise land while the trigger is still hidden from the
    // accessibility tree. Same class of issue as this repo's other Radix open/close-animation
    // findings (see CLAUDE.md) — wait for the settled state instead of asserting synchronously.
    await waitFor(() =>
      expect(canvas.getByRole('combobox', { name: 'AI mode' })).toHaveTextContent('Direct API key (Claude)'),
    )
  },
}
