import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fileStatKey, settledFileStatKey } from './stat.js'

it('trusts a file signature only after the full coarse-timestamp window has settled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settled-stat-'))
  const path = join(dir, 'owned')
  writeFileSync(path, 'synthetic')
  utimesSync(path, 100, 100)
  const st = statSync(path, { bigint: true })
  vi.useFakeTimers()
  try {
    for (const millis of [99_000, 100_000, 101_999]) {
      vi.setSystemTime(millis)
      expect(settledFileStatKey(path, st)).toBeNull()
    }
    vi.setSystemTime(102_000)
    expect(settledFileStatKey(path, st)).toBe(fileStatKey(path, st))
    vi.setSystemTime(103_000)
    expect(settledFileStatKey(path, st)).toBe(fileStatKey(path, st))
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
})
