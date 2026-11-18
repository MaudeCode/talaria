import { expect, vi } from 'vitest'
import type { TestServer } from './harness.js'

/**
 * Settles every turn on `s`, the teardown drains they fire and any turn those drains start, such as the wakeup a
 * completion starts. It awaits those workers and drains, so a negative check after it covers a turn that would have
 * started, without waiting on a clock.
 */
export function settler(s: TestServer): () => Promise<void> {
  const drains = vi.spyOn(s.deps.completions, 'drainDeferred')
  const settle = async (): Promise<void> => {
    const runs = [...s.deps.registry.activeRuns.keys()]
    const fired = drains.mock.results.length
    await Promise.all(runs.map((stream) => s.deps.turns.finished(stream)))
    await Promise.allSettled(drains.mock.results.map((result) => result.value as Promise<number>))
    expect(runs.filter((stream) => s.deps.registry.activeRuns.has(stream)), 'a finished run left the registry').toEqual([])
    if (runs.length || drains.mock.results.length > fired) await settle()
  }
  return settle
}
