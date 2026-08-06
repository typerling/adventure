import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { TurnPager, type TurnPagerPage } from './TurnPager'
import { splitNarrativeIntoBlocks } from '@/lib/ai/turnBlocks'

/** A small header line matching Play.tsx's real per-page header — "Turn N — you: <action>". */
function pageHeader(turn: number, action: string) {
  return (
    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      Turn {turn} — you: {action}
    </p>
  )
}

const HISTORY_NARRATIVES: Record<number, { action: string; narrative: string }> = {
  1: {
    action: 'push open the tavern door',
    narrative:
      'The tavern door creaks shut behind you. Lantern light pools on scarred wooden tables, and the murmur of a dozen conversations dies as heads turn your way.',
  },
  2: {
    action: 'approach the woman in the rust-colored coat',
    narrative:
      'She looks up as you cross the room. "Not many strangers make it this far south," she says, nodding at the empty seat across from her.',
  },
}

const LIVE_NARRATIVE =
  "You step into the sunken chapel. Dust hangs in the shafts of light from the collapsed roof, and somewhere below, water drips in a slow, patient rhythm.\n\n{{options}}\n\nThe silence presses in, waiting for you to choose."

function buildPages(onSelectOption: (label: string) => void): TurnPagerPage[] {
  return [
    {
      turn: 1,
      header: pageHeader(1, HISTORY_NARRATIVES[1].action),
      blocks: splitNarrativeIntoBlocks(HISTORY_NARRATIVES[1].narrative, []),
      // No onSelectOption — historical turns are read-only, matching TurnContent's existing
      // behavior and how Play.tsx only ever wires it up for the live/last turn.
    },
    {
      turn: 2,
      header: pageHeader(2, HISTORY_NARRATIVES[2].action),
      blocks: splitNarrativeIntoBlocks(HISTORY_NARRATIVES[2].narrative, []),
    },
    {
      turn: 3,
      header: pageHeader(3, 'search the altar for clues'),
      blocks: splitNarrativeIntoBlocks(LIVE_NARRATIVE, [
        { label: 'Search the altar for more clues' },
        { label: 'Ask about the key' },
        { label: 'Leave the chapel and head back to the market' },
      ]),
      onSelectOption,
    },
  ]
}

const meta = {
  title: 'App/TurnPager',
  component: TurnPager,
  tags: ['autodocs'],
  // Paging chrome (button sizing, page width, vertical scroll cap) differs meaningfully at `md`
  // — every story here is meaningful at both viewports, see CLAUDE.md's Storybook section.
  globals: { viewport: { value: 'mobile' } },
  args: {
    onCurrentIndexChange: fn(),
  },
} satisfies Meta<typeof TurnPager>

export default meta
type Story = StoryObj<typeof meta>

const livePageOnSelectOption = fn()

/** TurnPager starts on the newest (live) page — turn 3 of 3 — with its options interactive, the
 * "input-relevant state" a Next-page-doesn't-exist boundary and an active onSelectOption both
 * demonstrate. Mirrors what a player lands on immediately after acting. */
export const LivePageMobile: Story = {
  args: {
    pages: buildPages(livePageOnSelectOption),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText(/sunken chapel/)).toBeVisible())

    const next = canvas.getByRole('button', { name: 'Next turn' })
    const prev = canvas.getByRole('button', { name: 'Previous turn' })
    await waitFor(() => expect(next).toBeDisabled())
    expect(prev).toBeEnabled()

    const option = canvas.getByRole('button', { name: 'Search the altar for more clues' })
    await expect(option).toBeVisible()
    await userEvent.click(option)
    expect(livePageOnSelectOption).toHaveBeenCalledWith('Search the altar for more clues')
  },
}

export const LivePageDesktop: Story = {
  ...LivePageMobile,
  globals: { viewport: { value: 'desktop' } },
}

/** Navigated back to the very first turn — Previous is disabled (nothing further back to go),
 * Next is available to return toward the live page. Historical pages render prose only, no
 * option buttons. */
export const FirstPageMobile: Story = {
  args: {
    pages: buildPages(fn()),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const prev = canvas.getByRole('button', { name: 'Previous turn' })
    const next = canvas.getByRole('button', { name: 'Next turn' })
    // Starts on the live (last) page — page back twice to reach the first.
    await userEvent.click(prev)
    await userEvent.click(prev)

    await waitFor(() => expect(prev).toBeDisabled())
    await waitFor(() => expect(next).toBeEnabled())

    // Every page stays mounted in the DOM at once (that's what makes the horizontal scroll-snap
    // work) — so scoping to this specific page's container matters: an unscoped query would still
    // find the live page's option button sitting off-screen elsewhere in the same document.
    const firstPage = within(canvas.getByTestId('turn-page-1'))
    await expect(firstPage.getByText(/tavern door creaks shut/)).toBeVisible()
    // Read-only — TurnContent renders nothing for an options block without onSelectOption, so a
    // historical page has no buttons in it at all.
    expect(firstPage.queryByRole('button')).not.toBeInTheDocument()
  },
}

export const FirstPageDesktop: Story = {
  ...FirstPageMobile,
  globals: { viewport: { value: 'desktop' } },
}

/** The middle page — both Previous and Next are available. */
export const MiddlePageMobile: Story = {
  args: {
    pages: buildPages(fn()),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const prev = canvas.getByRole('button', { name: 'Previous turn' })
    const next = canvas.getByRole('button', { name: 'Next turn' })
    // Starts on the live (last) page — page back once to reach the middle one.
    await userEvent.click(prev)

    // Waiting on the group's own reported position, not just text visibility — every page is
    // always in the DOM (and thus "visible" per jest-dom, since nothing is display:none), so a
    // wait keyed on text alone would resolve immediately, before the scroll/observer actually
    // confirm the navigation landed.
    await waitFor(() => expect(canvas.getByRole('group')).toHaveAttribute('data-current-index', '1'))
    expect(prev).toBeEnabled()
    expect(next).toBeEnabled()
    const middlePage = within(canvas.getByTestId('turn-page-2'))
    await expect(middlePage.getByText(/rust-colored coat/)).toBeVisible()
  },
}

export const MiddlePageDesktop: Story = {
  ...MiddlePageMobile,
  globals: { viewport: { value: 'desktop' } },
}
