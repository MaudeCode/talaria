import { describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import { classifyProviderError } from './turn.js'
import { TRANSCRIPT_WINDOW, type SidecarParams, type SidecarResultInput } from '@maudecode/talaria-web-contracts'

function completed(params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> {
  return {
    status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

it('sends the complete 120-row transcript window in done', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', completed)
  const server = await bootTestServer({ sidecar })
  try {
    const session = await server.deps.sessionStore.newSession()
    session.messages = Array.from({ length: 130 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` }))
    await server.deps.sessionStore.save(session)
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=0`, (f) => f.event === 'done')
    const done = frames.find((f) => f.event === 'done')!.data as { session: { messages: unknown[]; _messages_offset: number; message_count: number } }
    expect(TRANSCRIPT_WINDOW).toBe(120)
    expect(done.session.messages).toHaveLength(120)
    expect(done.session._messages_offset).toBe(12)
    expect(done.session.message_count).toBe(132)
  } finally { await server.close() }
})

it('sends done once the session document is written, without waiting for the index flush', async () => {
  const sidecar = new FakeSidecar()
  let releaseTurn!: () => void
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve })
  sidecar.respond('chat.start', async (params) => { await turnGate; return completed(params) })
  const server = await bootTestServer({ sidecar })
  let releaseIndex!: () => void
  const indexGate = new Promise<void>((resolve) => { releaseIndex = resolve })
  try {
    const store = server.deps.sessionStore
    const backend = store.deps.storage.sessions
    const writeIndex = backend.writeIndex.bind(backend)
    let indexSettled = false
    const session = await store.newSession()
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    await store.readIndexEntries()
    vi.spyOn(backend, 'writeIndex').mockImplementation(async (rows) => { await indexGate; await writeIndex(rows); indexSettled = true })
    releaseTurn()
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'done', { timeoutMs: 3000 })
    expect(frames.map((f) => f.event)).toContain('done')
    expect(indexSettled).toBe(false)
    releaseIndex()
    expect((await store.readIndexEntries()).find((row) => row.session_id === session.session_id)?.message_count).toBe(2)
  } finally { releaseIndex(); vi.restoreAllMocks(); await server.close() }
})


describe('classifyProviderError quota phrases', () => {
  it.each([
    'This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1234.',
    'Error code: 402 - requires more credits',
    'You can only afford 512 tokens',
    'Try fewer max_tokens',
    'Your credit balance is too low to access the API',
    'You exceeded your current quota, please check your plan',
    'usage_limit_exceeded',
    'You have reached the limit of messages for this period',
    'You have used up your usage for this window',
  ])('classifies %j as out of credits', (message) => {
    expect(classifyProviderError(message).type).toBe('quota_exhausted')
  })
})
