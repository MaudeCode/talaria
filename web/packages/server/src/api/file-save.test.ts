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

async function fixture() {
  server = await bootTestServer({ sidecar: new FakeSidecar() })
  const ws = realpathSync(join(server.state, 'workspace'))
  const post = (path: string, body: unknown) => server!.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const created = await post('/api/session/new', { workspace: ws })
  expect(created.status).toBe(200)
  const { session } = await created.json() as { session: { session_id: string } }
  const path = join(ws, 'valuable.txt')
  writeFileSync(path, 'original valuable content')
  chmodSync(path, 0o640)
  return { ws, path, save: (content: string) => post('/api/file/save', { session_id: session.session_id, path: 'valuable.txt', content }) }
}

describe('workspace save preserves the last complete file', () => {
  it.each(['first write', 'partial write', 'sync', 'replace'])('preserves original bytes and mode after a %s failure', async (at) => {
    const f = await fixture()
    faults.at = at
    const response = await f.save('replacement content')
    expect(response.status).toBe(400)
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
