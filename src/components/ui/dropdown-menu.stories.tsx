import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Button } from './button'

const meta = {
  title: 'UI/DropdownMenu',
  component: DropdownMenu,
  tags: ['autodocs'],
} satisfies Meta<typeof DropdownMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Campaign actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Dust and Ninety Miles</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Open Codex</DropdownMenuItem>
        <DropdownMenuItem>Open Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Delete campaign</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
}

export const OpensAndSelects: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Open menu</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Open Codex</DropdownMenuItem>
        <DropdownMenuItem>Open Settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Open menu' }))

    const body = within(canvasElement.ownerDocument.body)
    // Same reasoning as dialog.stories.tsx's OpensAndCloses: Radix's open animation starts at
    // opacity 0, so wait for genuine visibility rather than just DOM presence.
    const item = await waitFor(() => {
      const el = body.getByRole('menuitem', { name: 'Open Codex' })
      expect(el).toBeVisible()
      return el
    })

    await userEvent.click(item)
    await waitFor(() => expect(body.queryByRole('menu')).not.toBeInTheDocument())
  },
}
