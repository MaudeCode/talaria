import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type { SidecarParams, SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, openStateDb, type TestServer } from '../test/harness.js'
import type { Message } from './session.js'

const PLACEHOLDER = '[Message withheld: a pre_llm_call policy hook blocked it.]'
const TYPED = 'the secret plan'

function completed(messages: Message[], answer: string): SidecarResultInput<'chat.start'> {
  return {
    status: 'completed', messages, final_response: answer, error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

/** TAL-1824: a `pre_llm_call` veto stores a placeholder for the model; the transcript shows what the user typed. */
describe('a prompt a pre_llm_call hook withheld', () => {
  let s: TestServer
  let respond: (params: SidecarParams<'chat.start'>) => SidecarResultInput<'chat.start'>
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', (params) => respond(params))
  beforeAll(async () => { s = await bootTestServer({ sidecar }) })
  afterAll(() => s.close())

  const shown = async (sid: string): Promise<Message[]> => {
    const response = await s.get(`/api/session?session_id=${sid}`)
    expect(response.status).toBe(200)
    return ((await response.json()) as { session: { messages: Message[] } }).session.messages
  }

  const seedStateRows = (sid: string, rows: [string, string, string | null][]): void => {
    const db = openStateDb(join(s.state, 'state.db'))
    try {
      db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_metadata TEXT)')
      db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'cli', 1000)
      rows.forEach(([role, content, metadata], i) => db.prepare('INSERT INTO messages (session_id, role, content, timestamp, display_metadata) VALUES (?, ?, ?, ?, ?)').run(sid, role, content, 1000 + i, metadata))
    } finally { db.close() }
  }

  const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

  const start = async (sid: string, message: string): Promise<void> => {
    const res = await post('/api/chat/start', { session_id: sid, message })
    expect(res.status, await res.clone().text()).toBe(200)
    const { stream_id: streamId } = await res.json() as { stream_id: string }
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
  }

  const veto = (params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> => completed([...params.conversation_history, { role: 'user', content: PLACEHOLDER, display_metadata: { withheld_prompt: params.user_message } }, { role: 'assistant', content: 'Blocked by policy.' }], 'Blocked by policy.')

  /** A settled vetoed turn after an ordinary one, whose model context Retry or Undo cleared (TAL-1027). Cold reload: the record must survive the store. */
  const vetoedWithClearedContext = async (): Promise<string> => {
    const sid = (await s.deps.sessionStore.newSession()).session_id
    respond = (params) => completed([...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'fine' }], 'fine')
    await start(sid, 'ordinary prompt')
    respond = veto
    await start(sid, TYPED)
    expect((await shown(sid)).map((m) => m.content)).toEqual(['ordinary prompt', 'fine', TYPED, 'Blocked by policy.'])
    const session = await s.deps.sessionStore.get(sid)
    session.context_messages = []
    await s.deps.sessionStore.save(session)
    s.deps.sessionStore.sessions.delete(sid)
    return sid
  }

  it('shows the typed text for a state.db row and leaves rows without a usable field as stored', async () => {
    const session = await s.deps.sessionStore.newSession()
    const sid = session.session_id
    seedStateRows(sid, [
      ['user', PLACEHOLDER, JSON.stringify({ withheld_prompt: TYPED })],
      ['user', 'no metadata', null],
      ['user', 'other metadata', JSON.stringify({ data_use: ['no_training'] })],
      ['user', PLACEHOLDER, JSON.stringify({ withheld_prompt: 42 })],
      ['user', PLACEHOLDER, JSON.stringify({ withheld_prompt: '' })],
      ['assistant', 'a reply', JSON.stringify({ withheld_prompt: 'not a user row' })],
    ])
    expect((await shown(sid)).map((m) => m.content)).toEqual([TYPED, 'no metadata', 'other metadata', PLACEHOLDER, PLACEHOLDER, 'a reply'])
  })

  it('settles a vetoed turn as one typed row while the model keeps the placeholder on the next turn', async () => {
    const sid = (await s.deps.sessionStore.newSession()).session_id
    respond = veto
    await start(sid, TYPED)
    expect((await shown(sid)).map((m) => m.content)).toEqual([TYPED, 'Blocked by policy.'])

    // The Agent's rewritten row is not the typed text, so only the context prefix identifies this turn's own output.
    let history: Message[] = []
    respond = (params) => {
      history = params.conversation_history
      return completed([...params.conversation_history, { role: 'user', content: 'rewritten by the Agent' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'terminal', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call', content: 'tool output' }, { role: 'assistant', content: 'answer' }], 'answer')
    }
    await start(sid, 'next prompt')
    expect(history.map((m) => m.content)).toEqual([PLACEHOLDER, 'Blocked by policy.'])
    expect(JSON.stringify(history)).not.toContain(TYPED)
    expect((await shown(sid)).map((m) => m.content)).toContain('tool output')
    s.deps.sessionStore.sessions.delete(sid)
    expect(JSON.stringify((await s.deps.sessionStore.get(sid)).context_messages.map((m) => m.content))).not.toContain(TYPED)
  })

  const useSaveMode = (mode: 'deferred' | 'eager'): void => {
    const turns = s.deps.turns as unknown as { deps: { saveMode: () => 'deferred' | 'eager' } }
    const saveMode = turns.deps.saveMode
    turns.deps.saveMode = () => mode
    onTestFinished(() => { turns.deps.saveMode = saveMode })
  }

  // A deferred save settles the Agent's row; an eager save already holds the turn's checkpoint, which that row folds into.
  it.each(['deferred', 'eager'] as const)('sends the placeholder, and only that row changed, when the next turn falls back to the display rows (TAL-1878, %s save)', async (mode) => {
    useSaveMode(mode)
    const sid = await vetoedWithClearedContext()

    let history: Message[] = []
    respond = (params) => {
      history = params.conversation_history
      return completed([...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], 'answer')
    }
    await start(sid, 'next prompt')
    expect(history.map((m) => m.content)).toEqual(['ordinary prompt', 'fine', PLACEHOLDER, 'Blocked by policy.'])
    expect(JSON.stringify(history)).not.toContain(TYPED)
    expect((await shown(sid)).map((m) => m.content)).toEqual(['ordinary prompt', 'fine', TYPED, 'Blocked by policy.', 'next prompt', 'answer'])
  })

  it('forks a context that fell back to the display rows with the placeholder, keeping the typed text on screen (TAL-1878)', async () => {
    const sid = await vetoedWithClearedContext()
    seedStateRows(sid, [['user', 'a CLI continuation', null]])
    const res = await post('/api/session/branch', { session_id: sid })
    expect(res.status, await res.clone().text()).toBe(200)
    const fork = ((await res.json()) as { session_id: string }).session_id
    expect((await s.deps.sessionStore.get(fork)).context_messages.map((m) => m.content)).toEqual(['ordinary prompt', 'fine', PLACEHOLDER, 'Blocked by policy.', 'a CLI continuation'])
    expect((await shown(fork)).map((m) => m.content)).toEqual(['ordinary prompt', 'fine', TYPED, 'Blocked by policy.', 'a CLI continuation'])
  })

  describe('and the title model (TAL-1885)', () => {
    const answered = (reply: string) => (params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> => completed([...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: reply }], reply)
    const titleRequests = (): string[] => sidecar.calls.filter((c) => c.method === 'aux.complete').map((c) => JSON.stringify(c.params))
    const regenerate = (sid: string, preferLatest = false): Promise<Response> => post('/api/session/title/regenerate', { session_id: sid, prefer_latest: preferLatest })
    beforeAll(() => { sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Rollout plan review', usage: null })) })

    it.each(['deferred', 'eager'] as const)('asks it nothing for a vetoed first turn, then titles from the next ordinary turn (%s save)', async (mode) => {
      useSaveMode(mode)
      const before = titleRequests().length
      const sid = (await s.deps.sessionStore.newSession()).session_id
      respond = veto
      await start(sid, TYPED)
      expect(titleRequests().slice(before)).toEqual([])

      const refused = await regenerate(sid)
      expect(refused.status).toBe(422)
      expect(await refused.text()).toContain('There is no message to title yet.')
      expect(titleRequests().slice(before)).toEqual([])

      respond = answered('Here is the rollout.')
      await start(sid, 'plan the rollout')
      for (const preferLatest of [false, true]) expect((await regenerate(sid, preferLatest)).status).toBe(200)
      const requests = titleRequests().slice(before)
      expect(requests).toHaveLength(3)
      for (const request of requests) {
        expect(request).toContain('plan the rollout')
        expect(request).toContain('Here is the rollout.')
        expect(request).not.toContain(TYPED)
        expect(request).not.toContain('Blocked by policy.')
      }
      expect((await s.deps.sessionStore.get(sid)).title).toBe('Rollout plan review')
    })

    it('leaves the vetoed reply out when an ordinary turn came first, so the earlier prompt is not paired with it', async () => {
      const sid = await vetoedWithClearedContext()
      const before = titleRequests().length
      expect((await regenerate(sid, true)).status).toBe(200)
      const [request] = titleRequests().slice(before)
      expect(request).toContain('ordinary prompt')
      expect(request).toContain('fine')
      expect(request).not.toContain(TYPED)
      expect(request).not.toContain('Blocked by policy.')
    })
  })
})
