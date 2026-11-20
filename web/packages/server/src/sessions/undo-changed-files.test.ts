import { realpathSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>

/** A profile's checkpoint store holding one snapshot, taken at second 30 by a turn that wrote `notes.txt`. */
const SNAPSHOT_AT = 30

/** TAL-2069: Undo names the files the undone turns changed, from the Agent's checkpoints of the session's workspace. */
describe('/api/session/undo changed_files (TAL-2069)', () => {
  let s: TestServer
  const sidecar = new FakeSidecar()
  // The Agent's hint names a span's files only when a snapshot was taken at or after the span began.
  sidecar.respond('checkpoints.undo_changed_files', (params) => ({ files: Math.floor(params.since) <= SNAPSHOT_AT ? ['notes.txt'] : [] }))
  beforeAll(async () => { s = await bootTestServer({ sidecar }) })
  afterAll(() => s.close())

  async function undo(messages: Json[]): Promise<Json> {
    const session = await s.deps.sessionStore.newSession({ workspace: s.workspace })
    session.messages = structuredClone(messages)
    session.context_messages = structuredClone(messages)
    await s.deps.sessionStore.save(session)
    const res = await s.get('/api/session/undo', { method: 'POST', body: JSON.stringify({ session_id: session.session_id }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    return await res.json() as Json
  }

  it('names the files a turn that wrote one changed, from the span its user row began', async () => {
    const before = sidecar.calls.length
    const undone = await undo([
      { role: 'user', content: 'chat', timestamp: 10 }, { role: 'assistant', content: 'ok', timestamp: 12 },
      { role: 'user', content: 'write notes', timestamp: 29 }, { role: 'assistant', content: 'wrote it', timestamp: 31 },
    ])
    expect(undone).toMatchObject({ ok: true, removed_count: 2, changed_files: ['notes.txt'] })
    expect(sidecar.calls.slice(before).filter((c) => c.method === 'checkpoints.undo_changed_files').map((c) => c.params)).toEqual([expect.objectContaining({ workspace: realpathSync(s.workspace), since: 29 })])
  })

  it('names nothing for a chat-only turn after the last snapshot', async () => {
    const undone = await undo([
      { role: 'user', content: 'write notes', timestamp: 29 }, { role: 'assistant', content: 'wrote it', timestamp: 31 },
      { role: 'user', content: 'just chat', timestamp: 40 }, { role: 'assistant', content: 'sure', timestamp: 41 },
    ])
    expect(undone).toMatchObject({ ok: true, removed_count: 2, changed_files: [] })
  })
})
