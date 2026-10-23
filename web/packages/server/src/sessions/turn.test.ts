import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSCRIPT_WINDOW, type SidecarParams, type SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import { walkSkillFiles } from '../tools/skills.js'
import { classifyProviderError } from './turn.js'
import { persistentStateSnapshot } from './state-saved.js'
import { sessionPath } from '../test/storage.js'

vi.mock('node:fs', { spy: true })
vi.mock('../tools/skills.js', { spy: true })
vi.mock('./state-saved.js', { spy: true })

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

it('walks 500 skills once without synchronous skill IO during an unchanged turn', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', completed)
  const server = await bootTestServer({ sidecar })
  try {
    const root = join(server.state, 'skills')
    for (let i = 0; i < 500; i += 1) {
      const dir = join(root, 'custom', `skill-${String(i)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `# Skill ${String(i)}\n`)
    }
    const session = await server.deps.sessionStore.newSession()
    vi.mocked(readdirSync).mockClear()
    vi.mocked(statSync).mockClear()
    vi.mocked(walkSkillFiles).mockClear()
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    expect(start.status).toBe(200)
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'done')
    expect(frames.map((f) => f.event), JSON.stringify(frames)).toContain('done')
    expect(frames.filter((f) => f.event === 'state_saved')).toEqual([])
    expect.soft(vi.mocked(readdirSync).mock.calls.filter(([path]) => String(path).startsWith(root))).toHaveLength(0)
    expect.soft(vi.mocked(statSync).mock.calls.filter(([path]) => String(path).startsWith(root))).toHaveLength(0)
    expect(walkSkillFiles).toHaveBeenCalledTimes(1)
    expect(await vi.mocked(walkSkillFiles).mock.results[0]?.value).toHaveLength(500)
  } finally { vi.clearAllMocks(); await server.close() }
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

it('keeps Stop during the post-turn snapshot consistent with the saved terminal state', async () => {
  const actual = await vi.importActual<typeof import('./state-saved.js')>('./state-saved.js')
  let entered!: () => void
  const scanning = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const scanGate = new Promise<void>((resolve) => { release = resolve })
  let scans = 0
  vi.mocked(persistentStateSnapshot).mockImplementation(async (profile) => {
    if (++scans === 2) { entered(); await scanGate }
    return actual.persistentStateSnapshot(profile)
  })
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', completed)
  sidecar.respond('chat.interrupt', () => ({ ok: true, pending_steer: '' }))
  const server = await bootTestServer({ sidecar })
  try {
    const session = await server.deps.sessionStore.newSession()
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    await scanning
    const stopped = await server.get(`/api/chat/cancel?stream_id=${streamId}`)
    expect(await stopped.json()).toMatchObject({ cancelled: true })
    release()
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'cancel')
    await expect.poll(() => server.deps.registry.activeRuns.has(streamId)).toBe(false)
    expect(frames.filter((f) => f.event === 'cancel')).toHaveLength(1)
    expect(frames.filter((f) => f.event === 'done')).toEqual([])
    const saved = await server.deps.sessionStore.get(session.session_id)
    expect(saved.messages.at(-1)?._terminal_state).toBe('cancelled')
    expect(saved.active_stream_id).toBeNull()
    const durable = JSON.parse(readFileSync(sessionPath(server.deps.sessionStore, session.session_id), 'utf8')) as { messages: { _terminal_state?: string }[]; active_stream_id: string | null }
    expect(durable.messages.at(-1)?._terminal_state).toBe('cancelled')
    expect(durable.active_stream_id).toBeNull()
  } finally { release(); vi.mocked(persistentStateSnapshot).mockReset(); await server.close() }
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


it('keeps a newer run working when an earlier turn builds its terminal session (TAL-1520)', async () => {
  const server = await bootTestServer()
  try {
    const session = await server.deps.sessionStore.newSession()
    session.messages = [
      { role: 'user', content: 'First', _turn_id: 'old', timestamp: 100 },
      { role: 'assistant', content: 'Answer', _turn_id: 'old', timestamp: 101 },
      { role: 'user', content: 'Next', _turn_id: 'new', timestamp: 200 },
    ]
    session.active_stream_id = 'new'
    await server.deps.sessionStore.save(session)
    server.deps.registry.liveIds.add('new')
    server.deps.registry.activeRuns.set('new', { stream_id: 'new', session_id: session.session_id, started_at: 200, phase: 'running', workspace: server.state, model: null, provider: null, ephemeral: false })
    expect(await server.deps.turns.publicTerminalSession(session, 'old')).toMatchObject({ activity_phase: 'running', active_stream_id: 'new' })
  } finally { server.deps.registry.activeRuns.delete('new'); server.deps.registry.liveIds.delete('new'); await server.close() }
})


it('carries the continuing session phase in the completed foreground frame and background snapshots (TAL-1520)', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', completed)
  const server = await bootTestServer({ sidecar })
  try {
    const session = await server.deps.sessionStore.newSession()
    await server.deps.background.trackCommand(session.session_id, 'command', 'Synthetic')
    server.deps.registry.liveIds.add('background')
    await server.deps.background.setCommandStream(session.session_id, 'command', 'background')
    const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message: 'hello' }), headers: { 'content-type': 'application/json' } })
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    const frames = await server.sse(`/api/chat/stream?stream_id=${streamId}`, (frame) => frame.event === 'done')
    expect(frames.find((frame) => frame.event === 'done')?.data).toMatchObject({ terminal_state: 'completed', session: { activity_phase: 'running' } })
    const read = async () => (await server.get(`/api/background/tasks?session_id=${session.session_id}`)).json()
    expect(await read()).toMatchObject({ activity_phase: 'running' })
    await server.deps.background.settleCommand(session.session_id, 'command', 'completed', 'Done')
    expect(await read()).toMatchObject({ activity_phase: 'completed' })
  } finally { server.deps.registry.liveIds.delete('background'); await server.close() }
})
