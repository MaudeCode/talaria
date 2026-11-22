import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadInstanceId } from './instance.js'

describe('loadInstanceId (TAL-2663)', () => {
  const dirs: string[] = []
  const stateDir = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-instance-'))); dirs.push(dir); return dir }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('mints a private ID once and returns it on every later start from the same state directory', () => {
    const dir = stateDir()
    const id = loadInstanceId(dir)
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(statSync(join(dir, 'instance_id')).mode & 0o777).toBe(0o600)
    expect(loadInstanceId(dir)).toBe(id)
  })

  it('two fresh state directories get different IDs', () => {
    expect(loadInstanceId(stateDir())).not.toBe(loadInstanceId(stateDir()))
  })
})
