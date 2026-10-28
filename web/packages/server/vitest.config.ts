import { configDefaults, defineConfig } from 'vitest/config'

const stateDbLatencyTests = ['src/sessions/state-db-worker.test.ts']

export default defineConfig({
  test: {
    environment: 'node',
    // Shared CI runners stall individual HTTP tests past the 5 s default under two workers.
    testTimeout: 20_000,
    // Measure the event-loop budgets without another test file competing for the runner's CPU.
    projects: [
      { extends: true, test: { name: 'state-db-latency', include: stateDbLatencyTests, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'server', include: ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, ...stateDbLatencyTests], sequence: { groupOrder: 1 } } },
    ],
  },
})
