import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SidecarParams, SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import type { Message } from './session.js'

type Json = Record<string, unknown>

function completed(params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> {
  return {
    status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

const SUMMARY = { role: 'user', content: '[Context compaction: earlier question and answer]' }
const HIDDEN = { role: 'user', content: '[IMPORTANT: Background process proc_1 completed (exit_code=0).]', _source: 'process_wakeup' }
const FOLLOWUP = { role: 'assistant', content: 'followup to the wakeup' }

/** The reproduced compressed session: display shows four rows, the model context replaced the first turn with a summary. */
const DISPLAY: Json[] = [
  { role: 'user', content: 'earlier user', timestamp: 1 },
  { role: 'assistant', content: 'answer', timestamp: 2 },
  { role: 'user', content: 'u2', timestamp: 3 },
  { role: 'assistant', content: 'a2', timestamp: 4 },
]

/** TAL-1027: Retry and Undo remove the selected display turn from the model context, not the context's own last user row. */
describe('retry and undo cut the model context at the selected turn (TAL-1027)', () => {
  let s: TestServer
  let history: Json[] = []
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', (params) => { history = params.conversation_history; return completed(params) })
  beforeAll(async () => { s = await bootTestServer({ sidecar }) })
  afterAll(() => s.close())

  const post = (path: string, body: Json): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const contents = (rows: unknown[]): unknown[] => rows.map((m) => (m as Message).content)

  async function seeded(messages: Json[], context: Json[]): Promise<string> {
    const session = await s.deps.sessionStore.newSession()
    session.messages = structuredClone(messages)
    session.context_messages = structuredClone(context)
    await s.deps.sessionStore.save(session)
    return session.session_id
  }

  /** The persisted context after a cold reload, and the history the next real chat.start sends the model. */
  async function afterReload(sid: string): Promise<{ persisted: unknown[]; sent: unknown[] }> {
    s.deps.sessionStore.sessions.delete(sid)
    const persisted = contents((await s.deps.sessionStore.get(sid)).context_messages)
    history = []
    const start = await post('/api/chat/start', { session_id: sid, message: 'next prompt' })
    expect(start.status, await start.clone().text()).toBe(200)
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    return { persisted, sent: contents(history) }
  }

  it.each(['/api/session/retry', '/api/session/undo'])('%s drops the selected turn and the hidden work after it, keeping the summary', async (path) => {
    const sid = await seeded(DISPLAY, [SUMMARY, DISPLAY[2]!, DISPLAY[3]!, HIDDEN, FOLLOWUP])
    const res = await post(path, { session_id: sid })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, removed_count: 2 })
    const { persisted, sent } = await afterReload(sid)
    expect(persisted).toEqual([SUMMARY.content])
    expect(sent).toEqual([SUMMARY.content])
  })

  it('removes a turn the server just settled without clearing the earlier context', async () => {
    const sid = await seeded(DISPLAY.slice(0, 2), DISPLAY.slice(0, 2))
    await afterReload(sid)
    expect(contents((await s.deps.sessionStore.get(sid)).context_messages)).toEqual(['earlier user', 'answer', 'next prompt', 'answer'])
    expect((await post('/api/session/undo', { session_id: sid })).status).toBe(200)
    const { persisted, sent } = await afterReload(sid)
    expect(persisted).toEqual(['earlier user', 'answer'])
    expect(sent).toEqual(['earlier user', 'answer'])
  })

  const IDS: Json[] = [
    { role: 'user', content: 'go', id: 'd1', timestamp: 1 },
    { role: 'assistant', content: 'one', id: 'r1', timestamp: 2 },
    { role: 'user', content: 'go', id: 'd2', timestamp: 3 },
    { role: 'assistant', content: 'two', id: 'r2', timestamp: 4 },
  ]
  const NO_IDENTITY: Json[] = [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'one' },
    { role: 'user', content: 'second' }, { role: 'assistant', content: 'two' },
  ]
  const tool = (content: string): Json => ({ role: 'tool', content, tool_call_id: 't' })

  it.each([
    {
      name: 'repeated text matches the selected row by id',
      display: IDS,
      context: [SUMMARY, IDS[0]!, IDS[1]!, IDS[2]!, tool('removed tool work'), IDS[3]!, HIDDEN, FOLLOWUP],
      persisted: [SUMMARY.content, 'go', 'one'],
    },
    {
      name: 'a conflicting id never matches by text',
      display: [IDS[0]!, IDS[1]!, { ...IDS[2]!, id: 'd3' }, IDS[3]!],
      context: [SUMMARY, IDS[2]!, IDS[3]!, HIDDEN, FOLLOWUP],
      persisted: [],
    },
    {
      name: 'a conflicting timestamp never matches by text',
      display: [{ role: 'user', content: 'go', timestamp: 1 }, { role: 'assistant', content: 'one', timestamp: 2 }, { role: 'user', content: 'go', timestamp: 3 }, { role: 'assistant', content: 'two', timestamp: 4 }],
      context: [SUMMARY, { role: 'user', content: 'go', timestamp: 9 }, { role: 'assistant', content: 'two', timestamp: 4 }],
      persisted: [],
    },
    {
      name: 'a selected row compaction folded into the summary clears the later context',
      display: DISPLAY,
      context: [SUMMARY, HIDDEN, FOLLOWUP],
      persisted: [],
    },
    {
      name: 'rows without ids or timestamps match by unique text',
      display: NO_IDENTITY,
      context: [SUMMARY, NO_IDENTITY[2]!, tool('removed tool work'), NO_IDENTITY[3]!, HIDDEN, FOLLOWUP],
      persisted: [SUMMARY.content],
    },
    {
      name: 'an uncompressed context keeps every earlier row',
      display: NO_IDENTITY,
      context: [NO_IDENTITY[0]!, NO_IDENTITY[1]!, NO_IDENTITY[2]!, NO_IDENTITY[3]!, HIDDEN, FOLLOWUP],
      persisted: ['first', 'one'],
    },
  ])('$name', async ({ display, context, persisted: expected }) => {
    for (const path of ['/api/session/retry', '/api/session/undo']) {
      const sid = await seeded(display, context)
      expect((await post(path, { session_id: sid })).status, path).toBe(200)
      const { persisted, sent } = await afterReload(sid)
      expect(persisted, path).toEqual(expected)
      // A cleared context falls back to the kept display rows; either way the removed turn never reaches the model.
      expect(sent, path).toEqual(expected.length ? expected : contents(display.slice(0, 2)))
    }
  })
})
