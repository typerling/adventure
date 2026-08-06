import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

const meta = {
  title: 'UI/Tabs',
  component: Tabs,
  tags: ['autodocs'],
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

// Matches Codex.tsx's tab layout — Inventory, Stats/Skills, NPCs, Monsters, Lore, Timeline/Quests.
export const Default: Story = {
  render: () => (
    <Tabs defaultValue="inventory" className="w-96">
      <TabsList>
        <TabsTrigger value="inventory">Inventory</TabsTrigger>
        <TabsTrigger value="npcs">NPCs</TabsTrigger>
        <TabsTrigger value="lore">Lore</TabsTrigger>
      </TabsList>
      <TabsContent value="inventory" className="p-2 text-sm text-muted-foreground">
        A weathered map, three silver coins, a canteen half full of stale water.
      </TabsContent>
      <TabsContent value="npcs" className="p-2 text-sm text-muted-foreground">
        Kessk — gate-warden, wary of strangers.
      </TabsContent>
      <TabsContent value="lore" className="p-2 text-sm text-muted-foreground">
        Redrock was a mining town before the wells ran dry.
      </TabsContent>
    </Tabs>
  ),
}

export const LineVariant: Story = {
  render: () => (
    <Tabs defaultValue="inventory" className="w-96">
      <TabsList variant="line">
        <TabsTrigger value="inventory">Inventory</TabsTrigger>
        <TabsTrigger value="npcs">NPCs</TabsTrigger>
      </TabsList>
      <TabsContent value="inventory" className="p-2 text-sm text-muted-foreground">
        Inventory contents.
      </TabsContent>
      <TabsContent value="npcs" className="p-2 text-sm text-muted-foreground">
        NPC roster.
      </TabsContent>
    </Tabs>
  ),
}

export const SwitchesTabs: Story = {
  render: () => (
    <Tabs defaultValue="inventory" className="w-96">
      <TabsList>
        <TabsTrigger value="inventory">Inventory</TabsTrigger>
        <TabsTrigger value="npcs">NPCs</TabsTrigger>
      </TabsList>
      <TabsContent value="inventory">Inventory contents</TabsContent>
      <TabsContent value="npcs">NPC roster</TabsContent>
    </Tabs>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Inventory contents')).toBeVisible()

    await userEvent.click(canvas.getByRole('tab', { name: 'NPCs' }))
    await expect(canvas.getByText('NPC roster')).toBeVisible()
    await expect(canvas.getByRole('tab', { name: 'NPCs' })).toHaveAttribute('data-state', 'active')
  },
}
