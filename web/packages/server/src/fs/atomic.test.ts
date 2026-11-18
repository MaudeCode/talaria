import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWriteText, atomicWriteTextAsync } from './atomic.js'

describe('atomic writes honour the umask for new files', () => {
  it('a new file is created under the process umask while an existing mode is preserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-atomic-'))
    const previous = process.umask(0o077)
    try {
      atomicWriteText(join(dir, 'fresh.json'), '{}')
      expect(statSync(join(dir, 'fresh.json')).mode & 0o777).toBe(0o600)
      writeFileSync(join(dir, 'open.json'), '{}', { mode: 0o644 })
      chmodSync(join(dir, 'open.json'), 0o644)
      atomicWriteText(join(dir, 'open.json'), '{"a":1}')
      expect(statSync(join(dir, 'open.json')).mode & 0o777).toBe(0o644)
      await atomicWriteTextAsync(join(dir, 'fresh-async.json'), '{}')
      expect(statSync(join(dir, 'fresh-async.json')).mode & 0o777).toBe(0o600)
      await atomicWriteTextAsync(join(dir, 'open.json'), '{"a":2}')
      expect(statSync(join(dir, 'open.json')).mode & 0o777).toBe(0o644)
    } finally {
      process.umask(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
