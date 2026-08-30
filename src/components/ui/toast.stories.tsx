import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { toast, Toaster } from './toast'
import { Button } from './button'

const meta = {
  title: 'UI/Toast (Toaster)',
  component: Toaster,
  tags: ['autodocs'],
  render: () => (
    <div className="flex flex-col gap-2">
      <Button onClick={() => toast.success('Turn applied.')}>Trigger success toast</Button>
      <Button variant="outline" onClick={() => toast.error("Text-to-speech isn't available — check Settings.")}>
        Trigger error toast
      </Button>
      <Toaster />
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

// The exact error copy Play.tsx shows when TTS isn't available — see Play.tsx's speak() handler.
export const ShowsErrorToast: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Trigger error toast' }))

    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(body.getByText("Text-to-speech isn't available — check Settings.")).toBeVisible(),
    )
  },
}

// Multiple toasts stacking is real, tested behavior this app depends on — several flows (e.g.
// Settings.tsx's save handlers) fire an error toast while a prior success toast may still be
// visible.
export const StacksMultipleToasts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Trigger success toast' }))
    await userEvent.click(canvas.getByRole('button', { name: 'Trigger error toast' }))

    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(body.getByText('Turn applied.')).toBeVisible())
    await waitFor(() =>
      expect(body.getByText("Text-to-speech isn't available — check Settings.")).toBeVisible(),
    )
  },
}
