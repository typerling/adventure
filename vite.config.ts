import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
})
