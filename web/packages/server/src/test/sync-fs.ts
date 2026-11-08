import * as fs from 'node:fs'
import { vi } from 'vitest'

/** The sync `node:fs` calls answered since the last `vi.clearAllMocks()`; needs `vi.mock('node:fs', { spy: true })` in the test file. */
export function syncFsCalls(): string[] {
  const spies: [string, unknown][] = [...Object.entries(fs).filter(([name]) => name.endsWith('Sync')), ['realpathSync.native', fs.realpathSync.native]]
  return spies.flatMap(([name, fn]) => (vi.isMockFunction(fn) && fn.mock.calls.length ? [name] : []))
}

/** Run `work` while a `setImmediate` chain counts event-loop turns; a call that blocks the loop throughout counts none. */
export async function loopTurnsDuring<T>(work: () => Promise<T> | T): Promise<{ value: T; turns: number }> {
  let turns = 0
  let running = true
  const turn = (): void => { if (running) { turns += 1; setImmediate(turn) } }
  setImmediate(turn)
  try {
    const value = await work()
    return { value, turns }
  } finally {
    running = false
  }
}
