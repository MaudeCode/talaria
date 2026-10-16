import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { JsonStorage } from './json.js'
import { runSessionBackendConformance } from './conformance.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>(), renameSync: vi.fn((await original<typeof fs>()).renameSync) }))

runSessionBackendConformance('JSON', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'talaria-json-conformance-'))
  return {
    storage: new JsonStorage({ directory, now: () => Date.now() / 1000, stampingSince: () => 0 }),
    failNextWrite: () => { vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('injected publication failure') }) },
    cleanup: () => { fs.rmSync(directory, { recursive: true, force: true }) },
  }
})
