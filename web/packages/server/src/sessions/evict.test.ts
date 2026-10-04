/** TAL-526: only delete and clear end the Agent's session approval state; model switch and truncate drop the cached agent alone. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>

describe('cached agent eviction', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('chat.evict_agent', () => ({ evicted: true }))
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  async function seeded(): Promise<string> {
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    const sid = String(((await res.json()) as { session: Json }).session.session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'one', timestamp: 1 }, { role: 'assistant', content: 'two', timestamp: 2 }]
    s.deps.sessionStore.save(session)
    return sid
  }
  async function evictions(sid: string, mutate: () => Promise<unknown>): Promise<unknown[]> {
    const before = sidecar.calls.length
    await mutate()
    await new Promise((r) => setTimeout(r, 10))
    return sidecar.calls.slice(before).filter((c) => c.method === 'chat.evict_agent' && (c.params as Json).session_id === sid).map((c) => c.params)
  }

  it('keeps approval state on model switch and truncate', async () => {
    const sid = await seeded()
    const model = s.deps.sessionStore.get(sid).model ?? ''
    expect(await evictions(sid, () => s.deps.sessions.update(sid, { model: `${model}-switched` }))).toEqual([{ session_id: sid }])
    expect(await evictions(sid, () => s.deps.sessions.truncate(sid, 1))).toEqual([{ session_id: sid }])
  })

  it('ends approval state on clear and delete', async () => {
    const sid = await seeded()
    expect(await evictions(sid, () => s.deps.sessions.clear(sid))).toEqual([{ session_id: sid, clear_session: true }])
    expect(await evictions(sid, () => s.deps.sessions.delete(sid))).toEqual([{ session_id: sid, clear_session: true }])
  })
})
