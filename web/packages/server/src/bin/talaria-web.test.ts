/** The built `talaria-web` bin: `self-check` loads the server graph and exits without touching state (TAL-1012). */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

it('self-check against the built dist exits 0 and leaves HOME untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'talaria-self-check-'))
  dirs.push(home)
  const bin = join(import.meta.dirname, '../../dist/bin/talaria-web.js')
  execFileSync(process.execPath, [bin, 'self-check'], { env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: join(home, '.hermes') }, timeout: 30_000, stdio: 'pipe' })
  expect(readdirSync(home)).toEqual([])
})
