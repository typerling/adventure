import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Textarea } from './textarea'

const meta = {
  title: 'UI/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  argTypes: {
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    placeholder: 'Say or do anything…',
  },
}

export const Disabled: Story = {
  args: {
    placeholder: 'Say or do anything…',
    disabled: true,
  },
}

// Play.tsx's free-text action box: single row that grows with content (field-sizing-content),
// no manual resize handle.
export const GrowingSingleRow: Story = {
  args: {
    placeholder: 'Say or do anything…',
    rows: 1,
    className: 'min-h-0 resize-none',
  },
}

export const TypeText: Story = {
  args: {
    placeholder: 'Say or do anything…',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByPlaceholderText('Say or do anything…')
    await userEvent.type(textarea, 'I step through the gate, hands raised.')
    await expect(textarea).toHaveValue('I step through the gate, hands raised.')
  },
}
