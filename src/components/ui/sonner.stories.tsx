import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { toast } from 'sonner'
import { Toaster } from './sonner'
import { Button } from './button'

const meta = {
  title: 'UI/Sonner (Toaster)',
  component: Toaster,
  tags: ['autodocs'],
  render: (args) => (
    <div className="flex flex-col gap-2">
      <Button onClick={() => toast.success('Turn applied.')}>Trigger success toast</Button>
      <Button variant="outline" onClick={() => toast.error("Text-to-speech isn't available — check Settings.")}>
        Trigger error toast
      </Button>
      <Toaster {...args} />
    </div>
  ),
} satisfies Meta<typeof Toaster>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// The exact success copy Play.tsx shows once a turn is applied — see submitReply's toast.success
// call in useCampaign.ts.
export const ShowsToast: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Trigger success toast' }))

    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(body.getByText('Turn applied.')).toBeVisible())
  },
}
