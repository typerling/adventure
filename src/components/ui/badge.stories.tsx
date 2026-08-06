import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './badge'

const meta = {
  title: 'UI/Badge',
  component: Badge,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'],
    },
  },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Hard',
  },
}

// Play.tsx's difficulty chip on the campaign header — the concrete reason this component exists
// in this app, so it's worth a dedicated story matching that real usage.
export const Difficulty: Story = {
  args: {
    variant: 'secondary',
    children: 'Deadly',
  },
}

export const Variants: Story = {
  args: { children: 'Badge' },
  render: (args) => (
    <div className="flex flex-wrap gap-3">
      {(['default', 'secondary', 'destructive', 'outline'] as const).map((variant) => (
        <Badge key={variant} {...args} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
  ),
}
