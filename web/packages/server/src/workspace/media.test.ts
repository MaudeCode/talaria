import { closeSync, createReadStream, fstatSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '../http/context.js'
import type { Session } from '../sessions/session.js'
import { mediaAnchorRoot, serveFileBytes, type MediaAccessDeps, type ServeFileOptions } from './media.js'

const io = vi.hoisted(() => ({ bytes: 0, syncBytes: 0, readError: false, intercept: undefined as ((resume: () => void) => void) | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const closeSync = vi.fn(fs.closeSync)
  const readSync = vi.fn((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    const n = fs.readSync(fd, buffer, offset, length, position)
    io.bytes += n
    io.syncBytes += n
    return n
  })
  const read = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void) => {
    if (io.readError) { io.readError = false; callback(new Error('read failed'), 0, buffer); return }
    const resume = () => {
      fs.read(fd, buffer, offset, length, position, (error, bytesRead, result) => {
        io.bytes += bytesRead ?? 0
        callback(error, bytesRead, result)
      })
    }
    const intercept = io.intercept
    io.intercept = undefined
    if (intercept) intercept(resume)
    else resume()
  })
  return { ...fs, default: { ...fs, closeSync, readSync, read }, closeSync, readSync, read, createReadStream: vi.fn(fs.createReadStream) }
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

  const serve = async (headers: Record<string, string>): Promise<{ status?: number | undefined }> => {
    const sent: { status?: number | undefined } = {}
    const ctx = {
      header: (name: string) => headers[name],
      send: (opts: { status?: number }) => { sent.status = opts.status },
      json: (_payload: unknown, opts: { status?: number } = {}) => { sent.status = opts.status },
    } as unknown as RequestContext
    let thrown: unknown
    try { (await serveFileBytes(ctx, file, { mime: 'image/png', disposition: 'inline', cacheControl: 'private, max-age=0' })) } catch (error) { thrown = error }
    // A second close of a freed descriptor number can close another request's file.
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1)
    expect(thrown).toBeUndefined()
    return sent
  }

  it('closes a buffered 200 response descriptor once', async () => {
    expect((await serve({})).status).toBe(200)
  })

  it('closes a 206 range response descriptor once', async () => {
    expect((await serve({ range: 'bytes=0-2' })).status).toBe(206)
  })

  it('closes a 416 response descriptor once', async () => {
    expect((await serve({ range: 'bytes=99-' })).status).toBe(416)
  })
})

