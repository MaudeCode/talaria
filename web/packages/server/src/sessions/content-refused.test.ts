import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type { SidecarParams, SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, openStateDb, type TestServer } from '../test/harness.js'
import refused from '../test/fixtures/content-refused.json' with { type: 'json' }
import type { Message } from './session.js'

const ASK = 'Plan the trip'
const ANSWER = 'Here is the plan.'
const REFUSED = 'The refused ask'

function result(messages: Message[], answer: string): SidecarResultInput<'chat.start'> {
  return {
    status: 'completed', messages, final_response: answer, error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

/**
 * TAL-2057: a provider safety filter judges the whole thread, so a refused ask left in the model context refuses every later
 * message. The Agent (v0.23.1+) keeps the ask on screen as a `content_refused` row and out of its own context; Web must too.
 */
describe('a turn the provider safety filter refused', () => {
  let s: TestServer
  let respond: (params: SidecarParams<'chat.start'>) => SidecarResultInput<'chat.start'>
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', (params) => respond(params))
  beforeAll(async () => {
    s = await bootTestServer({ sidecar })
    const db = openStateDb(join(s.state, 'state.db'))
    try { db.exec(refused.schema.join('\n')) } finally { db.close() }
  })
  afterAll(() => s.close())

  /**
   * The Agent's own rows for `sid`: the fixture's `source` chat as the released Agent stored it, renumbered for this store,
   * all of them or only the messages whose content is in `contents`.
   */
  const writeAgentRows = (sid: string, source: 'retained' | 'repaired', contents?: string[]): void => {
    const db = openStateDb(join(s.state, 'state.db'))
    try {
      if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid)) db.exec(refused.inserts.find((sql) => sql.startsWith(`INSERT INTO "sessions" VALUES('${source}',`))!.replace(`'${source}'`, `'${sid}'`))
      for (const sql of refused.inserts) {
        const row = /^INSERT INTO "messages" VALUES\(\d+,'([^']+)','[^']+','([^']*)',/.exec(sql)
        if (!row || row[1] !== source || (contents && !contents.includes(row[2]!))) continue
        db.exec(sql.replace(/VALUES\(\d+,'[^']+',/, `VALUES(NULL,'${sid}',`).replace(new RegExp(`'${source}-(\\d+)'`), `'${sid}-$1'`))
      }
    } finally { db.close() }
  }

  const shown = async (sid: string): Promise<Message[]> => {
    const response = await s.get(`/api/session?session_id=${sid}`)
    expect(response.status).toBe(200)
    return ((await response.json()) as { session: { messages: Message[] } }).session.messages.filter((m) => m._display !== 'hidden')
  }

  const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

  const start = async (sid: string, message: string): Promise<void> => {
    const res = await post('/api/chat/start', { session_id: sid, message })
    expect(res.status, await res.clone().text()).toBe(200)
    const { stream_id: streamId } = await res.json() as { stream_id: string }
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
  }

  /** An ordinary turn, then one the filter refused, each answered as the released Agent answers and stores it. */
  const refusedChat = async (): Promise<string> => {
    const sid = (await s.deps.sessionStore.newSession()).session_id
    respond = (params) => {
      writeAgentRows(sid, 'retained', [ASK, ANSWER])
      return result([...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: ANSWER }], ANSWER)
    }
    await start(sid, ASK)
    respond = (params) => {
      writeAgentRows(sid, 'retained', [REFUSED])
      // The Agent hands back the history from before the refused turn and names the refusal (v0.23.1+).
      return { ...result(params.conversation_history, 'The provider\'s safety filter refused this request.'), status: 'error', failed: true, token_sent: false,
        error: 'content_policy_blocked: model declined (content_filter)', failure_reason: 'content_policy_blocked', content_refused_notice: refused.notice }
    }
    await start(sid, REFUSED)
    return sid
  }

  /** The history the next turn sends the Agent; it completes normally. */
  const nextHistory = async (sid: string): Promise<Message[]> => {
    let history: Message[] = []
    respond = (params) => {
      history = params.conversation_history
      return result([...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'Another plan.' }], 'Another plan.')
    }
    await start(sid, 'Something else')
    expect((await shown(sid)).map((m) => m.content).slice(-2)).toEqual(['Something else', 'Another plan.'])
    return history
  }

  /** The refused ask, once, as the marker the server classified, with the Agent's notice and no reply after it. */
  const expectRefusedRow = (rows: Message[]): void => {
    expect(rows.map((m) => m.content)).toEqual([ASK, ANSWER, REFUSED])
    expect(rows.at(-1)).toMatchObject({ role: 'user', _marker_kind: 'content_refused', _refused_notice: refused.notice })
    expect(rows.slice(0, 2).some((m) => m._marker_kind)).toBe(false)
  }

  // A chat only state.db holds (CLI, gateway) shows the Agent's display rows; a Web chat shows its own.
  it.each(['retained', 'repaired'] as const)('shows the ask the Agent %s as a refused marker carrying its notice', async (source) => {
    const sid = `cli-${source}`
    writeAgentRows(sid, source)
    expectRefusedRow(await shown(sid))
  })

  it('serves the shared refused example exactly as the contract fixture records it', async () => {
    const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { content_refused_session: { stored: Message[]; messages: Message[] } }).content_refused_session
    const sid = (await s.deps.sessionStore.newSession()).session_id
    const session = await s.deps.sessionStore.get(sid)
    session.messages = structuredClone(fixture.stored)
    await s.deps.sessionStore.save(session)
    const served = ((await (await s.get(`/api/session?session_id=${sid}&messages=1&msg_limit=50`)).json()) as { session: { messages: Message[] } }).session.messages
    expect(served).toEqual(fixture.messages)
  })

  it('settles the refused turn as one refused marker, without an error reply, live and after a reload', async () => {
    const sid = await refusedChat()
    expectRefusedRow(await shown(sid))
    s.deps.sessionStore.sessions.delete(sid)
    expectRefusedRow(await shown(sid))
  })

  it('retries the last answered ask, never the refused one, as the Agent never rewinds to it', async () => {
    const sid = await refusedChat()
    const retried = await (await post('/api/session/retry', { session_id: sid })).json() as { last_user_text: string; removed_count: number }
    expect(retried).toMatchObject({ last_user_text: ASK, removed_count: 3 })
  })

  const useSaveMode = (mode: 'deferred' | 'eager'): void => {
    const turns = s.deps.turns as unknown as { deps: { saveMode: () => 'deferred' | 'eager' } }
    const saveMode = turns.deps.saveMode
    turns.deps.saveMode = () => mode
    onTestFinished(() => { turns.deps.saveMode = saveMode })
  }

  /** The model history the turn after the refusal sends, from a cold reload of the chat or of a fork of it. */
  const historyAfter = async (sid: string, way: 'reload' | 'display-row fallback' | 'fork' | 'fork of the display-row fallback'): Promise<unknown[]> => {
    if (way.includes('display-row')) {
      const session = await s.deps.sessionStore.get(sid)
      session.context_messages = []
      await s.deps.sessionStore.save(session)
    }
    s.deps.sessionStore.sessions.delete(sid)
    let target = sid
    if (way.startsWith('fork')) {
      const res = await post('/api/session/branch', { session_id: sid })
      expect(res.status, await res.clone().text()).toBe(200)
      target = ((await res.json()) as { session_id: string }).session_id
      expectRefusedRow(await shown(target))
    }
    return (await nextHistory(target)).map((m) => m.content)
  }

  // An eager save keeps the prompt as typed; a deferred save restores it at settlement (TAL-578).
  it.each((['reload', 'display-row fallback', 'fork', 'fork of the display-row fallback'] as const).flatMap((way) => (['deferred', 'eager'] as const).map((mode) => [way, mode] as const)))(
    'keeps the refused ask out of the next turn\'s model context after a %s (%s save)', async (way, mode) => {
      useSaveMode(mode)
      expect(await historyAfter(await refusedChat(), way)).toEqual([ASK, ANSWER])
    })
})
