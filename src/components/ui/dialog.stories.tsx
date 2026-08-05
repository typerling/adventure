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

/** The turn dialog's real responsive class stack, as used in Play.tsx. */
function TurnDialog() {
  return (
    <Dialog defaultOpen>
      <DialogContent className="sm:max-w-xl md:max-w-2xl lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Manual DM turn</DialogTitle>
          <DialogDescription>Copy this prompt into claude.ai or chatgpt.com.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Component-level counterpart to tests/play-dialog-responsive.spec.ts, which guards a real bug:
 * the dialog's own `max-w-2xl` (unprefixed) silently lost to the base component's `sm:max-w-sm`,
 * because Tailwind orders responsive utilities after unprefixed ones — so on desktop the turn
 * dialog was capped at ~384px rather than the ~672px the className implied. Fixed by giving each
 * breakpoint its own explicit override.
 *
 * Worth having here as well as at e2e: this needs no campaign, no mocked Drive/Sheets backend and
 * no turn-loop setup, just the Dialog — and it sets the viewport *before* the dialog opens rather
 * than resizing an already-open one, which is what makes the e2e version of this timing-sensitive.
 */
export const NarrowOnMobile: Story = {
  parameters: { viewport: { defaultViewport: 'mobile' } },
  render: () => <TurnDialog />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await waitFor(() => {
      const el = body.getByRole('dialog')
      expect(el).toBeVisible()
      return el
    })
    const { width } = dialog.getBoundingClientRect()
    // max-w-[calc(100%-2rem)] applies (no sm:/md:/lg: at 390px), so it's near-full-width with a
    // 1rem gutter each side — never edge-to-edge, and never a fixed tiny box.
    expect(width).toBeLessThan(390)
    expect(width).toBeGreaterThan(300)
  },
}

export const WiderOnDesktop: Story = {
  parameters: { viewport: { defaultViewport: 'desktop' } },
  render: () => <TurnDialog />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await waitFor(() => {
      const el = body.getByRole('dialog')
      expect(el).toBeVisible()
      return el
    })
    const { width } = dialog.getBoundingClientRect()
    // Previously capped at ~384px (sm:max-w-sm) regardless of viewport — md:max-w-2xl now wins.
    expect(width).toBeGreaterThan(600)
  },
}
