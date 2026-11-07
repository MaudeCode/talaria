import * as fs from 'node:fs'
import { vi } from 'vitest'

/** The sync `node:fs` calls answered since the last `vi.clearAllMocks()`; needs `vi.mock('node:fs', { spy: true })` in the test file. */
export function syncFsCalls(): string[] {
  const spies: [string, unknown][] = [...Object.entries(fs).filter(([name]) => name.endsWith('Sync')), ['realpathSync.native', fs.realpathSync.native]]
  return spies.flatMap(([name, fn]) => (vi.isMockFunction(fn) && fn.mock.calls.length ? [name] : []))
}
