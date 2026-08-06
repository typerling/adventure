import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { Mic } from 'lucide-react'
import { Button } from './button'

const meta = {
  title: 'UI/Button',
  component: Button,
  tags: ['autodocs'],
  args: {
    onClick: fn(),
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'],
    },
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'],
    },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Act',
  },
}

export const Variants: Story = {
  args: { children: 'Button' },
  render: (args) => (
    <div className="flex flex-wrap gap-3">
      {(['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const).map((variant) => (
        <Button key={variant} {...args} variant={variant}>
          {variant}
        </Button>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  args: { children: 'Button' },
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <Button {...args} size="xs">
        xs
      </Button>
      <Button {...args} size="sm">
        sm
      </Button>
      <Button {...args} size="default">
        default
      </Button>
      <Button {...args} size="lg">
        lg
      </Button>
      <Button {...args} size="icon" aria-label="Icon button">
        <Mic />
      </Button>
    </div>
  ),
}

export const Disabled: Story = {
  args: {
    children: 'Can’t act right now',
    disabled: true,
  },
}

// Play.tsx uses exactly this shape for the mic toggle — a plain icon button whose look flips
// with a boolean, so it's worth locking down as its own story+test rather than only exercising
// it indirectly through Play's own specs.
export const IconToggle: Story = {
  args: {
    variant: 'default',
    size: 'icon',
    'aria-label': 'Speak your action',
    children: <Mic />,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole('button', { name: 'Speak your action' })
    await userEvent.click(button)
    await expect(args.onClick).toHaveBeenCalledOnce()
  },
}

export const Click: Story = {
  args: {
    children: 'Click me',
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole('button', { name: 'Click me' })
    await userEvent.click(button)
    await expect(args.onClick).toHaveBeenCalledOnce()
  },
}
