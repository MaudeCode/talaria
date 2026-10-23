import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { paraglideLocaleSplit } from './src/i18n/localeSplit'

export default defineConfig({
  plugins: [viteReact({ compiler: true }), paraglideLocaleSplit('./src/paraglide')],
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // The shared CI pool can freeze a worker for seconds (TAL-320); one retry
    // absorbs that without masking tests that fail locally.
    retry: process.env.CI ? 1 : 0,
  },
})