describe('serveFileBytes bounded asynchronous IO (TAL-1243)', () => {
  let root: string
  let file: string
  const options = { mime: 'image/png', disposition: 'inline', cacheControl: 'private, no-cache' }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tal-1243-'))
    file = join(root, 'media.png')
    writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 7))
    io.bytes = io.syncBytes = 0
    vi.mocked(closeSync).mockClear()
  })
  afterEach(() => { io.intercept = undefined; io.readError = false; vi.mocked(createReadStream).mockClear(); rmSync(root, { recursive: true, force: true }) })

  const serve = async (headers: Record<string, string> = {}, target = file, overrides: Partial<ServeFileOptions> = {}, contextOverrides: Partial<RequestContext> = {}) => {
    const sent = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) }
    const ctx = {
      header: (name: string) => headers[name],
      send: (opts: { status: number; headers?: Record<string, string>; body?: Buffer }) => { Object.assign(sent, opts) },
      json: (_body: unknown, opts: { status: number }) => { sent.status = opts.status },
      sendStream: async (opts: { status: number; headers: Record<string, string> }, stream: AsyncIterable<Buffer>) => {
        Object.assign(sent, opts)
        const chunks: Buffer[] = []
        for await (const chunk of stream) { io.bytes += chunk.length; chunks.push(chunk) }
        sent.body = Buffer.concat(chunks)
      },
    } as unknown as RequestContext
    Object.assign(ctx, contextOverrides)
    await serveFileBytes(ctx, target, { ...options, ...overrides })
    return sent
  }

  it('reads only the selected byte on repeated uncached ranges', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await serve({ range: 'bytes=0-0' })
      expect(response.status).toBe(206)
      expect(response.body).toEqual(Buffer.from([7]))
    }
    expect(io.bytes).toBe(2)
    expect(io.syncBytes).toBe(0)
  })

  it('revalidates an unchanged full response without reading bytes again', async () => {
    const full = await serve()
    expect(full.headers.ETag).toMatch(/^W\/"/)
    io.bytes = io.syncBytes = 0
    const response = await serve({ 'if-none-match': full.headers.ETag! })
    expect(response.status).toBe(304)
    expect(io.bytes).toBe(0)
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(2)
  })

  it('yields to controlled asynchronous descriptor IO before responding', async () => {
    let release: (() => void) | undefined
    io.intercept = (resume) => { release = resume }
    let finished = false
    const pending = serve().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(release).toBeTypeOf('function')
    release!()
    await pending
    expect(io.syncBytes).toBe(0)
  })

  it('keeps cached validators on ranges while reading only the span', async () => {
    const full = await serve()
    io.bytes = 0
    const response = await serve({ range: 'bytes=7-9' })
    expect(response.headers.ETag).toBe(full.headers.ETag)
    expect(response.headers['Content-Range']).toBe('bytes 7-9/8388608')
    expect(response.body).toEqual(Buffer.from([7, 7, 7]))
    expect(io.bytes).toBe(3)
  })

  it.each([
    ['bytes=-2', 206, 2],
    ['bytes=8388606-', 206, 2],
    ['bytes=8388607-9999999', 206, 1],
    ['bytes=0-1,3-4', 416, 0],
    ['bytes=8388608-', 416, 0],
  ] as const)('preserves range semantics for %s', async (range, status, length) => {
    const response = await serve({ range })
    expect(response.status).toBe(status)
    expect(response.body).toHaveLength(length)
    expect(io.bytes).toBe(length)
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1)
  })

  it('computes a cold conditional validator and then reuses it before range handling', async () => {
    writeFileSync(file, 'same content')
    const full = await serve()
    const other = join(root, 'other.png')
    writeFileSync(other, 'same content')
    io.bytes = 0
    expect((await serve({ 'if-none-match': full.headers.ETag!, range: 'bytes=0-0' }, other)).status).toBe(304)
    expect(io.bytes).toBe(12)
    io.bytes = 0
    expect((await serve({ 'if-none-match': full.headers.ETag!, range: 'bytes=99-' }, other)).status).toBe(304)
    expect(io.bytes).toBe(0)
  })

  it('closes empty, invalid-range and missing-file paths without reading bytes', async () => {
    writeFileSync(file, '')
    expect((await serve()).body).toHaveLength(0)
    expect((await serve({ range: 'bytes=0-0' })).status).toBe(416)
    rmSync(file)
    expect((await serve()).status).toBe(404)
    expect(io.bytes).toBe(0)
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(2)
  })

  it('checks a missing or hard-linked file before using a cached validator', async () => {
    const full = await serve()
    linkSync(file, join(root, 'hard-link'))
    expect((await serve({ 'if-none-match': full.headers.ETag! }, file, { denyHardLinks: true })).status).toBe(403)
    rmSync(file)
    expect((await serve({ 'if-none-match': full.headers.ETag! })).status).toBe(404)
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(2)
  })

  it('evicts old validators once the bounded cache fills', async () => {
    writeFileSync(file, 'original')
    const full = await serve()
    for (let i = 0; i < 256; i++) {
      const other = join(root, `other-${i}`)
      writeFileSync(other, String(i))
      await serve({}, other)
    }
    io.bytes = 0
    expect((await serve({ 'if-none-match': full.headers.ETag! })).status).toBe(304)
    expect(io.bytes).toBe(8)
  })

  it('closes the descriptor on asynchronous read failure', async () => {
    io.readError = true
    await expect(serve()).rejects.toThrow('read failed')
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1)
  })

  it('does not cache a validator for an inode truncated during asynchronous IO', async () => {
    io.intercept = (resume) => { truncateSync(file, 0); resume() }
    const response = await serve()
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(0)
    expect(response.headers.ETag).toBeUndefined()
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1)
  })

  it.each(['abort', 'send failure'] as const)('releases stream ownership on %s', async (kind) => {
    const contextOverrides: Partial<RequestContext> = {
      sendStream: async (_opts, stream) => {
        if (kind === 'send failure') throw new Error('send failed')
        const closed = once(stream, 'close')
        stream.destroy?.()
        await closed
      },
    }
    const pending = serve({}, file, { cacheControl: 'no-store' }, contextOverrides)
    if (kind === 'send failure') await expect(pending).rejects.toThrow('send failed')
    else await pending
    const options = vi.mocked(createReadStream).mock.calls[0]![1]!
    if (typeof options === 'string') throw new Error('Expected descriptor stream options')
    const fd = options.fd as number
    const stream = vi.mocked(createReadStream).mock.results[0]!.value as ReturnType<typeof createReadStream>
    if (!stream.closed) await once(stream, 'close')
    expect(() => fstatSync(fd)).toThrow()
    expect(vi.mocked(closeSync)).not.toHaveBeenCalled()
  })

  it.each(['rewrite', 'replace', 'truncate'] as const)('invalidates validators after %s', async (kind) => {
    const first = await serve()
    if (kind === 'rewrite') {
      const old = statSync(file)
      writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 8))
      utimesSync(file, old.atime, old.mtime)
    } else if (kind === 'replace') {
      writeFileSync(join(root, 'replacement'), 'new inode')
      renameSync(join(root, 'replacement'), file)
    } else truncateSync(file, 2)
    const response = await serve({ 'if-none-match': first.headers.ETag! })
    expect(response.status).toBe(200)
    expect(response.headers.ETag).not.toBe(first.headers.ETag)
    expect(response.body.length).toBe(kind === 'rewrite' ? 8 * 1024 * 1024 : kind === 'replace' ? 9 : 2)
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
      policy: { home, hermesHome, stateDir: join(hermesHome, 'webui_state'), activeWorkspace: () => workspace },
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

  it('skips the scan when an allowed root authorizes the path', async () => {
    const target = join(base, 'ws', 'a.png')
    const { session, reads } = spySession(target)
    expect((await mediaAnchorRoot(target, session, deps))).toBe(join(base, 'ws'))
    expect(reads()).toBe(0)
  })

  it('scans the session when no root authorizes the path', async () => {
    const target = join(base, 'outside', 'a.png')
    const { session, reads } = spySession(target)
    expect((await mediaAnchorRoot(target, session, deps))).toBe(join(base, 'outside'))
    expect(reads()).toBe(1)
  })

  it('keeps a legacy custom snapshot store denied under an allowed root (TAL-587)', async () => {
    const store = join(base, 'ws', 'snaps')
    mkdirSync(store)
    writeFileSync(join(store, `${'a'.repeat(64)}.snap`), 'frozen')
    deps.policy = { ...deps.policy, legacySnapshotDir: store }
    expect((await mediaAnchorRoot(join(store, `${'a'.repeat(64)}.snap`), null, deps))).toBeNull()
    expect((await mediaAnchorRoot(join(base, 'ws', 'a.png'), null, deps))).toBe(join(base, 'ws'))
  })
})
