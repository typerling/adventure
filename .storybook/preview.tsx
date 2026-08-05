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

const preview: Preview = {
  parameters: {
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
  },

  initialGlobals: {
    theme: 'system',
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
