import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Shared CI runners stall individual HTTP tests past the 5 s default under two workers.
    testTimeout: 20_000,
  },
})
