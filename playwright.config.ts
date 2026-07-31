import { defineConfig, devices } from '@playwright/test'

const PORT = 5183
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      // Any non-empty value satisfies isGoogleConfigured (src/lib/google/config.ts) — tests
      // never talk to real Google Identity Services, every request is intercepted, see
      // tests/mocks/googleApi.ts. Overriding here keeps tests independent of the developer's
      // real .env (no dependency on a real OAuth client existing).
      VITE_GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    },
  },
})
