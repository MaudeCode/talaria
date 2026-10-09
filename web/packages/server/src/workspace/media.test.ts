import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '../http/context.js'
import { serveFileBytes } from './media.js'

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
