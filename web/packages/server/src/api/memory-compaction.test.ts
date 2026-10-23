import type { SidecarParams } from '@maudecode/talaria-web-contracts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { applyMemoryCompaction } from '../tools/memory.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

let s: TestServer
let sidecar: FakeSidecar
let file: string
let now: number
const original = 'Prefers concise answers.\n§\nPrefers brief answers.'
const compacted = 'Prefers concise answers.'
const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const preview = async () => {
  const memory = await (await s.get('/api/memory')).json() as { memory_revision: string }
  return post('/api/memory/compaction/preview', { section: 'memory', revision: memory.memory_revision })
}
const apply = (receipt: string) => post('/api/memory/compaction/apply', { receipt })
beforeEach(async () => {
  now = 1_800_000_000
  sidecar = new FakeSidecar()
  s = await bootTestServer({ sidecar, now: () => now, deps: (deps) => { deps.fetch = vi.fn(() => { throw new Error('Network forbidden') }) } })
  file = join(s.state, 'memories/MEMORY.md')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, original)
  sidecar.respond('aux.complete', () => ({ model: 'synthetic-compression', text: JSON.stringify({ entries: [compacted] }), usage: null, finish_reason: 'stop' }))
  sidecar.respond('memory.check', ({ content }) => ({ count: content.length, limit: 2200 }))
  sidecar.respond('memory.write', ({ profile_home, section, base, content }) => {
    const target = join(profile_home, 'memories', section === 'user' ? 'USER.md' : 'MEMORY.md')
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== base) return { written: false }
    writeFileSync(target, content)
    return { written: true }
  })
})
afterEach(async () => { await s.close() })

it('previews without writing and applies only the exact reviewed receipt, reconciling a repeated acknowledgment', async () => {
  const res = await preview()
  expect(res.status).toBe(200)
  const p = await res.json() as { receipt: string; source: string; proposed: string; diff: string }
  expect(p).toMatchObject({ source: original, proposed: compacted })
  expect(p.diff).toContain('-Prefers brief answers.')
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(sidecar.calls.filter((c) => c.method === 'memory.write')).toHaveLength(0)
  const request = sidecar.calls.find((c) => c.method === 'aux.complete')?.params as SidecarParams<'aux.complete'>
  expect(request).toMatchObject({ task: 'compression', profile_home: s.state, main_fallback: false })
  expect(request.messages.find((m) => m.role === 'user')?.data_use).toEqual(['no_training', 'zero_retention'])
  expect((await apply(p.receipt)).status).toBe(200)
  expect(readFileSync(file, 'utf8')).toBe(compacted)
  expect((await apply(p.receipt)).status).toBe(200)
  expect(sidecar.calls.filter((c) => c.method === 'memory.write')).toHaveLength(1)
  expect(s.deps.fetch).not.toHaveBeenCalled()
})

it('refuses a source changed during generation or at the locked write boundary', async () => {
  const p = await (await preview()).json() as { receipt: string }
  writeFileSync(file, 'New knowledge')
  expect((await apply(p.receipt)).status).toBe(409)
  expect(readFileSync(file, 'utf8')).toBe('New knowledge')
  sidecar.respond('aux.complete', () => { writeFileSync(file, 'Changed during generation'); return { model: 'fake', text: JSON.stringify({ entries: ['New'] }), usage: null } })
  expect((await preview()).status).toBe(409)
  sidecar.respond('aux.complete', () => ({ model: 'fake', text: JSON.stringify({ entries: ['New'] }), usage: null }))
  const fresh = await (await preview()).json() as { receipt: string }
  sidecar.respond('memory.write', () => { writeFileSync(file, 'Concurrent writer'); return { written: false } })
  expect((await apply(fresh.receipt)).status).toBe(409)
  expect(readFileSync(file, 'utf8')).toBe('Concurrent writer')
})

