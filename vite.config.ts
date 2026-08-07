/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'

// GitHub Pages can't set custom response headers (see CLAUDE.md's Deployment section and
// public/coi-serviceworker.js's doc comment), so the deployed site relies on that service worker
// to inject cross-origin isolation headers. Vite's own dev/preview servers CAN set headers
// directly, which is worth doing so `npm run dev`/`npm run preview` can be a faithful local
// stand-in for the deployed (isolated) site without needing the service worker's register-then-
// reload dance at all — e.g. to compare Kokoro's real load time with vs. without isolation on a
// real device (`VITE_COI_HEADERS=1 npm run dev`, verified to actually set the headers). Off by
// default so the normal dev/test workflow matches today's non-isolated baseline; the existing
// suite instead exercises the service worker itself directly (tests/coi-service-worker.spec.ts),
// since that's the mechanism actually used once deployed.
const coiHeaders =
  process.env.VITE_COI_HEADERS === '1'
    ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
    : undefined

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves a project site under https://<owner>.github.io/<repo>/, so every asset
  // URL needs that prefix. Set via VITE_BASE in the deploy workflow rather than hardcoded, so
  // local dev/preview stay at "/" and a different host (or a root-domain Pages site) needs no
  // code change. `index.html` picks this up through Vite's %BASE_URL% placeholder, and the
  // router through `import.meta.env.BASE_URL` — see src/App.tsx.
  base: process.env.VITE_BASE ?? '/',
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Component-level interaction tests (`npm run test:stories`) — runs each story's `play`
  // function through Vitest's browser mode with the Playwright provider, driven by
  // @storybook/addon-vitest against the Storybook config in .storybook/. See CLAUDE.md's
  // Commands section for the gotchas found writing these.
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.resolve(__dirname, '.storybook'),
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
