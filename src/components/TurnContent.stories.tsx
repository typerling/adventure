import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { TurnContent } from './TurnContent'
import { splitNarrativeIntoBlocks } from '@/lib/ai/turnBlocks'

const meta = {
  title: 'App/TurnContent',
  component: TurnContent,
  tags: ['autodocs'],
  // Every story here is meaningful at both viewports (narrative width/wrapping and the option
  // cards' layout both change at `md`) — see CLAUDE.md's Storybook section.
  globals: { viewport: { value: 'mobile' } },
  args: {
    onSelectOption: fn(),
  },
} satisfies Meta<typeof TurnContent>

export default meta
type Story = StoryObj<typeof meta>

const PROSE_ONLY_NARRATIVE = `The tavern door creaks shut behind you. Lantern light pools on scarred
wooden tables, and the murmur of a dozen conversations dies as heads turn your way.

A woman in a **rust-colored coat** leans against the far wall, watching you over the rim of her
cup.`

const INLINE_NARRATIVE = `You step through the sunken chapel's broken archway. Dust hangs in the
shafts of light from the collapsed roof, and somewhere below, water drips in a slow, patient
rhythm.

An altar stands at the far end, its surface carved with symbols you don't recognize — not quite
letters, not quite pictures.

{{options}}

The silence presses in, waiting for you to choose.`

const NO_PLACEHOLDER_NARRATIVE = `Old Maren sets down her cup and studies you for a long moment.
"You want the key," she says, "but keys like that one don't come free."`

const DUPLICATE_TOKEN_NARRATIVE = `The bridge sways underfoot.

{{options}}

You catch the far rail. {{options}} The rope creaks below you.`

const TOKEN_ONLY_NARRATIVE = `{{options}}`

const SAMPLE_OPTIONS = [
  { label: 'Search the altar for more clues' },
  { label: 'Ask Old Maren about the key' },
  { label: 'Leave the chapel and head back to the market', manus: 'Leave and head back to the market' },
]

/** Plain narrative with no options block at all — a historical (already acted-on) turn, or a
 * turn with zero suggested options. */
export const ProseOnlyMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(PROSE_ONLY_NARRATIVE, []),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/tavern door creaks shut/)).toBeVisible()
    // "rust-colored coat" renders as real emphasis, not literal asterisks.
    await expect(canvas.getByText('rust-colored coat')).toBeVisible()
    expect(canvas.queryByRole('button')).not.toBeInTheDocument()
  },
}

export const ProseOnlyDesktop: Story = {
  ...ProseOnlyMobile,
  globals: { viewport: { value: 'desktop' } },
}

/** The AI placed `{{options}}` mid-narrative — options render inline at that point, with prose
 * both before and after it in the same flow. */
export const InlineOptionsMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(INLINE_NARRATIVE, SAMPLE_OPTIONS),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/sunken chapel's broken archway/)).toBeVisible()
    const optionButton = canvas.getByRole('button', { name: /Search the altar for more clues/ })
    await expect(optionButton).toBeVisible()
    // Prose after the token still renders, i.e. the options aren't just appended at the end.
    await expect(canvas.getByText(/silence presses in/)).toBeVisible()

    await userEvent.click(optionButton)
    expect(args.onSelectOption).toHaveBeenCalledWith('Search the altar for more clues')
  },
}

export const InlineOptionsDesktop: Story = {
  ...InlineOptionsMobile,
  globals: { viewport: { value: 'desktop' } },
}

/** No `{{options}}` token in the narrative (a weaker backend, or a manual-mode paste that
 * predates the placeholder instruction) — the fallback path appends the options block after all
 * of the narrative instead. */
export const NoPlaceholderFallbackMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(NO_PLACEHOLDER_NARRATIVE, SAMPLE_OPTIONS),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const narrative = canvas.getByText(/keys like that one don't come free/)
    const optionButton = canvas.getByRole('button', { name: /Ask Old Maren about the key/ })
    await expect(narrative).toBeVisible()
    await expect(optionButton).toBeVisible()

    // The options come after the narrative in document order — this *is* the fallback behavior.
    const position = narrative.compareDocumentPosition(optionButton)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  },
}

export const NoPlaceholderFallbackDesktop: Story = {
  ...NoPlaceholderFallbackMobile,
  globals: { viewport: { value: 'desktop' } },
}

/** Without an `onSelectOption` handler, options blocks render nothing — this is how historical
 * turns in Play.tsx stay read-only even though they were built with the same options data. */
export const HistoricalTurnNoInteractionMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(INLINE_NARRATIVE, SAMPLE_OPTIONS),
    onSelectOption: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/sunken chapel's broken archway/)).toBeVisible()
    expect(canvas.queryByRole('button')).not.toBeInTheDocument()
  },
}

/** Edge case flagged in review: the AI is only ever instructed to place one `{{options}}` token,
 * but a repeated (or coincidentally duplicated) one shouldn't leak as literal, visible text in the
 * trailing prose — only the first occurrence is a real split point, the rest get stripped. */
export const DuplicateTokenNoLeakMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(DUPLICATE_TOKEN_NARRATIVE, SAMPLE_OPTIONS),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/bridge sways underfoot/)).toBeVisible()
    await expect(canvas.getByText(/rope creaks below you/)).toBeVisible()
    // Exactly one options block rendered — one set of buttons, not two.
    expect(canvas.getAllByRole('button')).toHaveLength(SAMPLE_OPTIONS.length)
    // The second token doesn't survive into the rendered prose as literal text.
    expect(canvasElement.textContent).not.toContain('{{options}}')
  },
}

/** Edge case flagged in review: a narrative that's *only* the token (nothing before or after) —
 * no empty prose block should render, just the options. */
export const TokenOnlyNarrativeMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(TOKEN_ONLY_NARRATIVE, SAMPLE_OPTIONS),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: /Search the altar for more clues/ })).toBeVisible()
    // No stray prose block/paragraph rendered around the options.
    expect(canvasElement.querySelectorAll('p')).toHaveLength(0)
  },
}

/** Edge case flagged in review: zero options with the token still present — the split position is
 * preserved (prose before/after stays split, doesn't silently rejoin into one block) even though
 * there's nothing to render for the options block itself. */
export const EmptyOptionsWithTokenMobile: Story = {
  args: {
    blocks: splitNarrativeIntoBlocks(INLINE_NARRATIVE, []),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/sunken chapel's broken archway/)).toBeVisible()
    await expect(canvas.getByText(/silence presses in/)).toBeVisible()
    expect(canvas.queryByRole('button')).not.toBeInTheDocument()
  },
}
