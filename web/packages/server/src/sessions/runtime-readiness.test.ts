import { describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

const post = (s: TestServer, path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('Agent recovery readiness across HTTP and replay', () => {
  it.each([
    ['incomplete', false, 'recovery_incomplete'],
    ['active', true, 'update_active'],
    ['unknown', true, 'unknown'],
    ['stale', true, 'unknown'],
    ['unverified', true, 'source_changed'],
    ['unverified', false, 'unknown'],
    [undefined, undefined, 'unknown'],
  ])('preserves %s recovery without inferring success from the message', async (state, changed, reason) => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    const fail = () => { throw new SidecarError('Agent updated successfully', { condition: 'agent_runtime_stale', data: { agent_update_state: state, agent_source_changed: changed, retryable: true, restart_scheduled: false } }) }
    const expected = { agent_runtime_reason: reason, ...(state === undefined ? {} : { agent_update_state: state }), retryable: true, restart_scheduled: false }
    try {
      const created = await (await post(s, '/api/session/new', {})).json() as { session: { session_id: string } }
      const sid = created.session.session_id
      sidecar.respond('runtime.ensure_current', fail)
      const health = await (await s.get('/api/health/agent')).json() as { chat: unknown }
      expect(health.chat).toMatchObject({ available: false, condition: 'agent_runtime_stale', ...expected })
      const refused = await post(s, '/api/chat/start', { session_id: sid, message: 'hello' })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ type: 'agent_runtime_stale', condition: 'agent_runtime_stale', ...expected })
      expect((await s.deps.sessionStore.get(sid)).pending_user_message).toBeNull()
      sidecar.respond('runtime.ensure_current', undefined)
      sidecar.respond('chat.start', fail)
      const start = await (await post(s, '/api/chat/start', { session_id: sid, message: 'hello' })).json() as { stream_id: string }
      const path = `/api/chat/stream?stream_id=${start.stream_id}`
      for (let replay = 0; replay < 2; replay++) {
        const frames = await s.sse(path, (frame) => frame.event === 'stream_end')
        expect(frames.find((frame) => frame.event === 'apperror')?.data).toMatchObject({ type: 'agent_runtime_stale', condition: 'agent_runtime_stale', ...expected })
      }
    } finally { await s.close() }
  })
})
