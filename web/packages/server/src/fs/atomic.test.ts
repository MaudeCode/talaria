import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteText, atomicWriteTextAsync, writeFully, writeFullyAsync } from './atomic.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'talaria-atomic-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('atomicWriteText', () => {
  it('loops over short writes so a rename never publishes a truncated file', () => {
    // A writer that accepts at most 5 bytes per call (disk pressure, interrupted syscalls) still yields the full text.
    const target = join(dir, 'short.json')
    const text = JSON.stringify({ payload: 'x'.repeat(1000), done: true })
    const fd = openSync(target, 'w')
    const calls: number[] = []
    writeFully(fd, text, (f, buffer, offset, length) => { const n = Math.min(5, length); calls.push(n); return writeSync(f, buffer, offset, n) })
    closeSync(fd)
    expect(readFileSync(target, 'utf8')).toBe(text)
    expect(calls.length).toBeGreaterThan(200)
    // A writer that makes no progress is an error, never a silent prefix.
    const stuck = openSync(join(dir, 'stuck.json'), 'w')
    expect(() => { writeFully(stuck, text, () => 0) }).toThrow(/short write/)
    closeSync(stuck)
  })

  it('replaces contents without temp debris and creates new files', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"theme": "old"}')
    atomicWriteText(target, '{"theme": "new"}')
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "new"}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
    atomicWriteText(join(dir, 'fresh.json'), '{"created": true}')
    expect(readFileSync(join(dir, 'fresh.json'), 'utf8')).toBe('{"created": true}')
  })

  it('preserves a hardened 0600 mode', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"password_hash": "x"}')
    chmodSync(target, 0o600)
    atomicWriteText(target, '{"password_hash": "y"}')
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('writes through a symlink to its referent', () => {
    mkdirSync(join(dir, 'real'))
    mkdirSync(join(dir, 'link'))
    const target = join(dir, 'real', 'settings.json')
    const link = join(dir, 'link', 'settings.json')
    writeFileSync(target, '{"theme": "old"}')
    symlinkSync(target, link)
    atomicWriteText(link, '{"theme": "new"}')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "new"}')
    expect(readdirSync(join(dir, 'link'))).toEqual(['settings.json'])
  })

  it('leaves the original intact when the write fails before the rename', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"theme": "keep-me"}')
    expect(() => { atomicWriteText(join(dir, 'missing-dir', 'settings.json'), '{}') }).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "keep-me"}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

describe('atomicWriteTextAsync', () => {
  it('loops over short writes so a rename never publishes a truncated file', async () => {
    const target = join(dir, 'short.json')
    const text = JSON.stringify({ payload: 'x'.repeat(1000), done: true })
    const handle = await open(target, 'w')
    const calls: number[] = []
    await writeFullyAsync(handle, text, async (h, buffer, offset, length) => { const n = Math.min(5, length); calls.push(n); return (await h.write(buffer, offset, n)).bytesWritten })
    await handle.close()
    expect(readFileSync(target, 'utf8')).toBe(text)
    expect(calls.length).toBeGreaterThan(200)
    const stuck = await open(join(dir, 'stuck.json'), 'w')
    await expect(writeFullyAsync(stuck, text, () => Promise.resolve(0))).rejects.toThrow(/short write/)
    await stuck.close()
  })

  it('replaces contents without temp debris and creates new files', async () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"theme": "old"}')
    await atomicWriteTextAsync(target, '{"theme": "new"}')
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "new"}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
    await atomicWriteTextAsync(join(dir, 'fresh.json'), '{"created": true}')
    expect(readFileSync(join(dir, 'fresh.json'), 'utf8')).toBe('{"created": true}')
  })

  it('preserves a hardened 0600 mode and applies an explicit mode', async () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, '{"password_hash": "x"}')
    chmodSync(target, 0o600)
    await atomicWriteTextAsync(target, '{"password_hash": "y"}')
    expect(statSync(target).mode & 0o777).toBe(0o600)
    await atomicWriteTextAsync(join(dir, 'secret.json'), '{}', { mode: 0o600 })
    expect(statSync(join(dir, 'secret.json')).mode & 0o777).toBe(0o600)
  })

  it('writes through a symlink to its referent', async () => {
    mkdirSync(join(dir, 'real'))
    mkdirSync(join(dir, 'link'))
    const target = join(dir, 'real', 'settings.json')
    const link = join(dir, 'link', 'settings.json')
    writeFileSync(target, '{"theme": "old"}')
    symlinkSync(target, link)
    await atomicWriteTextAsync(link, '{"theme": "new"}')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"theme": "new"}')
    expect(readdirSync(join(dir, 'link'))).toEqual(['settings.json'])
  })

  it('removes its temp file and leaves the target intact when the rename fails', async () => {
    // The target is a non-empty directory, so the temp file is written and synced but the rename is refused.
    mkdirSync(join(dir, 'target.json'))
    writeFileSync(join(dir, 'target.json', 'keep'), 'keep-me')
    await expect(atomicWriteTextAsync(join(dir, 'target.json'), '{}')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['target.json'])
    expect(readFileSync(join(dir, 'target.json', 'keep'), 'utf8')).toBe('keep-me')
    await expect(atomicWriteTextAsync(join(dir, 'missing-dir', 'settings.json'), '{}')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['target.json'])
  })
})

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
