import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Input } from './input'

const meta = {
  title: 'UI/Input',
  component: Input,
  tags: ['autodocs'],
  argTypes: {
    disabled: { control: 'boolean' },
    type: { control: 'text' },
  },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    placeholder: 'Campaign name',
  },
}

export const Disabled: Story = {
  args: {
    placeholder: 'Campaign name',
    disabled: true,
  },
}

export const Invalid: Story = {
  args: {
    placeholder: 'Campaign name',
    'aria-invalid': true,
    defaultValue: '',
  },
}

export const TypeText: Story = {
  args: {
    placeholder: 'Campaign name',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByPlaceholderText('Campaign name')
    await userEvent.type(input, 'Dust and Ninety Miles')
    await expect(input).toHaveValue('Dust and Ninety Miles')
  },
}
