import { describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

const post = (s: TestServer, path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('Agent recovery readiness across HTTP and replay', () => {
  it.each([
    ['incomplete', false, 'recovery_incomplete', 'Agent update recovery is incomplete'],
    ['active', true, 'update_active', 'Agent update is in progress'],
    ['unknown', true, 'unknown', 'Agent runtime is unavailable; check the Agent update outcome'],
    ['stale', true, 'unknown', 'Agent runtime is unavailable; check the Agent update outcome'],
    ['unverified', true, 'source_changed', 'Agent source changed; check the update outcome before restarting Talaria Web'],
    ['unverified', false, 'unknown', 'Agent runtime is unavailable; check the Agent update outcome'],
    [undefined, undefined, 'unknown', 'Agent runtime is unavailable; check the Agent update outcome'],
  ])('preserves %s recovery without inferring success from the message', async (state, changed, reason, message) => {
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
        const reloaded = await (await s.get(`/api/session?session_id=${sid}`)).json() as { session: { messages: { _error?: boolean; content: string; provider_details?: string }[] } }
        const errorRow = reloaded.session.messages.find((row) => row._error)
        expect(errorRow?.content).toContain(message)
        expect(errorRow?.content).not.toContain('Agent updated successfully')
        expect(errorRow?.provider_details).not.toContain('Agent updated successfully')
      }
    } finally { await s.close() }
  })

  it('refreshes recovery transitions for a stale incompatible handshake and fails closed on probe errors', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    const chat = async () => (await (await s.get('/api/health/agent')).json() as { chat: unknown }).chat
    sidecar.status = 'incompatible'
    sidecar.describe = { ...sidecar.describe!, stale: true, update_state: 'active' }
    try {
      for (const [state, reason] of [['active', 'update_active'], ['incomplete', 'recovery_incomplete'], ['stale', 'unknown'], ['unknown', 'unknown'], ['unverified', 'source_changed']] as const) {
        sidecar.respond('runtime.ensure_current', (_params, _emit, opts) => {
          expect(opts.timeoutMs).toBeLessThanOrEqual(5_000)
          throw new SidecarError('Agent updated successfully', { condition: 'agent_runtime_stale', data: { agent_update_state: state, agent_source_changed: true } })
        })
        expect(await chat()).toMatchObject({ available: false, condition: 'agent_runtime_stale', agent_update_state: state, agent_runtime_reason: reason })
      }
      // A restored source does not bypass the client's incompatible admission gate or reuse the old active verdict.
      sidecar.respond('runtime.ensure_current', undefined)
      expect(await chat()).toMatchObject({ available: false, condition: 'agent_runtime_stale', agent_runtime_reason: 'unknown' })
      for (const error of [new SidecarError('probe timed out', { condition: 'sidecar_timeout' }), new Error('probe failed')]) {
        sidecar.respond('runtime.ensure_current', () => { throw error })
        expect(await chat()).toEqual({ available: false, condition: 'sidecar_unavailable' })
      }
    } finally { await s.close() }
  })
})
