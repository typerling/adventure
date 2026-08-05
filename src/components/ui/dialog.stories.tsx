import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog'
import { Button } from './button'

const meta = {
  title: 'UI/Dialog',
  component: Dialog,
  tags: ['autodocs'],
} satisfies Meta<typeof Dialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Where you are</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Turn 4 · The saloon at the edge of Redrock</DialogTitle>
          <DialogDescription>A quiet gate-town on the edge of the dust flats.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
}

export const WithFooterActions: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open turn dialog</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl md:max-w-2xl lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Claude is narrating your turn</DialogTitle>
          <DialogDescription>Sent directly to Claude with your API key — no copy/paste needed.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Retry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
}

// Regression coverage for the same bug play-dialog-responsive.spec.ts guards against at the e2e
// level (an unprefixed max-w-2xl silently losing to the base sm:max-w-sm) — cheaper to catch here
// since it needs no campaign/mock backend, just the Dialog itself.
export const OpensAndCloses: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Manual DM turn</DialogTitle>
          <DialogDescription>Copy this prompt into claude.ai or chatgpt.com.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Open' }))

    const body = within(canvasElement.ownerDocument.body)
    // Radix's open animation (fade-in/zoom-in) starts at opacity 0 — waitFor rather than a bare
    // assertion so this doesn't race the animation's first frame.
    await waitFor(() => expect(body.getByRole('dialog')).toBeVisible())
    await expect(body.getByText('Manual DM turn')).toBeVisible()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument())
  },
}
