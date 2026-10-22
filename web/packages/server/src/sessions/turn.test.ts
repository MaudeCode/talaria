import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SidecarParams, SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'
import { walkSkillFiles } from '../tools/skills.js'
import { classifyProviderError } from './turn.js'
import { persistentStateSnapshot } from './state-saved.js'
import { sessionPath } from '../test/storage.js'

vi.mock('node:fs', { spy: true })
vi.mock('../tools/skills.js', { spy: true })
vi.mock('./state-saved.js', { spy: true })

const completedTurn = (params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> => ({
  status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})

it('walks 500 skills once without synchronous skill IO during an unchanged turn', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', completedTurn)
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
  sidecar.respond('chat.start', async (params) => { await turnGate; return completedTurn(params) })
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
  sidecar.respond('chat.start', completedTurn)
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
