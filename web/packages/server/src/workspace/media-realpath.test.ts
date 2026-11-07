import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionService, type SessionServiceDeps } from '../sessions/service.js'
import type { Session } from '../sessions/session.js'
import { mediaAnchorRoot, mediaDenyReasonResolved, type MediaAccessDeps, type MediaPolicyDeps } from './media.js'

const calls = vi.hoisted(() => ({ realpath: 0 }))

// Both entry points: `resolvePathLikePython` walks with `.native`, the policy with the plain call.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const count = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    calls.realpath += 1
    return fn(...args)
  }
  return { ...fs, realpathSync: Object.assign(count(fs.realpathSync as (path: string) => string), { native: count(fs.realpathSync.native as (path: string) => string) }) }
})

const realpathCalls = (run: () => void): number => {
  const before = calls.realpath
  run()
  return calls.realpath - before
}

describe('/api/media realpath cost (TAL-1696)', () => {
  let base: string
  let home: string
  let hermesHome: string
  let workspace: string
  let outside: string
  let policy: MediaPolicyDeps<string | null>

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tal-1696-')))
    home = join(base, 'home')
    hermesHome = join(home, '.hermes')
    workspace = join(base, 'ws')
    outside = join(base, 'outside')
    for (const dir of [hermesHome, workspace, outside]) mkdirSync(dir, { recursive: true })
    policy = { home, hermesHome, stateDir: join(hermesHome, 'webui_state'), legacySnapshotDir: join(base, 'snapshots'), activeWorkspace: () => workspace }
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  const addProfiles = (count: number): void => {
    for (let i = 0; i < count; i += 1) mkdirSync(join(hermesHome, 'profiles', `p${String(i)}`, 'sessions'), { recursive: true })
  }

  /** Age every directory past the two-second window in which a same-tick write could share a stat signature. */
  const settle = (dir = hermesHome): void => {
    for (const child of readdirSync(dir, { withFileTypes: true })) if (child.isDirectory()) settle(join(dir, child.name))
    const past = new Date(Date.now() - 60_000)
    utimesSync(dir, past, past)
  }

  const deny = (target: string): string | null => mediaDenyReasonResolved(target, policy)

  it('stays within 12 realpath calls per decision on a warm cache with 5 profile roots, with the cold decisions', () => {
    addProfiles(5)
    settle()
    const cases: [string, string | null][] = [
      [join(hermesHome, 'profiles', 'p3', 'sessions', 'a.json'), 'denied state subdir'],
      [join(hermesHome, 'profiles', 'p3', 'webui_state', 'logs', 'a.log'), 'denied state subdir'],
      [join(hermesHome, 'profiles', 'p3', 'state.db'), 'denied state filename'],
      [join(hermesHome, 'generated', 'a.png'), null],
      [join(workspace, 'a.png'), null],
    ]
    const cold = cases.map(([target]) => deny(target))
    expect(cold).toEqual(cases.map(([, reason]) => reason))
    for (const [target, reason] of cases) {
      let decision: string | null = 'unset'
      const used = realpathCalls(() => { decision = deny(target) })
      expect(decision, target).toBe(reason)
      expect(used, target).toBeLessThanOrEqual(12)
    }
  })

  it('sees a profile created after the roots were cached', () => {
    addProfiles(2)
    settle()
    const target = join(hermesHome, 'profiles', 'fresh', 'sessions', 'a.json')
    expect(deny(target)).toBeNull()
    expect(deny(target)).toBeNull()
    mkdirSync(join(hermesHome, 'profiles', 'fresh'))
    expect(deny(target)).toBe('denied state subdir')
  })

  it('sees a deny directory that was missing when cached and arrives as a symlink elsewhere', () => {
    settle()
    const target = join(outside, 'a.bak')
    expect(deny(target)).toBeNull()
    expect(deny(target)).toBeNull()
    symlinkSync(outside, join(hermesHome, 'backups'))
    expect(deny(target)).toBe('denied state subdir')
  })

  it('follows a deny directory through a symlink chain retargeted outside the home', () => {
    const [first, second] = [join(outside, 'first'), join(outside, 'second')]
    for (const dir of [first, second]) mkdirSync(dir)
    const link = join(base, 'link')
    symlinkSync(first, link)
    symlinkSync(link, join(hermesHome, 'backups'))
    settle()
    settle(outside)
    expect(deny(join(first, 'a.bak'))).toBe('denied state subdir')
    expect(deny(join(second, 'a.bak'))).toBeNull()
    rmSync(link)
    symlinkSync(second, link)
    expect(deny(join(second, 'a.bak'))).toBe('denied state subdir')
    expect(deny(join(first, 'a.bak'))).toBeNull()
  })

  it('resolves a symlinked webui_state and its deny directories', () => {
    const redirected = join(outside, 'state')
    mkdirSync(join(redirected, 'sessions'), { recursive: true })
    symlinkSync(redirected, join(hermesHome, 'webui_state'))
    expect(deny(join(redirected, 'sessions', 'a.json'))).toBe('denied state subdir')
    expect(deny(join(redirected, 'a.png'))).toBeNull()
  })

  const access = (): MediaAccessDeps => ({ home, hermesHome, extraRoots: '', activeWorkspace: () => workspace, policy })

  const assistantSession = (refs: string[]): Session => ({
    session_id: 'session',
    profile: null,
    workspace: workspace,
    messages: [{ role: 'assistant', content: refs.map((ref) => `MEDIA:${ref}`).join('\n\n') }],
  }) as unknown as Session

  it.each([
    ['under the active workspace', () => workspace],
    ['granted only by the reply\'s own MEDIA tokens', () => outside],
  ])('opens a session with 50 distinct references %s within 50 + roots + denyDirs realpath calls', async (_name, dir) => {
    const refs = Array.from({ length: 50 }, (_, i) => join(dir(), `image-${String(i)}.png`))
    for (const ref of refs) writeFileSync(ref, 'png-bytes')
    const session = assistantSession(refs)
    const service = new SessionService({ store: {}, media: { access: access(), localIo: () => true } } as unknown as SessionServiceDeps)
    const before = calls.realpath
    const project = await service.mediaProjector(session)
    const projection = project(refs.map((ref) => `MEDIA:${ref}`).join('\n\n'))
    const used = calls.realpath - before
    expect(projection?.media).toHaveLength(50)
    // `~/.hermes` is the Agent home here and the state dir sits inside it: two roots, twenty-four deny directories each.
    expect(used).toBeLessThanOrEqual(50 + 2 + 2 * 24)
  })

  it('grants a reference the assistant wrote through a symlink, and never one a user wrote', async () => {
    const link = join(base, 'link')
    symlinkSync(outside, link)
    for (const name of ['assistant.png', 'user.png']) writeFileSync(join(outside, name), 'png-bytes')
    const session = { messages: [{ role: 'user', content: `MEDIA:${join(link, 'user.png')}` }, { role: 'assistant', content: `MEDIA:${join(link, 'assistant.png')}` }] } as unknown as Session
    expect(await mediaAnchorRoot(join(outside, 'assistant.png'), session, access())).toBe(outside)
    expect(await mediaAnchorRoot(join(outside, 'user.png'), session, access())).toBeNull()
  })
})
