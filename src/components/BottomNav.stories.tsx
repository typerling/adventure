import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
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
    // The nav is `md:hidden` (mobile-only — the top header takes over on wider screens, see
    // BottomNav's own doc comment), but Storybook's Vitest addon pins its browser instance to a
    // desktop-sized viewport regardless of story/vite config (confirmed empirically — an
    // `instances[].viewport` override in vite.config.ts's browser test config had no effect), so
    // the nav is *actually* `display: none` while these stories run there. Docs note only; the
    // interaction tests below query by href via the raw DOM rather than getByRole for exactly
    // this reason — display:none elements are excluded from the accessibility tree, so
    // getByRole('link') finds nothing even though the markup is right there.
    docs: {
      description: {
        component: 'Mobile-only (`md:hidden`) — shrink the canvas below 768px to see it in the docs/canvas iframe.',
      },
    },
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

export const OnPlayRoute: Story = {
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/play/demo-campaign']}>
        <Story />
      </MemoryRouter>
    ),
  ],
  play: async ({ canvasElement }) => {
    const adventureLink = canvasElement.querySelector('a[href="/play/demo-campaign"]')
    const codexLink = canvasElement.querySelector('a[href="/codex/demo-campaign"]')
    await expect(adventureLink).toHaveClass(/text-primary/)
    await expect(codexLink).not.toHaveClass(/text-primary/)
  },
}

export const OnCodexRoute: Story = {
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/codex/demo-campaign']}>
        <Story />
      </MemoryRouter>
    ),
  ],
  play: async ({ canvasElement }) => {
    const codexLink = canvasElement.querySelector('a[href="/codex/demo-campaign"]')
    await expect(codexLink).toHaveClass(/text-primary/)
  },
}

export const NoCampaignContextRendersNothing: Story = {
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/play/demo-campaign']}>
        <Story />
      </MemoryRouter>
    ),
  ],
  loaders: [
    async () => {
      usePlayHeaderStore.setState({ context: null })
      return {}
    },
  ],
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('nav')).not.toBeInTheDocument()
  },
}
