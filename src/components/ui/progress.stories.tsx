import type { Meta, StoryObj } from '@storybook/react-vite'
import { Progress } from './progress'

const meta = {
  title: 'UI/Progress',
  component: Progress,
  tags: ['autodocs'],
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100, step: 1 } },
  },
  args: {
    value: 40,
  },
  render: (args) => (
    <div className="w-64">
      <Progress {...args} />
    </div>
  ),
} satisfies Meta<typeof Progress>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { value: 0 },
}

// Local-model download progress, as shown in Play.tsx's generation status line.
export const DownloadInProgress: Story = {
  args: { value: 62 },
}

export const Complete: Story = {
  args: { value: 100 },
}
