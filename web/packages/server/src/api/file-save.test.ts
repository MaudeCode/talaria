import { chmodSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ at: '', triggered: false, fds: new Set<number>() }))
vi.mock('../fs/atomic.js', async (importOriginal) => {
  const atomic = await importOriginal<typeof import('../fs/atomic.js')>()
  const fs = await import('node:fs')
  return { ...atomic, writeFully: (fd: number, data: string | Uint8Array) => {
    if (data.toString() === 'replacement content' && ['first write', 'partial write'].includes(faults.at)) {
      faults.triggered = true
      if (faults.at === 'partial write') fs.writeSync(fd, Buffer.from('rep'))
      throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
    }
    atomic.writeFully(fd, data)
  } }
})
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      if (faults.at === 'create' && String(args[0]).includes('full-disk') && typeof args[1] === 'number' && (args[1] & fs.constants.O_CREAT)) {
        faults.triggered = true
        throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
      }
      const fd = fs.openSync(...args)
      if (faults.at) faults.fds.add(fd)
      return fd
    }) as typeof fs.openSync,
    closeSync: (fd: number) => { fs.closeSync(fd); faults.fds.delete(fd) },
    fsyncSync: (fd: number) => {
      if (faults.at === 'sync') { faults.triggered = true; throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }) }
      fs.fsyncSync(fd)
    },
    renameSync: ((from: string, to: string) => {
      if (faults.at === 'replace' && from.includes('.talaria-save-')) { faults.triggered = true; throw Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' }) }
      fs.renameSync(from, to)
    }) as typeof fs.renameSync,
  }
})

import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

let server: TestServer | undefined
afterEach(async () => {
  faults.at = ''
  faults.triggered = false
  faults.fds.clear()
  await server?.close()
  server = undefined
})

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture() {
  server = await bootTestServer({ sidecar: new FakeSidecar() })
  const ws = realpathSync(server.workspace)
  const post = (path: string, body: unknown) => server!.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const created = await post('/api/session/new', { workspace: ws })
  expect(created.status).toBe(200)
  const { session } = await created.json() as { session: { session_id: string } }
  const path = join(ws, 'valuable.txt')
  writeFileSync(path, 'original valuable content')
  chmodSync(path, 0o640)
  const upload = (route: string, filename: string) => server!.get(route, {
    method: 'POST',
    body: ['--b', 'Content-Disposition: form-data; name="session_id"', '', session.session_id, '--b', `Content-Disposition: form-data; name="file"; filename="${filename}"`, 'Content-Type: text/plain', '', 'synthetic', '--b--', ''].join('\r\n'),
    headers: { 'content-type': 'multipart/form-data; boundary=b' },
  })
  return { ws, path, post, upload, sid: session.session_id, save: (content: string) => post('/api/file/save', { session_id: session.session_id, path: 'valuable.txt', content }) }
}

describe('workspace save preserves the last complete file', () => {
  // A full disk answers 507 with the storage-full condition (TAL-2716); any other write failure stays a 400.
  it.each([['first write', 507], ['partial write', 507], ['sync', 400], ['replace', 400]] as const)('preserves original bytes and mode after a %s failure', async (at, status) => {
    const f = await fixture()
    faults.at = at
    const response = await f.save('replacement content')
    expect(response.status).toBe(status)
    if (status === 507) expect(await response.json()).toMatchObject({ condition: 'storage_full' })
    expect(readFileSync(f.path, 'utf8')).toBe('original valuable content')
    expect(statSync(f.path).mode & 0o777).toBe(0o640)
    expect(faults.triggered).toBe(true)
    expect(readdirSync(f.ws)).toEqual(['valuable.txt'])
    expect([...faults.fds]).toEqual([])
  })

  it.each(['replacement content', ''])('publishes complete content %j and preserves mode', async (content) => {
    const f = await fixture()
    faults.at = 'observe'
    const response = await f.save(content)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, path: 'valuable.txt', size: Buffer.byteLength(content) })
    expect(readFileSync(f.path, 'utf8')).toBe(content)
    expect(statSync(f.path).mode & 0o777).toBe(0o640)
    expect(readdirSync(f.ws)).toEqual(['valuable.txt'])
    expect([...faults.fds]).toEqual([])
  })
})

// TAL-2716: a full disk while creating the destination answers 507, not the 400, 403 or 500 a refused path gets.
describe('creating a file on a full disk', () => {
  it.each([
    ['/api/file/create', (f: Fixture) => f.post('/api/file/create', { session_id: f.sid, path: 'full-disk.txt', content: 'x' })],
    ['/api/workspace/upload', (f: Fixture) => f.upload('/api/workspace/upload', 'full-disk.txt')],
    ['/api/upload', (f: Fixture) => f.upload('/api/upload', 'full-disk.txt')],
  ])('%s answers 507', async (_route, send) => {
    const f = await fixture()
    faults.at = 'create'
    const response = await send(f)
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 507, body: { error: 'Storage on the server is full. Free up space on the server, then try again.', condition: 'storage_full' } })
    expect(faults.triggered).toBe(true)
  })
})
