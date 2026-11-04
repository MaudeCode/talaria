import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  it('shows the typed text for a state.db row and leaves rows without a usable field as stored', async () => {
    const session = await s.deps.sessionStore.newSession()
    const sid = session.session_id
    const db = openStateDb(join(s.state, 'state.db'))
    try {
      db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_metadata TEXT)')
      db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'cli', 1000)
      const rows: [string, string, string | null][] = [
        ['user', PLACEHOLDER, JSON.stringify({ withheld_prompt: TYPED })],
        ['user', 'no metadata', null],
        ['user', 'other metadata', JSON.stringify({ data_use: ['no_training'] })],
        ['user', PLACEHOLDER, JSON.stringify({ withheld_prompt: 42 })],
        ['user', PLACEHOLDER, JSON.stringify({ withheld_prompt: '' })],
        ['assistant', 'a reply', JSON.stringify({ withheld_prompt: 'not a user row' })],
      ]
      rows.forEach(([role, content, metadata], i) => db.prepare('INSERT INTO messages (session_id, role, content, timestamp, display_metadata) VALUES (?, ?, ?, ?, ?)').run(sid, role, content, 1000 + i, metadata))
    } finally { db.close() }
    expect((await shown(sid)).map((m) => m.content)).toEqual([TYPED, 'no metadata', 'other metadata', PLACEHOLDER, PLACEHOLDER, 'a reply'])
  })

  it('settles a vetoed turn as one typed row while the model keeps the placeholder on the next turn', async () => {
    const sid = (await s.deps.sessionStore.newSession()).session_id
    const start = async (message: string): Promise<void> => {
      const res = await s.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: sid, message }), headers: { 'content-type': 'application/json' } })
      expect(res.status, await res.clone().text()).toBe(200)
      const { stream_id: streamId } = await res.json() as { stream_id: string }
      await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    }
    respond = (params) => completed([...params.conversation_history, { role: 'user', content: PLACEHOLDER, display_metadata: { withheld_prompt: params.user_message } }, { role: 'assistant', content: 'Blocked by policy.' }], 'Blocked by policy.')
    await start(TYPED)
    expect((await shown(sid)).map((m) => m.content)).toEqual([TYPED, 'Blocked by policy.'])

    // The Agent's rewritten row is not the typed text, so only the context prefix identifies this turn's own output.
    let history: Message[] = []
    respond = (params) => {
      history = params.conversation_history
      return completed([...params.conversation_history, { role: 'user', content: 'rewritten by the Agent' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'terminal', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call', content: 'tool output' }, { role: 'assistant', content: 'answer' }], 'answer')
    }
    await start('next prompt')
    expect(history.map((m) => m.content)).toEqual([PLACEHOLDER, 'Blocked by policy.'])
    expect(JSON.stringify(history)).not.toContain(TYPED)
    expect((await shown(sid)).map((m) => m.content)).toContain('tool output')
    s.deps.sessionStore.sessions.delete(sid)
    expect(JSON.stringify((await s.deps.sessionStore.get(sid)).context_messages.map((m) => m.content))).not.toContain(TYPED)
  })
})
