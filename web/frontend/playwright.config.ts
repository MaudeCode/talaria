import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against the Python server (`server.py`) serving the
 * committed `static/dist` build. `e2e/global-setup.ts` boots two isolated
 * servers (open, and password-protected) on the ports below and tears them
 * down in `e2e/global-teardown.ts`. Override the ports with HERMES_E2E_PORT.
 */
const port = Number(process.env.HERMES_E2E_PORT ?? 8797)
process.env.HERMES_E2E_BASE_URL = `http://127.0.0.1:${port}`
process.env.HERMES_E2E_AUTH_BASE_URL = `http://127.0.0.1:${port + 1}`

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: process.env.HERMES_E2E_BASE_URL,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // Mobile runs in Chromium too (CI installs only Chromium); the viewport matches an iPhone 13.
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
})
