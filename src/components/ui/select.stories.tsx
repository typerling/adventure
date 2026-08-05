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

    await expect(canvas.getByRole('combobox', { name: 'AI mode' })).toHaveTextContent('Direct API key (Claude)')
  },
}
