import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { LogoMark } from './LogoMark'

/**
 * Issue #27: the logo used to be a raster crop of `public/icon-512.png` (a solid cream-square
 * background baked in), which looked like a sticker sitting on top of the header rather than part
 * of it. `LogoMark` is a transparent-background vector trace of that same illustration with no
 * hardcoded color — see its own doc comment for the currentColor mechanism this relies on to pick
 * up the right stroke color in each theme automatically, the same way every lucide-react icon
 * elsewhere in this app already does.
 *
 * Rendered here against the app's real card background at `size-7` (28px) — the exact size and
 * context `Header.tsx` actually uses, and the size most likely to reveal fringing or
 * over-simplified linework if the potrace vectorization hadn't held up small. Pair with the PR's
 * real Playwright screenshots of the actual header for full-page placement.
 */
const meta = {
  title: 'App/LogoMark',
  component: LogoMark,
  tags: ['autodocs'],
  args: { className: 'size-7' },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-card/60 p-4">
        <Story />
        <span className="font-heading text-lg font-medium text-foreground">Adventure</span>
      </div>
    ),
  ],
} satisfies Meta<typeof LogoMark>

export default meta
type Story = StoryObj<typeof meta>

/** Light theme — dark brown/black strokes (this app's `--foreground` in light mode), legible
 * against the parchment header background. */
export const Light: Story = {
  globals: { theme: 'light' },
  play: async ({ canvasElement }) => {
    // The mark is `aria-hidden` (it's decorative — the "Adventure" text next to it, or the link's
    // own title/aria-label in Header.tsx, carries the label), so query the element directly
    // rather than through an accessible-role lookup.
    const el = canvasElement.querySelector('svg')
    await expect(el).toBeVisible()
    // A real computed-style read confirming currentColor resolved to this app's actual light-theme
    // `--foreground` token (src/index.css's `:root`) — not a hardcoded RGB snapshot, since this
    // Chromium build reports oklch() computed values verbatim rather than resolving to rgb().
    await expect(getComputedStyle(el as SVGSVGElement).color).toBe('oklch(0.28 0.025 75)')
  },
}

/** Dark theme — light cream strokes (this app's `--foreground` in dark mode), legible against the
 * dark header background. Same SVG asset as Light — only the inherited `color` differs, via
 * `.dark`'s `--foreground` override in `src/index.css`. */
export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    const el = canvasElement.querySelector('svg')
    await expect(el).toBeVisible()
    // Same asset, this app's actual dark-theme `--foreground` token (`.dark` in src/index.css) —
    // confirms the swap is real, not just that *some* color resolved.
    await expect(getComputedStyle(el as SVGSVGElement).color).toBe('oklch(0.92 0.02 85)')
  },
}
