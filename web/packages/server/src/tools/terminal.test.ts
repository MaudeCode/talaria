import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureSpawnHelperExecutable } from './terminal.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function ptyRoot(mode: number | null): { root: string; helper: string } {
  const root = mkdtempSync(join(tmpdir(), 'talaria-node-pty-'))
  dirs.push(root)
  const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper')
  if (mode !== null) {
    mkdirSync(join(helper, '..'), { recursive: true })
    writeFileSync(helper, 'synthetic helper')
    chmodSync(helper, mode)
  }
  return { root, helper }
}

it("makes node-pty 1.1.0's non-executable prebuilt spawn-helper executable (TAL-384)", () => {
  const { root, helper } = ptyRoot(0o644)
  ensureSpawnHelperExecutable(root, 'darwin', 'arm64')
  expect(statSync(helper).mode & 0o777).toBe(0o755)
})

it('leaves an executable helper unchanged and ignores missing prebuilds', () => {
  const executable = ptyRoot(0o700)
  ensureSpawnHelperExecutable(executable.root, 'darwin', 'arm64')
  expect(statSync(executable.helper).mode & 0o777).toBe(0o700)
  const missing = ptyRoot(null)
  expect(() => { ensureSpawnHelperExecutable(missing.root, 'darwin', 'arm64') }).not.toThrow()
  expect(existsSync(join(missing.root, 'prebuilds'))).toBe(false)
})
