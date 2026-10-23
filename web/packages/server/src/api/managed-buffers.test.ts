import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

let s: TestServer | undefined
afterEach(async () => { await s?.close(); s = undefined })
const post = (path: string, body: unknown) => s!.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

it('lists session-managed buffers through Files without resolving a workspace', async () => {
  const fake = new FakeSidecar()
  fake.respond('plugins.buffers', (() => ({ supported: true, buffers: [{ name: 'draft.txt', size: 5, read_only: false }], write_semantics: 'unconditional' })))
  s = await bootTestServer({ sidecar: fake })
  const created = await (await post('/api/session/new', {})).json() as { session: { session_id: string } }
  const sessionId = created.session.session_id
  const session = await s.deps.sessionStore.get(sessionId)
  session.workspace = '/missing-managed-buffer-workspace'
  await s.deps.sessionStore.save(session)
  const response = await s.get(`/api/list?session_id=${sessionId}&source=managed`)
  expect(response.status, 'managed buffers must not require a trusted workspace').toBe(200)
  const listing = await response.json() as { entries: { name: string; path: string }[]; write_semantics: string }
  expect(listing.entries.map((e) => e.name)).toEqual(['draft.txt'])
  expect(listing.entries[0]!.path).toMatch(/^buffer-[a-f0-9]{64}$/)
  expect(listing.write_semantics).toBe('unconditional')
})

async function setupBuffers() {
  const fake = new FakeSidecar()
  let text = 'original'
  let present = true
  let readOnly = false
  fake.respond('plugins.buffers', ({ action, content }) => {
    if (action === 'save') text = content!
    return { supported: true, buffers: present ? [{ name: 'draft.txt', size: Buffer.byteLength(text), read_only: readOnly }] : [], write_semantics: 'unconditional', ...(action === 'read' ? { content: text, size: Buffer.byteLength(text), read_only: readOnly } : {}), ...(action === 'save' ? { size: Buffer.byteLength(text) } : {}) }
  })
  s = await bootTestServer({ sidecar: fake })
  const created = await (await post('/api/session/new', {})).json() as { session: { session_id: string } }
  const sid = created.session.session_id
  const listing = await (await s.get(`/api/list?session_id=${sid}&source=managed`)).json() as { entries: { path: string }[] }
  const path = listing.entries[0]!.path
  return { fake, sid, path, remove: () => { present = false }, lock: () => { readOnly = true }, read: () => s!.get(`/api/file?session_id=${sid}&source=managed&path=${path}`), save: (content: unknown) => post('/api/file/save', { session_id: sid, source: 'managed', path, content }) }
}

it('reads, saves and reloads by opaque identity with no native paths or workspace fallback', async () => {
  const b = await setupBuffers()
  expect(await (await b.read()).json()).toMatchObject({ name: 'draft.txt', content: 'original', read_only: false, write_semantics: 'unconditional' })
  expect((await b.save('edited')).status).toBe(200)
  expect(await (await b.read()).json()).toMatchObject({ content: 'edited' })
  expect((await post('/api/file/save', { session_id: b.sid, source: 'managed', path: '../private', content: 'x' })).status).toBe(404)
})

it('refuses read-only or vanished buffers before a native write', async () => {
  const b = await setupBuffers()
  b.lock()
  expect((await b.save('no')).status).toBe(403)
  b.remove()
  expect((await b.read()).status).toBe(404)
  expect((await b.save('cannot recreate')).status).toBe(404)
  expect(b.fake.calls.filter((c) => c.method === 'plugins.buffers' && (c.params as { action: string }).action === 'save')).toHaveLength(0)
})

it('rejects malformed and oversized writes, unknown source, and foreign profile access', async () => {
  const b = await setupBuffers()
  expect((await b.save({ text: 'bad' })).status).toBe(400)
  expect((await b.save('é'.repeat(140000))).status).toBe(413)
  expect((await s!.get(`/api/list?session_id=${b.sid}&source=arbitrary`)).status).toBe(400)
  const before = b.fake.calls.filter((c) => c.method === 'plugins.buffers').length
  expect((await s!.get(`/api/file?session_id=${b.sid}&source=managed&path=${b.path}`, { headers: { cookie: 'hermes_profile=beta' } })).status).toBe(404)
  expect(b.fake.calls.filter((c) => c.method === 'plugins.buffers')).toHaveLength(before)
})

it('keeps imported sessions read-only and never retries an unknown native save', async () => {
  const b = await setupBuffers()
  const { vi } = await import('vitest')
  const lock = vi.spyOn(s!.deps.sessions, 'isReadOnly').mockResolvedValue(true)
  expect((await b.save('no')).status).toBe(403)
  lock.mockRestore()
  b.fake.respond('plugins.buffers', ({ action }) => {
    if (action === 'save') throw new Error('acknowledgement lost')
    return { supported: true, buffers: [{ name: 'draft.txt', size: 8, read_only: false }], write_semantics: 'unconditional' }
  })
  const res = await b.save('unknown')
  expect(res.status).toBe(503)
  expect(await res.json()).toMatchObject({ condition: 'buffer_save_unconfirmed' })
  expect(b.fake.calls.filter((c) => c.method === 'plugins.buffers' && (c.params as { action: string }).action === 'save')).toHaveLength(1)
})

it('opens native session buffers without creating a local session document or workspace', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const fake = new FakeSidecar()
  fake.respond('plugins.buffers', ({ session_id, action }) => {
    expect(session_id).toBe(fixture.sessions.cli)
    return { supported: true, buffers: [{ name: 'native.txt', size: 6, read_only: true }], write_semantics: 'unconditional', ...(action === 'read' ? { content: 'native', size: 6, read_only: true } : {}) }
  })
  s = await bootTestServer({ sidecar: fake })
  const db = new DatabaseSync(join(s.state, 'state.db'))
  try { db.exec(fixture.schema.join('\n')); for (const sql of fixture.inserts) db.exec(sql) } finally { db.close() }
  await s.deps.settings.save({ show_cli_sessions: true })
  const res = await s.get(`/api/list?session_id=${fixture.sessions.cli}&source=managed`)
  expect(res.status, 'native buffers do not require a Web session document').toBe(200)
  const listing = await res.json() as { entries: { path: string }[] }
  const read = await s.get(`/api/file?session_id=${fixture.sessions.cli}&source=managed&path=${listing.entries[0]!.path}`)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ content: 'native', read_only: true })
})