it('rejects expired, tampered, and foreign-profile receipts without writes', async () => {
  const p = await (await preview()).json() as { receipt: string }
  expect((await apply(p.receipt + 'x')).status).toBe(409)
  const other = await bootTestServer({ sidecar: new FakeSidecar() })
  try {
    const res = await other.get('/api/memory/compaction/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipt: p.receipt }) })
    expect(res.status).toBe(409)
  } finally { await other.close() }
  now += 1801
  expect((await apply(p.receipt)).status).toBe(409)
  expect(readFileSync(file, 'utf8')).toBe(original)
})

it.each(['not json', '{"entries":[]}', '{"entries":[1]}', JSON.stringify({ entries: ['x'.repeat(2201)] }), JSON.stringify({ entries: ['x\n§\ny'] })])('rejects malformed or oversized output case %# without writes', async (text) => {
  sidecar.respond('aux.complete', () => ({ model: 'fake', text, usage: null }))
  expect((await preview()).status).toBe(422)
  expect(readFileSync(file, 'utf8')).toBe(original)
})

it('keeps secret-bearing entries unchanged and never sends secrets to the auxiliary provider', async () => {
  const secret = 'token ghp_AbCDEFGHIJKLMNOP6789\n§\npassword: hunter2\n§\npassword: other99\n§\n[protected] Keep this exact preference.'
  writeFileSync(file, `${original}\n§\n${secret}`)
  sidecar.respond('aux.complete', ({ messages }) => {
    expect(JSON.stringify(messages)).not.toContain('ghp_AbCDEFGHIJKLMNOP6789')
    expect(JSON.stringify(messages)).not.toContain('hunter2')
    expect(JSON.stringify(messages)).not.toContain('Keep this exact preference')
    return { model: 'fake', text: JSON.stringify({ entries: [compacted] }), usage: null }
  })
  const res = await preview()
  expect(res.status).toBe(200)
  const p = await res.json() as { receipt: string; proposed: string }
  expect(p.proposed).toContain('ghp_Ab...6789')
  expect(JSON.stringify(p)).not.toContain('ghp_AbCDEFGHIJKLMNOP6789')
  expect((await apply(p.receipt)).status).toBe(200)
  expect(readFileSync(file, 'utf8')).toBe(`${compacted}\n§\n${secret}`)
})

it('reports an unavailable auxiliary route and reconciles a lost write acknowledgment without replay', async () => {
  sidecar.respond('aux.complete', () => { throw new SidecarError('No auxiliary model configured', { condition: 'aux_unconfigured' }) })
  expect((await preview()).status).toBe(503)
  expect(readFileSync(file, 'utf8')).toBe(original)
  sidecar.respond('aux.complete', () => ({ model: 'fake', text: JSON.stringify({ entries: [compacted] }), usage: null }))
  const p = await (await preview()).json() as { receipt: string }
  sidecar.respond('memory.write', ({ content }) => { writeFileSync(file, content); throw new SidecarError('Lost acknowledgment', { condition: 'sidecar_unavailable' }) })
  expect((await apply(p.receipt)).status).toBe(200)
  expect(readFileSync(file, 'utf8')).toBe(compacted)
  expect(sidecar.calls.filter((c) => c.method === 'memory.write')).toHaveLength(1)
})


it('binds a receipt to its profile even when the signing key is shared', async () => {
  const p = await (await preview()).json() as { receipt: string }
  const write = vi.fn()
  await expect(applyMemoryCompaction(join(s.state, 'profiles/foreign'), {}, p.receipt, { key: s.deps.auth.signingKey(), now: () => now, check: vi.fn(), write })).rejects.toMatchObject({ status: 409 })
  expect(write).not.toHaveBeenCalled()
})

it('does not call a model for empty, disabled, or oversized sources', async () => {
  for (const text of ['', 'x'.repeat(32001)]) {
    writeFileSync(file, text)
    expect((await preview()).status).toBe(422)
    expect(readFileSync(file, 'utf8')).toBe(text)
  }
  writeFileSync(file, original)
  sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { memory: { memory_enabled: false } } }))
  writeFileSync(join(s.state, 'config.yaml'), '# invalidate config cache')
  expect((await preview()).status).toBe(403)
  expect(sidecar.calls.filter((c) => c.method === 'aux.complete' || c.method === 'memory.write')).toHaveLength(0)
})

it('refuses truncated, over-count, secret-generating, and unknown write outcomes without replay', async () => {
  for (const result of [
    { text: JSON.stringify({ entries: ['Short'] }), finish_reason: 'length' },
    { text: JSON.stringify({ entries: Array.from({ length: 129 }, () => 'a') }), finish_reason: 'stop' },
    { text: JSON.stringify({ entries: ['password: invented'] }), finish_reason: 'stop' },
  ]) {
    sidecar.respond('aux.complete', () => ({ model: 'fake', usage: null, ...result }))
    expect((await preview()).status).toBe(422)
    expect(readFileSync(file, 'utf8')).toBe(original)
  }
  sidecar.respond('aux.complete', () => ({ model: 'fake', text: JSON.stringify({ entries: [compacted] }), usage: null }))
  const p = await (await preview()).json() as { receipt: string }
  sidecar.respond('memory.write', () => { throw new SidecarError('Unknown write', { condition: 'sidecar_unavailable' }) })
  expect((await apply(p.receipt)).status).toBe(503)
  expect(sidecar.calls.filter((c) => c.method === 'memory.write')).toHaveLength(1)
  expect(readFileSync(file, 'utf8')).toBe(original)
})


it('compacts the user profile through the same receipt and write gate without changing memory', async () => {
  const userFile = join(s.state, 'memories/USER.md')
  writeFileSync(userFile, original)
  const loaded = await (await s.get('/api/memory')).json() as { user_revision: string }
  const response = await post('/api/memory/compaction/preview', { section: 'user', revision: loaded.user_revision })
  expect(response.status).toBe(200)
  const p = await response.json() as { section: string; receipt: string }
  expect(p.section).toBe('user')
  expect((await apply(p.receipt)).status).toBe(200)
  expect(readFileSync(userFile, 'utf8')).toBe(compacted)
  expect(readFileSync(file, 'utf8')).toBe(original)
})
