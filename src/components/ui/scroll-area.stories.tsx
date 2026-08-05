import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, waitFor, within } from 'storybook/test'
import { ScrollArea } from './scroll-area'

const meta = {
  title: 'UI/ScrollArea',
  component: ScrollArea,
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollArea>

export default meta
type Story = StoryObj<typeof meta>

const turns = Array.from({ length: 12 }, (_, i) => i + 1)

// Matches Play.tsx's story log: a fixed-height viewport (h-[50vh] there, capped smaller here for
// the docs canvas) with turns stacked inside, scrolling once content overflows it.
export const Default: Story = {
  render: () => (
    <ScrollArea className="h-64 w-96 rounded-lg border">
      <div className="flex flex-col gap-4 p-4">
        {turns.map((t) => (
          <p key={t} className="font-serif text-sm leading-relaxed">
            Turn {t} — the dust settles over Redrock as the gate creaks shut behind you.
          </p>
        ))}
      </div>
    </ScrollArea>
  ),
}

export const ContentFitsNoScroll: Story = {
  render: () => (
    <ScrollArea className="h-64 w-96 rounded-lg border">
      <div className="p-4">
        <p className="font-serif text-sm leading-relaxed">No story yet — describe your first action below to begin.</p>
      </div>
    </ScrollArea>
  ),
}

export const OverflowsAndScrolls: Story = {
  render: () => (
    <ScrollArea className="h-64 w-96 rounded-lg border">
      <div className="flex flex-col gap-4 p-4">
        {turns.map((t) => (
          <p key={t} id={`turn-${t}`} className="font-serif text-sm leading-relaxed">
            Turn {t} — the dust settles over Redrock as the gate creaks shut behind you.
          </p>
        ))}
      </div>
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const viewport = canvasElement.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement

    // The first turn is in view and the last one isn't — that's the point of a capped-height,
    // scrollable log (the content overflows rather than stretching the container).
    await expect(canvas.getByText(/^Turn 1 —/)).toBeVisible()
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight)
    const lastTurn = canvasElement.querySelector('#turn-12')!
    expect(lastTurn.getBoundingClientRect().top).toBeGreaterThan(viewport.getBoundingClientRect().bottom)

    // ...and scrolling to it actually moves the viewport, rather than the page around it.
    lastTurn.scrollIntoView()
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0))
    await expect(canvas.getByText(/^Turn 12 —/)).toBeVisible()
  },
}
