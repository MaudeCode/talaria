import { closeSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '../http/context.js'
import type { Session } from '../sessions/session.js'
import { mediaAnchorRoot, serveFileBytes, type MediaAccessDeps } from './media.js'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const closeSync = vi.fn(fs.closeSync)
  return { ...fs, default: { ...fs, closeSync }, closeSync }
})

describe('serveFileBytes descriptor ownership (TAL-572)', () => {
  let root: string
  let file: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tal-572-'))
    file = join(root, 'a.png')
    writeFileSync(file, 'png-bytes')
    vi.mocked(closeSync).mockClear()
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const serve = (headers: Record<string, string>): { status?: number | undefined } => {
    const sent: { status?: number | undefined } = {}
    const ctx = {
      header: (name: string) => headers[name],
      send: (opts: { status?: number }) => { sent.status = opts.status },
      json: (_payload: unknown, opts: { status?: number } = {}) => { sent.status = opts.status },
    } as unknown as RequestContext
    let thrown: unknown
    try { serveFileBytes(ctx, file, { mime: 'image/png', disposition: 'inline', cacheControl: 'private, max-age=0' }) } catch (error) { thrown = error }
    // A second close of a freed descriptor number can close another request's file.
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1)
    expect(thrown).toBeUndefined()
    return sent
  }

  it('closes a buffered 200 response descriptor once', () => {
    expect(serve({}).status).toBe(200)
  })

  it('closes a 206 range response descriptor once', () => {
    expect(serve({ range: 'bytes=0-2' }).status).toBe(206)
  })

  it('closes a 416 response descriptor once', () => {
    expect(serve({ range: 'bytes=99-' }).status).toBe(416)
  })
})

describe('mediaAnchorRoot session MEDIA scan (TAL-573)', () => {
  let base: string
  let deps: MediaAccessDeps
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tal-573-')))
    const home = join(base, 'home')
    const workspace = join(base, 'ws')
    for (const dir of [home, workspace, join(base, 'outside')]) mkdirSync(dir)
    for (const file of [join(workspace, 'a.png'), join(base, 'outside', 'a.png')]) writeFileSync(file, 'png-bytes')
    const hermesHome = join(home, '.hermes')
    deps = {
      home,
      hermesHome,
      extraRoots: '',
      activeWorkspace: () => workspace,
      policy: { home, hermesHome, stateDir: join(hermesHome, 'webui_state'), snapshotDir: () => join(hermesHome, 'media_snapshots'), activeWorkspace: () => workspace },
    }
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  /** A session whose transcript grants `ref`, counting every read of its messages (the scan's only entry). */
  const spySession = (ref: string): { session: Session; reads: () => number } => {
    let reads = 0
    const messages = [{ role: 'assistant', content: `MEDIA:${ref}` }]
    const session = { get messages() { reads += 1; return messages } } as unknown as Session
    return { session, reads: () => reads }
  }

  it('skips the scan when an allowed root authorizes the path', () => {
    const target = join(base, 'ws', 'a.png')
    const { session, reads } = spySession(target)
    expect(mediaAnchorRoot(target, session, deps)).toBe(join(base, 'ws'))
    expect(reads()).toBe(0)
  })

  it('scans the session when no root authorizes the path', () => {
    const target = join(base, 'outside', 'a.png')
    const { session, reads } = spySession(target)
    expect(mediaAnchorRoot(target, session, deps)).toBe(join(base, 'outside'))
    expect(reads()).toBe(1)
  })
})
