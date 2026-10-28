import { expect, it, vi } from 'vitest'
import { TRANSCRIPT_WINDOW, type SidecarParams, type SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import type { Message } from './session.js'
import { SessionPrefixIndex } from './prefix-index.js'

function completed(params: SidecarParams<'chat.start'>, tools = false): SidecarResultInput<'chat.start'> {
  return {
    status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, ...(tools ? [
      { role: 'assistant', content: '', tool_calls: [{ id: 'new-tool', function: { name: 'terminal', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'new-tool', content: 'result' },
    ] : []), { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

it('builds done from the same indexed window as detail for 3,000 messages', async () => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar })
  const derive = vi.spyOn(server.deps.sessions, 'backgroundUpdates')
  try {
    const session = await server.deps.sessionStore.newSession()
    session.messages = Array.from({ length: 3000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}`, timestamp: i + 1 }))
    session.messages.splice(2996, 4,
      { role: 'user', content: 'use a tool', timestamp: 2997 },
      { role: 'assistant', content: '', timestamp: 2998, tool_calls: [{ id: 'recent-tool', function: { name: 'terminal', arguments: '{}' } }] },
      { role: 'tool', content: 'tool output'.repeat(1000), tool_call_id: 'recent-tool', timestamp: 2999 },
      { role: 'assistant', content: 'tool finished', timestamp: 3000 },
    )
    await server.deps.sessionStore.save(session)
    sidecar.respond('chat.start', (params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> => {
      derive.mockClear()
      return completed(params)
    })
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    expect(start.status).toBe(200)
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=0`, (f) => f.event === 'done')
    const done = frames.find((f) => f.event === 'done')!.data as { session: Record<string, unknown> }
    const passSizes = derive.mock.calls.map(([, rows]) => rows.length)
    expect(passSizes.length).toBeGreaterThan(0)
    // The indexed reader expands to complete turns and retries when tool rows consume raw slots.
    expect.soft(Math.max(...passSizes), 'terminal per-message passes must stay within the indexed window').toBeLessThanOrEqual(TRANSCRIPT_WINDOW * 2 + 4)
    const response = await server.get(`/api/session?session_id=${session.session_id}&msg_limit=${TRANSCRIPT_WINDOW}`)
    expect(response.status).toBe(200)
    const { session: detail } = await response.json() as { session: Record<string, unknown> }
    expect(done.session.message_count).toBe(3002)
    expect(done.session.messages).toEqual(detail.messages)
    expect(done.session.tool_calls).toEqual(detail.tool_calls)
    for (const key of ['message_count', '_messages_offset', '_messages_truncated', 'todo_state']) expect(done.session[key], key).toEqual(detail[key])
    const messages = done.session.messages as Message[]
    expect(messages.some((row) => row._anchor_activity_scene)).toBe(true)
    expect(messages.find((row) => row.role === 'tool')).toMatchObject({ _content_truncated: true })
    expect(done.session.tool_calls).not.toEqual([])
  } finally { vi.restoreAllMocks(); await server.close() }
})

it.each([false, true])('indexes only appended rows across turn saves, tools=%s', async (tools) => {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', (params) => completed(params, tools))
  const server = await bootTestServer({ sidecar })
  try {
    const session = await server.deps.sessionStore.newSession()
    session.messages = Array.from({ length: 3000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}`, timestamp: i + 1 }))
    await server.deps.sessionStore.save(session)
    // Opening the chat builds its index before admission and settlement save new array snapshots.
    await server.deps.sessions.detail(session.session_id, { msg_limit: String(TRANSCRIPT_WINDOW) })
    const prefix = session.prefixIndex
    const indexed: number[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forward with the index receiver supplied to the spy.
    const extend = SessionPrefixIndex.prototype.extend
    vi.spyOn(SessionPrefixIndex.prototype, 'extend').mockImplementation(function (this: SessionPrefixIndex) {
      const from = this.length
      extend.call(this)
      indexed.push(this.length - from)
    })
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    expect(start.status).toBe(200)
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=0`, (f) => f.event === 'done')
    const done = frames.find((f) => f.event === 'done')!.data as { session: Record<string, unknown> }
    expect.soft(indexed.reduce((sum, count) => sum + count, 0), 'admission, settlement and terminal indexing must touch only appended rows').toBeLessThanOrEqual(tools ? 4 : 2)
    expect.soft(session.prefixIndex === prefix, 'the verified prefix index survives settlement').toBe(true)
    expect.soft(session.prefixIndex?.rows === session.messages, 'the index owns the live message array').toBe(true)
    expect(session.prefixIndex?.length).toBe(tools ? 3004 : 3002)
    const detail = await server.deps.sessions.detail(session.session_id, { msg_limit: String(TRANSCRIPT_WINDOW) })
    expect(done.session.messages).toEqual(detail.messages)
    expect(done.session.tool_calls).toEqual(detail.tool_calls)
  } finally { vi.restoreAllMocks(); await server.close() }
})
