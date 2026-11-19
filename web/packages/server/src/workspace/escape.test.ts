/** Escape grants refuse system directories when minted and on every use below the grant root (TAL-2218). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EscapeGrants } from './escape.js'

const blocked = vi.hoisted(() => ({ dir: '' }))
// A test-owned directory stands in for a system directory below a grantable parent, as /private/etc sits below
// /private on macOS; no such pair exists on every host.
vi.mock('./workspaces.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./workspaces.js')>()
  return { ...real, isBlockedSystemPath: (p: string) => (blocked.dir !== '' && (p === blocked.dir || p.startsWith(`${blocked.dir}/`))) || real.isBlockedSystemPath(p) }
})

const SYSTEM_DIRECTORY = /^Path points to a system directory: /

describe('EscapeGrants system directories', () => {
  let base: string
  let ws: string
  let outside: string
  const grants = (): EscapeGrants => new EscapeGrants(() => Date.now() / 1000)

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-escape-system-')))
    ws = join(base, 'ws')
    outside = join(base, 'outside')
    mkdirSync(ws)
    mkdirSync(join(outside, 'system'), { recursive: true })
    writeFileSync(join(outside, 'note.txt'), 'granted')
    writeFileSync(join(outside, 'system', 'secret.txt'), 'SYSTEM')
    symlinkSync(join(outside, 'system'), join(outside, 'alias'))
    symlinkSync(outside, join(ws, 'escape'))
    blocked.dir = join(outside, 'system')
  })
  afterEach(() => {
    blocked.dir = ''
    rmSync(base, { recursive: true, force: true })
  })

  it('refuses to mint a grant for a link to the filesystem root', () => {
    symlinkSync('/', join(ws, 'root'))
    expect(() => grants().authorize(ws, 'sid', null, 'root')).toThrow(SYSTEM_DIRECTORY)
  })

  it('refuses a request below a grant whose resolved target is a system directory, and serves the rest', () => {
    const g = grants()
    const { token } = g.authorize(ws, 'sid', null, 'escape')
    // list, read, and raw only accept the request `resolve` returns, so refusing here refuses all three.
    for (const rel of ['escape/system', 'escape/system/secret.txt', 'escape/alias', 'escape/alias/secret.txt']) {
      expect(() => g.resolve(ws, 'sid', null, token, rel), rel).toThrow(SYSTEM_DIRECTORY)
    }
    expect(g.read(g.resolve(ws, 'sid', null, token, 'escape/note.txt')).content).toBe('granted')
    expect(g.list(g.resolve(ws, 'sid', null, token, 'escape')).entries.map((e) => e.name)).toContain('note.txt')
  })
})
