import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { MemoryRouter } from 'react-router-dom'
import { BottomNav } from './BottomNav'
import { usePlayHeaderStore } from '@/store/playHeaderStore'

const DEMO_CONTEXT = {
  campaignId: 'demo-campaign',
  campaignName: 'Dust and Ninety Miles',
  showReadAloudToggle: false,
  turnLabel: null,
}

const meta = {
  title: 'App/BottomNav',
  component: BottomNav,
  tags: ['autodocs'],
  parameters: {
    // This nav only exists below Tailwind's `md` (it's `md:hidden` — the top header takes over
    // campaign navigation on wider screens, see BottomNav's own doc comment). At the addon's
    // default 1200px viewport it is genuinely `display: none`, which also removes it from the
    // accessibility tree, so getByRole would find nothing. Every story here therefore runs at the
    // mobile viewport; HiddenAboveBreakpoint below overrides it to assert the other half.
    viewport: { defaultViewport: 'mobile' },
  },
  // BottomNav renders nothing until a campaign context is registered in the shared header store
  // (see playHeaderStore's doc comment — Play/Codex/Settings each set this on mount). A loader,
  // not a decorator's useEffect: loaders are guaranteed to resolve *before* the story's first
  // render, whereas an effect fires *after* mount.
  loaders: [
    async () => {
      usePlayHeaderStore.setState({ context: DEMO_CONTEXT })
      return {}
    },
  ],
} satisfies Meta<typeof BottomNav>

export default meta
type Story = StoryObj<typeof meta>

function routeDecorator(path: string) {
  return (Story: React.ComponentType) => (
    <MemoryRouter initialEntries={[path]}>
      <Story />
    </MemoryRouter>
  )
}

export const OnPlayRoute: Story = {
  decorators: [routeDecorator('/play/demo-campaign')],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // getByRole works here precisely because the mobile viewport keeps the nav displayed.
    const adventureLink = canvas.getByRole('link', { name: /Adventure/ })
    await expect(adventureLink).toBeVisible()
    await expect(adventureLink).toHaveClass(/text-primary/)
    await expect(canvas.getByRole('link', { name: /Codex/ })).not.toHaveClass(/text-primary/)
  },
}

export const OnCodexRoute: Story = {
  decorators: [routeDecorator('/codex/demo-campaign')],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('link', { name: /Codex/ })).toHaveClass(/text-primary/)
    await expect(canvas.getByRole('link', { name: /Adventure/ })).not.toHaveClass(/text-primary/)
  },
}

/** The `md:hidden` half of the contract: above the breakpoint this nav must disappear entirely,
 * or a desktop user would get both it *and* the header's Codex/Settings icons (which are
 * `hidden md:inline-flex` — the two are deliberately complementary, see App.tsx's Header). */
export const HiddenAboveBreakpoint: Story = {
  parameters: { viewport: { defaultViewport: 'desktop' } },
  decorators: [routeDecorator('/play/demo-campaign')],
  play: async ({ canvasElement }) => {
    const nav = canvasElement.querySelector('nav')
    // Still rendered in the DOM — hidden by CSS, not unmounted...
    await expect(nav).toBeInTheDocument()
    // ...and genuinely not visible, which is the part that actually matters.
    await expect(nav).not.toBeVisible()
  },
}

export const NoCampaignContextRendersNothing: Story = {
  decorators: [routeDecorator('/play/demo-campaign')],
  loaders: [
    async () => {
      usePlayHeaderStore.setState({ context: null })
      return {}
    },
  ],
  play: async ({ canvasElement }) => {
    // Not merely hidden this time — the component returns null before rendering any nav at all.
    await expect(canvasElement.querySelector('nav')).not.toBeInTheDocument()
  },
}
