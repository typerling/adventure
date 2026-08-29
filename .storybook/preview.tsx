import type { Preview } from '@storybook/react-vite'
import { useEffect } from 'react'
import '../src/index.css'

// Mirrors src/index.css's `.dark`/`.light` classes and system-preference fallback (see App.tsx —
// nothing in the app itself toggles a class yet) so stories can be previewed in either theme
// regardless of the host OS setting.
function WithTheme(Story: React.ComponentType, context: { globals: { theme?: string } }) {
  const theme = context.globals.theme ?? 'system'
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    if (theme !== 'system') root.classList.add(theme)
  }, [theme])
  return <Story />
}

/**
 * Named around this app's own layout breakpoint rather than specific devices: everything
 * responsive here keys off Tailwind's `md` (768px). So the only distinction that matters is
 * "below md" vs "above md", and these two sit safely either side of it.
 *
 * These are real viewport resizes, not CSS scaling: `@storybook/addon-vitest` passes the resolved
 * width/height to Vitest browser-mode's `page.viewport()`, so `md:` variants and media queries
 * genuinely apply (or don't) during `npm run test:stories` — which is what makes a story able to
 * assert mobile-only/desktop-only behavior at all.
 */
const VIEWPORTS = {
  mobile: {
    name: 'Mobile (below md)',
    styles: { width: '390px', height: '844px' },
    type: 'mobile',
  },
  desktop: {
    name: 'Desktop (above md)',
    styles: { width: '1200px', height: '900px' },
    type: 'desktop',
  },
} as const

const preview: Preview = {
  parameters: {
    viewport: {
      options: VIEWPORTS,
    },

    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo',
    },

    backgrounds: {
      // The app's parchment background is a body-level gradient (src/index.css), not a flat
      // fill, so Storybook's own background swatches would fight it — disable rather than offer
      // a control that can't actually match what components look like in the real app.
      disable: true,
    },
  },

  globalTypes: {
    theme: {
      description: 'Light/dark theme',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'system', title: 'System' },
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },

    // daisyUI theming review (issue #28 Phase 1). Deliberately a *second*, independent global
    // rather than folded into `theme` above: `theme` toggles the `.dark`/`.light` class real
    // shadcn/Radix components (and every other story in this file) still key off, while this one
    // drives daisyUI's `data-theme` attribute, a different mechanism with a different value shape
    // (named themes, not just light/dark) that only src/components/daisyui-preview's stories
    // consume. No global decorator reads this — see DaisyPreview.stories.tsx's own
    // `WithDaisyTheme` decorator for why it's scoped there instead of applied here for every
    // story.
    daisyTheme: {
      description: 'daisyUI theme (Phase 1 preview — src/components/daisyui-preview only)',
      toolbar: {
        title: 'daisyUI theme',
        icon: 'paintbrush',
        items: [
          { value: 'system', title: 'System' },
          { value: 'adventure-light', title: 'Adventure Light' },
          { value: 'adventure-dark', title: 'Adventure Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },

  initialGlobals: {
    theme: 'system',
    daisyTheme: 'system',
  },

  decorators: [
    WithTheme,
    (Story) => (
      <div className="bg-background p-6 font-sans text-foreground">
        <Story />
      </div>
    ),
  ],
}

export default preview
