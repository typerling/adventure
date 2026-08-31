import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { NpcVoicePicker } from './NpcVoicePicker'
import { Toaster } from '@/components/ui/toast'
import type { Npc } from '@/types/sheets'

/** A tiny, real, playable WAV blob — 8-bit PCM silence — so `new Audio(url).play()` in the
 * component under test actually succeeds in a real browser (this runs via
 * `@storybook/addon-vitest`'s real Chromium, not jsdom — see CLAUDE.md's Storybook section),
 * rather than needing to mock `window.Audio` itself. Long enough (2s) that a story's "Stop
 * preview of…" assertion isn't racing playback finishing on its own. */
function createSilentWavBlob(durationSeconds = 2): Blob {
  const sampleRate = 8000
  const numSamples = Math.floor(sampleRate * durationSeconds)
  const buffer = new ArrayBuffer(44 + numSamples)
  const view = new DataView(buffer)
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + numSamples, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  writeString(36, 'data')
  view.setUint32(40, numSamples, true)
  new Uint8Array(buffer, 44).fill(128) // 8-bit PCM silence is the midpoint, not 0
  return new Blob([buffer], { type: 'audio/wav' })
}

const UNCAST_NPC: Npc = {
  id: 'npc-1',
  name: 'Old Maren',
  description: 'the chapel caretaker',
  relationship: '',
  status: 'alive',
  lastSeenTurn: 3,
  voice: 'gravelly, clipped sentences',
  secrets: '',
  notes: '',
  detailFile: undefined,
  voiceId: '',
  voiceSpeed: 0,
  voiceLocked: false,
}

const AI_CAST_NPC: Npc = {
  ...UNCAST_NPC,
  id: 'npc-2',
  name: 'Harbormaster Voss',
  voiceId: 'am_adam',
  voiceLocked: false,
}

const LOCKED_NPC: Npc = {
  ...UNCAST_NPC,
  id: 'npc-3',
  name: 'Captain Reyes',
  voiceId: 'bm_george',
  voiceLocked: true,
}

const meta = {
  title: 'App/NpcVoicePicker',
  component: NpcVoicePicker,
  tags: ['autodocs'],
  // The Codex NPC list is real layout pressure at phone width (a per-row picker plus a preview
  // button next to name/status/description) — see CLAUDE.md's Storybook section on why every
  // story here sets a viewport rather than relying on the addon's desktop-only default.
  globals: { viewport: { value: 'mobile' } },
  decorators: [
    (Story) => (
      <div className="max-w-sm rounded-md border p-3 text-sm">
        <Story />
        <Toaster />
      </div>
    ),
  ],
  args: {
    npc: UNCAST_NPC,
    onSelect: fn(async () => {}),
    onClear: fn(async () => {}),
    previewVoice: fn(async () => createSilentWavBlob()),
  },
} satisfies Meta<typeof NpcVoicePicker>

export default meta
type Story = StoryObj<typeof meta>

/** No voice cast yet — "Set voice" is the only control, no "Clear override" (nothing to clear). */
export const NotCastMobile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Not cast yet')).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Set voice' })).toBeVisible()
    expect(canvas.queryByRole('button', { name: 'Clear override' })).not.toBeInTheDocument()
    expect(canvas.queryByText('Locked')).not.toBeInTheDocument()
  },
}

export const NotCastDesktop: Story = { ...NotCastMobile, globals: { viewport: { value: 'desktop' } } }

/** The AI already cast a voice but the player hasn't locked one in — shown distinctly from a
 * genuine player override so it's clear the AI is still free to recast this NPC later. */
export const AiCastMobile: Story = {
  args: { npc: AI_CAST_NPC },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Adam (AI-cast)')).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Set voice' })).toBeVisible()
    expect(canvas.queryByText('Locked')).not.toBeInTheDocument()
  },
}

export const AiCastDesktop: Story = { ...AiCastMobile, globals: { viewport: { value: 'desktop' } } }

/** A player-locked override — "Change voice" replaces "Set voice", and "Clear override" appears
 * to hand the character back to AI casting. */
export const LockedMobile: Story = {
  args: { npc: LOCKED_NPC },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('George')).toBeVisible()
    await expect(canvas.getByText('Locked')).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Change voice' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Clear override' })).toBeVisible()
  },
}

export const LockedDesktop: Story = { ...LockedMobile, globals: { viewport: { value: 'desktop' } } }

/** Full picker flow: open the dialog, preview a voice (a real, on-device-free WAV clip — see
 * `createSilentWavBlob`), stop it, then select a different voice and confirm it's handed to
 * `onSelect` and the dialog closes. Dialog content renders in a Radix portal, so queries after
 * opening scope to `document.body`, not `canvasElement` — see CLAUDE.md's Storybook section on
 * content that's genuinely unmounted (here, not yet opened) versus just off-screen. */
export const PickAndPreviewVoiceDesktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Set voice' }))

    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(body.getByRole('dialog')).toBeVisible())
    await expect(body.getByText('Choose a voice for Old Maren')).toBeVisible()

    // Every castable voice is listed, including one graded below D+ excluded (issue #107) — "Adam"
    // (F+) must NOT appear here, the same exclusion the AI's own casting pool respects.
    await expect(body.getByRole('button', { name: /^George/ })).toBeVisible()
    expect(body.queryByRole('button', { name: /^Adam/ })).not.toBeInTheDocument()

    await userEvent.click(body.getByRole('button', { name: 'Preview George' }))
    await waitFor(() => expect(body.getByRole('button', { name: 'Stop preview of George' })).toBeVisible())
    expect(args.previewVoice).toHaveBeenCalledWith('bm_george')
    await userEvent.click(body.getByRole('button', { name: 'Stop preview of George' }))
    await waitFor(() => expect(body.getByRole('button', { name: 'Preview George' })).toBeVisible())

    await userEvent.click(body.getByRole('button', { name: /^George/ }))
    await waitFor(() => expect(args.onSelect).toHaveBeenCalledWith('bm_george'))
    // A confirmed write closes the dialog — see NpcVoicePicker's doc comment on why there's no
    // separate "revert" state to manage: nothing renders ahead of the write confirming.
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument())
  },
}

export const PickAndPreviewVoiceMobile: Story = {
  ...PickAndPreviewVoiceDesktop,
  globals: { viewport: { value: 'mobile' } },
}

/** A failed write (`onSelect` rejects — offline, an expired token) surfaces as a `toast.error`
 * and the dialog stays open with the NPC's prior voice still shown as selected, rather than
 * closing as if the change had actually persisted. */
export const FailedSelectSurfacesToastDesktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  args: {
    npc: AI_CAST_NPC,
    onSelect: fn(async () => {
      throw new Error("Couldn't reach Google Sheets.")
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Set voice' }))
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(body.getByRole('dialog')).toBeVisible())

    await userEvent.click(body.getByRole('button', { name: /^George/ }))

    await waitFor(() => expect(canvas.getByText("Couldn't reach Google Sheets.")).toBeVisible())
    // Still open, and Adam (the NPC's actual, still-persisted voice) is still shown as current —
    // the failed pick never took effect.
    await expect(body.getByRole('dialog')).toBeVisible()
    await expect(canvas.getByText('Adam (AI-cast)')).toBeVisible()
  },
}
