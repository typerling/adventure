/// <reference types="vitest/config" />
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'

const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves a project site under https://<owner>.github.io/<repo>/, so every asset
  // URL needs that prefix. Set via VITE_BASE in the deploy workflow rather than hardcoded, so
  // local dev/preview stay at "/" and a different host (or a root-domain Pages site) needs no
  // code change. `index.html` picks this up through Vite's %BASE_URL% placeholder, and the
  // router through `import.meta.env.BASE_URL` — see src/App.tsx.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Component-level interaction tests (`npm run test:stories`) — runs each story's `play`
  // function through Vitest's browser mode with the Playwright provider, driven by
  // @storybook/addon-vitest against the Storybook config in .storybook/. See CLAUDE.md's
  // Commands section for the two non-obvious gotchas found writing these (Radix's open-animation
  // opacity, and this browser instance's fixed desktop viewport).
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          // The plugin will run tests for the stories defined in your Storybook config
          // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
          storybookTest({
            configDir: path.join(dirname, '.storybook'),
          }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
