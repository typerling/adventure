import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { MemoryRouter } from 'react-router-dom'
import { Header } from './Header'
import { usePlayHeaderStore } from '@/store/playHeaderStore'

const DEMO_CONTEXT = {
  campaignId: 'demo-campaign',
  campaignName: 'Dust and Ninety Miles',
  showReadAloudToggle: true,
  turnLabel: 'Turn 4 · The saloon at the edge of Redrock',
}

const meta = {
  title: 'App/Header',
  component: Header,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/play/demo-campaign']}>
        <Story />
      </MemoryRouter>
    ),
  ],
  // The hamburger is the header's only nav treatment at every width now (no more BottomNav taking
  // over below `md`), so every story here is meaningful at both viewports — see CLAUDE.md's
  // Storybook section: a story that doesn't set one gets the addon's 1200x900 default, which would
  // silently skip mobile-only bugs.
  globals: { viewport: { value: 'mobile' } },
  loaders: [
    async () => {
      usePlayHeaderStore.setState({ context: null, readAloud: false })
      return {}
    },
  ],
} satisfies Meta<typeof Header>

export default meta
type Story = StoryObj<typeof meta>

/** No campaign open (Dashboard/NewCampaign) — the menu is sparse: Settings only, no Codex or
 * "Back to campaigns" (there's nowhere to go back to, and no campaign to open the Codex for). */
export const NoContextMobile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('link', { name: 'Adventure' })).toBeVisible()

    await userEvent.click(canvas.getByRole('button', { name: 'Menu' }))
    const body = within(canvasElement.ownerDocument.body)
    const settingsItem = await waitFor(() => {
      const el = body.getByRole('menuitem', { name: 'Settings' })
      expect(el).toBeVisible()
      return el
    })
    expect(settingsItem.getAttribute('href') ?? settingsItem.closest('a')?.getAttribute('href')).toBe('/settings')
    expect(body.queryByRole('menuitem', { name: 'Codex' })).not.toBeInTheDocument()
    expect(body.queryByRole('menuitem', { name: 'Back to campaigns' })).not.toBeInTheDocument()
  },
}

export const NoContextDesktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  play: NoContextMobile.play,
}

/** A campaign is open (Play/Codex/Settings) and the menu is closed — the campaign name shows in
 * place of "Adventure", plus the turn/location and read-aloud icons stand alone next to the
 * hamburger trigger rather than living inside the menu. */
export const CampaignContextMobile: Story = {
  loaders: [
    async () => {
      usePlayHeaderStore.setState({ context: DEMO_CONTEXT, readAloud: false })
      return {}
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('link', { name: 'Dust and Ninety Miles' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: DEMO_CONTEXT.turnLabel })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Read new turns aloud' })).toBeVisible()

    const body = within(canvasElement.ownerDocument.body)
    expect(body.queryByRole('menu')).not.toBeInTheDocument()
  },
}

export const CampaignContextDesktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  loaders: CampaignContextMobile.loaders,
  play: CampaignContextMobile.play,
}

/** Menu open with a campaign context — the full set: Codex, Settings, and "Back to campaigns"
 * (the labeled equivalent of the logo's existing link to Dashboard), in that order. */
export const CampaignContextMenuOpenMobile: Story = {
  loaders: [
    async () => {
      usePlayHeaderStore.setState({ context: DEMO_CONTEXT, readAloud: false })
      return {}
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Menu' }))

    const body = within(canvasElement.ownerDocument.body)
    const codexItem = await waitFor(() => {
      const el = body.getByRole('menuitem', { name: 'Codex' })
      expect(el).toBeVisible()
      return el
    })
    const settingsItem = body.getByRole('menuitem', { name: 'Settings' })
    const backItem = body.getByRole('menuitem', { name: 'Back to campaigns' })
    await expect(settingsItem).toBeVisible()
    await expect(backItem).toBeVisible()

    expect(codexItem.closest('a')?.getAttribute('href')).toBe('/codex/demo-campaign')
    expect(settingsItem.closest('a')?.getAttribute('href')).toBe('/settings/demo-campaign')
    expect(backItem.closest('a')?.getAttribute('href')).toBe('/')

    // Selecting an item closes the menu.
    await userEvent.click(codexItem)
    await waitFor(() => expect(body.queryByRole('menu')).not.toBeInTheDocument())
  },
}

export const CampaignContextMenuOpenDesktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  loaders: CampaignContextMenuOpenMobile.loaders,
  play: CampaignContextMenuOpenMobile.play,
}
