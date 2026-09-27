/**
 * One-to-one ports of the Python chat-stream, cancel, journal, projection,
 * and persistence regression cases (TAL-245). Markers `[py:<file>::<case>]`
 * are verified by scripts/check-regression-port.py.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { redactSessionData, stripPublicInternalFields } from '../redact.js'
import { allSessions } from '../sessions/list.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
type ChatResult = SidecarResult<'chat.start'>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const completed = (messages: Json[], extra: Partial<ChatResult> = {}): ChatResult => ({
  status: 'completed', messages, final_response: str(messages[messages.length - 1]?.content), error: null, result_status: 'completed', tool_limit_reached: false,
  usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [], ...extra,
})

async function newSession(s: TestServer): Promise<string> {
  const res = await post(s, '/api/session/new', {})
  expect(res.status).toBe(200)
  return String(((await json(res)).session as Json).session_id)
}
const detail = async (s: TestServer, sid: string): Promise<Json> => (await json(await s.get(`/api/session?session_id=${sid}&messages=1`))).session as Json
const messagesOf = async (s: TestServer, sid: string): Promise<Json[]> => (await detail(s, sid)).messages as Json[]

describe('run journal deletion', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())
  const write = (sid: string, run: string): void => { const w = s.deps.journal.writer(sid, run); w.appendSseEvent('token', { text: 'x' }); w.close() }

  it('[py:test_issue3802_delete_session_journals.py::test_delete_run_journal_removes_session_directory] deleting a session journal removes its directory and its events', () => {
    write('sess-a', 'run-a1')
    expect(existsSync(join(s.deps.journal.root(), 'sess-a'))).toBe(true)
    expect(s.deps.journal.deleteSession('sess-a')).toBe(true)
    expect(existsSync(join(s.deps.journal.root(), 'sess-a'))).toBe(false)
    expect(s.deps.journal.readRunEvents('sess-a', 'run-a1')).toEqual([])
  })

  it('[py:test_issue3802_delete_session_journals.py::test_delete_run_journal_leaves_other_sessions_intact] other sessions keep their journals', () => {
    write('sess-b', 'run-b1')
    write('sess-c', 'run-c1')
    expect(s.deps.journal.deleteSession('sess-b')).toBe(true)
    expect(existsSync(join(s.deps.journal.root(), 'sess-c'))).toBe(true)
  })

  it('[py:test_issue3802_delete_session_journals.py::test_delete_run_journal_noop_on_missing_or_invalid] missing, traversal, and empty ids are refused', () => {
    expect(s.deps.journal.deleteSession('never-existed')).toBe(false)
    expect(s.deps.journal.deleteSession('../sess-c')).toBe(false)
    expect(s.deps.journal.deleteSession('')).toBe(false)
  })

  it('[py:test_issue3802_delete_session_journals.py::test_delete_journals_reject_dot_traversal_ids] dot ids are refused and legitimate journals survive', () => {
    expect(s.deps.journal.deleteSession('.')).toBe(false)
    expect(s.deps.journal.deleteSession('..')).toBe(false)
    expect(existsSync(join(s.deps.journal.root(), 'sess-c'))).toBe(true)
  })

  it('deleting a session over HTTP removes its run journal', async () => {
    const sid = await newSession(s)
    write(sid, 'run-http')
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
    expect(existsSync(join(s.deps.journal.root(), sid))).toBe(false)
  })
})

describe('public projections strip internal replay fields', () => {
  const message = { role: 'assistant', content: { text: 'visible', api_content: 'nested stays' }, api_content: 'provider only', _state_db_row_id: 7, _db_row_id: 8, state_db_row_id: 9 }

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_public_message_projection_strips_internal_replay_fields] redaction strips api_content and row-id aliases from messages', () => {
    const out = redactSessionData({ session_id: 'x', messages: [message] }, false)
    const m = (out.messages as Json[])[0]!
    expect(m).not.toHaveProperty('api_content')
    for (const k of ['_state_db_row_id', '_db_row_id', 'state_db_row_id']) expect(m).not.toHaveProperty(k)
  })

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_public_session_projection_strips_context_aliases] the aliases are stripped from context_messages and the runtime journal snapshot too', () => {
    const out = redactSessionData({ session_id: 'x', messages: [message], context_messages: [message], runtime_journal_snapshot: { messages: [message] } }, false)
    expect((out.context_messages as Json[])[0]).not.toHaveProperty('api_content')
    expect(((out.runtime_journal_snapshot as Json).messages as Json[])[0]).not.toHaveProperty('_state_db_row_id')
  })

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_public_projection_preserves_non_message_alias_keys] alias-named keys inside message content survive while session tool_calls are scrubbed', () => {
    const out = redactSessionData({ session_id: 'x', messages: [message], tool_calls: [{ name: 't', api_content: 'gone', _state_db_row_id: 1 }] }, false)
    expect(((out.messages as Json[])[0]!.content as Json).api_content).toBe('nested stays')
    expect((out.tool_calls as Json[])[0]).not.toHaveProperty('api_content')
  })

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_schema_scrubber_preserves_tool_argument_business_payload] function arguments and args payloads are opaque to the scrubber', () => {
    const args = JSON.stringify({ api_content: 'business', messages: [{ api_content: 'still business' }] })
    const out = stripPublicInternalFields({ messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: args } }] }], runtime_journal_snapshot: { messages: [{ role: 'tool', args: { messages: [{ api_content: 'kept' }] } }] } }) as Json
    expect(((((out.messages as Json[])[0]!.tool_calls as Json[])[0]!.function as Json).arguments)).toBe(args)
  })

  it('[py:test_issue6757_redaction_and_runner_sse_fixes.py::test_redact_session_data_preserves_credential_shaped_workspace_path] workspace paths stay verbatim while api_content is stripped', () => {
    const out = redactSessionData({ session_id: 'x', workspace: '/home/u/sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123-project', messages: [message] }, true)
    expect(out.workspace).toContain('sk-ant-api03-')
    expect((out.messages as Json[])[0]).not.toHaveProperty('api_content')
  })

  it('[py:test_issue6757_redaction_and_runner_sse_fixes.py::test_redact_session_data_still_strips_api_content_from_messages] redaction strips the aliases from messages and context while keeping visible content', () => {
    const out = redactSessionData({ session_id: 'x', messages: [{ ...message, content: 'visible' }], context_messages: [{ ...message, content: 'ctx' }] }, true)
    expect((out.messages as Json[])[0]).toMatchObject({ content: 'visible' })
    expect((out.messages as Json[])[0]).not.toHaveProperty('api_content')
    expect((out.context_messages as Json[])[0]).toMatchObject({ content: 'ctx' })
    expect((out.context_messages as Json[])[0]).not.toHaveProperty('_db_row_id')
  })
})

describe('session persistence and streaming flags', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('[py:test_issue765_streaming_persistence.py::test_save_writes_json_file] save writes the session JSON with its id and messages', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'persist me' }]
    s.deps.sessionStore.save(session)
    const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
    expect(raw.session_id).toBe(sid)
    expect((raw.messages as Json[])[0]).toMatchObject({ role: 'user', content: 'persist me' })
  })

  it('[py:test_issue765_streaming_persistence.py::test_save_without_skip_index_creates_index] a default save creates the sidebar index containing the id', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'indexed' }]
    s.deps.sessionStore.save(session)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(sid)
  })

  it('[py:test_issue765_streaming_persistence.py::test_pending_message_survives_simulated_restart] pending prompt, start time, and stream id survive a reload from disk', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.pending_user_message = 'still pending'
    session.pending_started_at = 1234.5
    session.active_stream_id = 'stream-restart'
    s.deps.sessionStore.save(session)
    s.deps.sessionStore.sessions.delete(sid)
    const reloaded = s.deps.sessionStore.get(sid)
    expect(reloaded).toMatchObject({ pending_user_message: 'still pending', pending_started_at: 1234.5, active_stream_id: 'stream-restart' })
  })

  it('[py:test_issue856_session_streaming_state.py::test_all_sessions_marks_indexed_and_in_memory_streaming_sessions] live stream ids mark both indexed and in-memory sessions as streaming', async () => {
    const indexed = await newSession(s)
    const inMemory = await newSession(s)
    for (const [sid, stream] of [[indexed, 'live-1'], [inMemory, 'live-2']] as const) {
      const session = s.deps.sessionStore.get(sid)
      session.messages = [{ role: 'user', content: 'hi' }]
      session.active_stream_id = stream
      s.deps.sessionStore.save(session)
      s.deps.registry.liveIds.add(stream)
    }
    s.deps.sessionStore.sessions.delete(indexed)
    const rows = allSessions(s.deps.sessionStore)
    for (const sid of [indexed, inMemory]) expect(rows.find((r) => r.session_id === sid)).toMatchObject({ is_streaming: true })
    expect(rows.find((r) => r.session_id === indexed)?.active_stream_id).toBe('live-1')
    s.deps.registry.liveIds.delete('live-1')
    s.deps.registry.liveIds.delete('live-2')
  })

  it('[py:test_issue856_session_streaming_state.py::test_all_sessions_marks_streaming_false_when_stream_is_not_active] a stale stream id is not streaming until the registry holds it', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'hi' }]
    session.active_stream_id = 'stale-9'
    s.deps.sessionStore.save(session)
    expect(allSessions(s.deps.sessionStore).find((r) => r.session_id === sid)?.is_streaming).toBe(false)
    s.deps.registry.liveIds.add('stale-9')
    expect(allSessions(s.deps.sessionStore).find((r) => r.session_id === sid)?.is_streaming).toBe(true)
    s.deps.registry.liveIds.delete('stale-9')
    expect(allSessions(s.deps.sessionStore).find((r) => r.session_id === sid)?.is_streaming).toBe(false)
  })

  it('[py:test_issue856_session_streaming_state.py::test_all_sessions_does_not_report_streaming_after_restart_without_active_registry] a persisted stream id does not resurrect streaming after a restart', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'hi' }]
    session.active_stream_id = 'gone-after-restart'
    s.deps.sessionStore.save(session)
    s.deps.sessionStore.sessions.delete(sid)
    const row = allSessions(s.deps.sessionStore).find((r) => r.session_id === sid)
    expect(row?.active_stream_id).toBe('gone-after-restart')
    expect(row?.is_streaming).toBe(false)
  })

  it('[py:test_issue2157_sessions_list_stale_stream_state.py::test_sessions_list_reconciles_stale_stream_state_before_serializing] the HTTP list repairs a stale stream id before serialising', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'hi' }]
    session.active_stream_id = 'stale-list'
    s.deps.sessionStore.save(session)
    const rows = (await json(await s.get('/api/sessions'))).sessions as Json[]
    expect(rows.find((r) => r.session_id === sid)).toMatchObject({ active_stream_id: null, is_streaming: false })
  })

  it('[py:test_issue5532_session_clear_state_db_replay.py::test_session_clear_persists_empty_context_and_blocks_state_db_replay] clear persists empty transcript, context, and tool calls with a clear generation', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
    session.context_messages = [{ role: 'user', content: 'hi' }]
    session.tool_calls = [{ name: 't' }]
    s.deps.sessionStore.save(session)
    const res = await post(s, '/api/session/clear', { session_id: sid })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect((body.session as Json).active_stream_id ?? null).toBeNull()
    expect((body.session as Json).pending_user_message ?? null).toBeNull()
    const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
    expect(raw.messages).toEqual([])
    expect(raw.context_messages).toEqual([])
    expect(raw.tool_calls).toEqual([])
    expect(String(raw.clear_generation)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('chat streams, cancel, and error settlement', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => { sidecar = new FakeSidecar(); s = await bootTestServer({ sidecar }) })
  afterAll(() => s.close())
  const start = async (sid: string, message: string): Promise<string> => {
    const res = await post(s, '/api/chat/start', { session_id: sid, message })
    expect(res.status, await res.clone().text()).toBe(200)
    return String((await json(res)).stream_id)
  }
  const frames = (streamId: string, until: (f: SseFrame) => boolean): Promise<SseFrame[]> => s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, until)
  const terminal = (f: SseFrame): boolean => ['done', 'apperror', 'cancel'].includes(f.event)
  /** A turn that streams the given frames and then waits to be cancelled. */
  const cancellable = (emits: { event: string; data: Json }[]): void => {
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      for (const e of emits) emit(e)
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
  }
  const cancelTurn = async (sid: string, message = 'go'): Promise<{ streamId: string; frames: SseFrame[] }> => {
    const streamId = await start(sid, message)
    await frames(streamId, (f) => f.event !== 'initial' && f.event !== 'status')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    const out = await frames(streamId, (f) => f.event === 'cancel')
    return { streamId, frames: out }
  }

  it('[py:test_issue_1584_multitab_sse.py::test_same_stream_in_two_tabs_receives_identical_token_sequence] two subscribers to one stream receive the identical token sequence', async () => {
    const sid = await newSession(s)
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'one ' } })
      release = () => { emit({ event: 'token', data: { text: 'two' } }); resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'one two' }])) }
    }))
    const streamId = await start(sid, 'tabs')
    const tabs = Promise.all([frames(streamId, (f) => f.event === 'stream_end' || f.event === 'done'), frames(streamId, (f) => f.event === 'stream_end' || f.event === 'done')])
    await new Promise((r) => setTimeout(r, 50))
    release()
    const [a, b] = await tabs
    const tokens = (fs: SseFrame[]): string[] => fs.filter((f) => f.event === 'token').map((f) => String((f.data as Json).text))
    expect(tokens(a)).toEqual(['one ', 'two'])
    expect(tokens(b)).toEqual(tokens(a))
  })

  it('[py:test_issue4948_local_stale_approval.py::test_stale_id_while_different_approval_live_still_blocked] a stale approval id while another approval is live answers ok:false and leaves it pending', async () => {
    const sid = await newSession(s)
    sidecar.respond('approval.respond', () => ({ ok: true, resolved: 1, choice: 'once' }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'approval', data: { request_id: 'live-approval', pattern_key: 'rm', command: 'rm -rf x', tool_name: 'terminal', cwd: '' } })
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
    const streamId = await start(sid, 'dangerous')
    await s.sse(`/api/approval/stream?session_id=${sid}`, (f) => Boolean((f.data as Json).pending))
    const pendingBefore = await json(await s.get(`/api/approval/pending?session_id=${sid}`))
    expect(pendingBefore.pending_count).toBe(1)
    const res = await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'deny', approval_id: 'stale-other' }))
    expect(res.ok).toBe(false)
    expect(res).not.toHaveProperty('stale_cleared')
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending_count).toBe(1)
    await s.get(`/api/chat/cancel?stream_id=${streamId}`)
    await frames(streamId, (f) => f.event === 'cancel')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_with_reasoning_only_preserves_reasoning] cancel after reasoning only persists a partial carrying the reasoning', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'reasoning', data: { text: 'deep thought' } }])
    await cancelTurn(sid)
    const partial = (await messagesOf(s, sid)).find((m) => m._partial)
    expect(partial).toBeDefined()
    expect(String(partial?.reasoning)).toContain('deep thought')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_reasoning_only_creates_partial_message] reasoning with empty text still yields a partial message', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'reasoning', data: { text: 'just reasoning' } }])
    await cancelTurn(sid)
    expect((await messagesOf(s, sid)).some((m) => m._partial)).toBe(true)
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_with_reasoning_and_partial_tokens_preserves_both] reasoning and visible tokens both survive on the partial', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'reasoning', data: { text: 'why' } }, { event: 'token', data: { text: 'visible part' } }])
    await cancelTurn(sid)
    const partial = (await messagesOf(s, sid)).find((m) => m._partial)
    expect(partial).toMatchObject({ content: 'visible part' })
    expect(String(partial?.reasoning)).toContain('why')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_with_tool_calls_preserves_tools] live tool calls survive on the partial', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'ls' }, tid: 'call-1' } }, { event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'a b', args: { command: 'ls' }, tid: 'call-1', is_error: false } }])
    await cancelTurn(sid)
    const partial = (await messagesOf(s, sid)).find((m) => m._partial)
    expect(partial, JSON.stringify(await messagesOf(s, sid))).toBeDefined()
    expect(JSON.stringify(partial)).toContain('terminal')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_tools_only_creates_partial_message] tools with no text still yield a partial', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', preview: null, args: { path: 'x' }, tid: 'call-2' } }])
    await cancelTurn(sid)
    expect((await messagesOf(s, sid)).some((m) => m._partial)).toBe(true)
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_with_tools_and_text_preserves_both] tools plus partial text both survive', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', preview: null, args: { path: 'x' }, tid: 'call-3' } }, { event: 'token', data: { text: 'after tool' } }])
    await cancelTurn(sid)
    const partial = (await messagesOf(s, sid)).find((m) => m._partial)
    expect(partial).toMatchObject({ content: 'after tool' })
    expect(JSON.stringify(partial)).toContain('read_file')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_no_reasoning_no_tools_no_partial] cancel with nothing streamed leaves one cancel marker and no partial', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'status', data: { text: 'starting' } }])
    await cancelTurn(sid)
    const messages = await messagesOf(s, sid)
    expect(messages.some((m) => m._partial)).toBe(false)
    // TAL-364: one neutral Stop row — its outcome is the status, with no copy for clients to repeat.
    const stops = messages.filter((m) => m._error && m._terminal_state === 'cancelled')
    expect(stops).toHaveLength(1)
    expect(stops[0]?.content).toBe('')
    expect(stops[0]?._anchor_activity_scene).toMatchObject({ terminal_state: 'cancelled', final_answer: '' })
  })

  it('[py:test_issue893_cancel_preserves_partial.py::test_cancel_stream_with_no_partial_text_still_saves_cancel_marker] an empty partial buffer saves only the cancel marker', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'status', data: { text: 'starting' } }])
    await cancelTurn(sid)
    const messages = await messagesOf(s, sid)
    expect(messages.some((m) => m._partial)).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue893_cancel_preserves_partial.py::test_cancel_stream_strips_thinking_markup_from_partial] a closed think block is stripped from the persisted partial', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'token', data: { text: '<think>hidden</think>shown' } }])
    await cancelTurn(sid)
    const partial = (await messagesOf(s, sid)).find((m) => m._partial)
    expect(String(partial?.content)).toBe('shown')
    expect(String(partial?.content)).not.toContain('hidden')
  })

  it('[py:test_issue893_cancel_preserves_partial.py::test_cancel_stream_strips_unclosed_think_tag] an unclosed think block leaves nothing visible, so no partial is saved', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'token', data: { text: '<think>still thinking' } }])
    await cancelTurn(sid)
    const messages = await messagesOf(s, sid)
    expect(messages.some((m) => m._partial && String(m.content).trim())).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_event_payload_includes_partial_session_snapshot] the terminal cancel frame carries the settled session snapshot', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'reasoning', data: { text: 'r' } }, { event: 'token', data: { text: 'partial text' } }])
    const { frames: out } = await cancelTurn(sid)
    const cancel = out.find((f) => f.event === 'cancel')?.data as Json
    expect(cancel).toMatchObject({ type: 'cancelled', status: 'cancelled', session_id: sid })
    const last = ((cancel.session as Json).messages as Json[]).find((m) => m._partial)
    expect(last).toMatchObject({ content: 'partial text' })
    expect(String(last?.reasoning)).toContain('r')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_stream_does_not_duplicate_existing_worker_cancel_marker] a second cancel does not add a second marker', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'token', data: { text: 'p' } }])
    const { streamId } = await cancelTurn(sid)
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).ok).toBe(true)
    const messages = await messagesOf(s, sid)
    expect(messages.filter((m) => m._error && m._terminal_state === 'cancelled')).toHaveLength(1)
    expect(messages.findIndex((m) => m._partial)).toBeLessThan(messages.findIndex((m) => m._error))
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_late_cancel_after_worker_finalized_does_not_add_cancel_marker] cancelling a finished turn changes nothing', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'finished' }]))
    const streamId = await start(sid, 'quick')
    await frames(streamId, terminal)
    const before = await messagesOf(s, sid)
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).toMatchObject({ ok: true, cancelled: false })
    expect(await messagesOf(s, sid)).toEqual(before)
  })

  /** TAL-364: a completed first turn, so the stopped turn has earlier context to keep. Returns that context. */
  const earlierTurn = async (sid: string): Promise<Json[]> => {
    let sent = ''
    sidecar.respond('chat.start', (params) => { sent = str(params.user_message); return completed([{ role: 'user', content: sent }, { role: 'assistant', content: 'I will inspect it.' }]) })
    await frames(await start(sid, 'Inspect the deployment'), terminal)
    return [{ role: 'user', content: sent }, { role: 'assistant', content: 'I will inspect it.' }]
  }
  /** TAL-364: the `conversation_history` the follow-up turn's actual `chat.start` request carries. */
  const nextHistory = async (sid: string): Promise<Json[]> => {
    let history: Json[] = []
    sidecar.respond('chat.start', (params) => { history = params.conversation_history; return completed([...history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'next answer' }]) })
    await frames(await start(sid, 'What next?'), terminal)
    return history
  }
  /** TAL-364: a turn that streams `emits`, then blocks until it is aborted; resolves with the prompt the Agent received. */
  const blockingTurn = (emits: { event: string; data: Json }[]): Promise<string> => new Promise((started) => {
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      for (const e of emits) emit(e)
      started(str(params.user_message))
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([]), status: 'cancelled' }) })
    }))
  })
  const toolCall: Json = { role: 'assistant', content: '', tool_calls: [{ id: 'call-rollout', type: 'function', function: { name: 'terminal', arguments: '{"command":"kubectl get pods"}' } }] }
  const toolResult: Json = { role: 'tool', name: 'terminal', tool_call_id: 'call-rollout', content: 'api-7d9f Ready; worker-2 CrashLoopBackOff' }
  const toolFrames = [
    { event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'kubectl get pods' }, tid: 'call-rollout' } },
    { event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'worker-2 CrashLoopBackOff', args: { command: 'kubectl get pods' }, tid: 'call-rollout', is_error: false } },
  ]

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_preserves_agent_tool_history_for_next_turn_and_browser] Stop keeps the completed tool work and unfinished prose in the next model request (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let prompt = ''
    sidecar.respond('chat.interrupt', () => ({ ok: true, checkpoint: [...earlier, { role: 'user', content: prompt }, toolCall, toolResult] }))
    const started = blockingTurn([{ event: 'reasoning', data: { text: 'private chain of thought' } }, ...toolFrames, { event: 'token', data: { text: 'The rollout issue is worker-2, and I was preparing the fix.' } }])
    const streamId = await start(sid, 'Check the rollout and fix what you find')
    prompt = await started
    await frames(streamId, (f) => f.event === 'token')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    const cancel = (await frames(streamId, (f) => f.event === 'cancel')).find((f) => f.event === 'cancel')?.data as Json
    // The terminal snapshot and a reload keep the visible work.
    for (const rows of [(cancel.session as Json).messages as Json[], await messagesOf(s, sid)]) {
      expect(rows.find((m) => m._partial)).toMatchObject({ content: 'The rollout issue is worker-2, and I was preparing the fix.' })
    }
    const history = await nextHistory(sid)
    expect(history).toEqual([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, { role: 'assistant', content: 'The rollout issue is worker-2, and I was preparing the fix.' }])
    expect(JSON.stringify(history)).not.toMatch(/Task cancelled|Stopped|private chain of thought/)
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_cancel_keeps_unfinished_streamed_prose_in_next_turn_context] Stop during streamed prose keeps the prompt and the prose when the Agent has no checkpoint yet (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    const started = blockingTurn([{ event: 'reasoning', data: { text: 'hidden reasoning' } }, { event: 'token', data: { text: 'Half of the ' } }, { event: 'token', data: { text: 'answer' } }])
    const streamId = await start(sid, 'Explain the outage')
    const prompt = await started
    await frames(streamId, (f) => f.event === 'token')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await frames(streamId, (f) => f.event === 'cancel')
    const history = await nextHistory(sid)
    expect(history).toEqual([...earlier, { role: 'user', content: prompt }, { role: 'assistant', content: 'Half of the answer' }])
    // A second follow-up and a process restart (the session reloaded from disk) keep the same context.
    s.deps.sessionStore.sessions.delete(sid)
    expect((await nextHistory(sid)).slice(0, history.length)).toEqual(history)
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_detached_cancel_preserves_cached_agents_canonical_history] Stop with no stream subscriber still checkpoints the Agent\'s canonical work (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let prompt = ''
    sidecar.respond('chat.interrupt', () => ({ ok: true, checkpoint: [...earlier, { role: 'user', content: prompt }, { role: 'assistant', content: 'The detached worker completed its audit.' }] }))
    const started = blockingTurn([])
    const streamId = await start(sid, 'Inspect the detached worker')
    prompt = await started
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    expect(await nextHistory(sid)).toEqual([...earlier, { role: 'user', content: prompt }, { role: 'assistant', content: 'The detached worker completed its audit.' }])
  })

  it('Stop before any output or during reasoning keeps the earlier context without replaying the prompt or the reasoning (TAL-364)', async () => {
    for (const emits of [[], [{ event: 'reasoning', data: { text: 'private reasoning only' } }]]) {
      const sid = await newSession(s)
      const earlier = await earlierTurn(sid)
      sidecar.respond('chat.interrupt', () => ({ ok: true }))
      const started = blockingTurn(emits)
      const streamId = await start(sid, 'Never mind')
      await started
      expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
      await frames(streamId, (f) => f.event === 'cancel')
      expect(await nextHistory(sid)).toEqual(earlier)
    }
  })

  it('Stop during a tool call keeps completed results and never invents a result for the interrupted call (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let prompt = ''
    const pending: Json = { role: 'assistant', content: '', tool_calls: [{ id: 'call-pending', type: 'function', function: { name: 'terminal', arguments: '{"command":"sleep 600"}' } }] }
    sidecar.respond('chat.interrupt', () => ({ ok: true, checkpoint: [...earlier, { role: 'user', content: prompt }, toolCall, toolResult, pending] }))
    const started = blockingTurn([...toolFrames, { event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'sleep 600' }, tid: 'call-pending' } }])
    const streamId = await start(sid, 'Check the rollout')
    prompt = await started
    await frames(streamId, (f) => f.event === 'tool' && (f.data as Json).tid === 'call-pending')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await frames(streamId, (f) => f.event === 'cancel')
    // The completed result ends on the Agent's own closing boundary, so the next prompt never follows a tool row.
    expect(await nextHistory(sid)).toEqual([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, { role: 'assistant', content: 'Operation interrupted.' }])
  })

  it('Stop keeps a native image prompt when the Agent has no checkpoint yet (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    sidecar.respond('text.image_mode', () => ({ mode: 'native', reason: 'test', supports_vision: true }))
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    const path = join(s.state, 'workspace', 'stop-shot.png')
    writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]))
    const started = new Promise<unknown>((received) => {
      sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'The chart shows' } })
        received(params.user_message)
        opts.signal?.addEventListener('abort', () => { resolve({ ...completed([]), status: 'cancelled' }) })
      }))
    })
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'Describe this', attachments: [{ path, mime: 'image/png', name: 'stop-shot.png' }] })
    const streamId = String((await json(res)).stream_id)
    const prompt = await started
    expect(prompt).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]))
    await frames(streamId, (f) => f.event === 'token')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await frames(streamId, (f) => f.event === 'cancel')
    expect(await nextHistory(sid)).toEqual([...earlier, { role: 'user', content: prompt }, { role: 'assistant', content: 'The chart shows' }])
  })

  it('a worker result that settles the cancel before the interrupt reply writes one marker and keeps the pre-Stop checkpoint (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let prompt = ''
    let finish: () => void = () => undefined
    // The worker's result lands first and carries a tool the Agent finished while unwinding; the interrupt's snapshot
    // (taken before the Stop was signalled) arrives after it and is still the boundary.
    const lateCall: Json = { role: 'assistant', content: '', tool_calls: [{ id: 'call-unwind', type: 'function', function: { name: 'terminal', arguments: '{}' } }] }
    const lateResult: Json = { role: 'tool', name: 'terminal', tool_call_id: 'call-unwind', content: 'finished while unwinding' }
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      prompt = str(params.user_message)
      for (const e of toolFrames) emit(e)
      finish = () => { resolve({ ...completed([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, lateCall, lateResult, { role: 'assistant', content: 'Operation interrupted.' }]), status: 'cancelled' }) }
    }))
    let interrupts = 0
    sidecar.respond('chat.interrupt', async () => {
      interrupts += 1
      finish()
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true, checkpoint: [...earlier, { role: 'user', content: prompt }, toolCall, toolResult] }
    })
    const streamId = await start(sid, 'Check the rollout')
    await frames(streamId, (f) => f.event === 'tool_complete')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await frames(streamId, (f) => f.event === 'cancel')
    await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))
    expect(interrupts).toBeGreaterThanOrEqual(1)
    expect((await messagesOf(s, sid)).filter((m) => m._error)).toHaveLength(1)
    expect(await nextHistory(sid)).toEqual([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, { role: 'assistant', content: 'Operation interrupted.' }])
  })

  it('the worker\'s canonical result replaces the fallback context when the interrupt reply failed (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let prompt = ''
    sidecar.respond('chat.interrupt', () => { throw new SidecarError('interrupt timed out', { condition: 'sidecar_error' }) })
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      prompt = str(params.user_message)
      for (const e of toolFrames) emit(e)
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, { role: 'assistant', content: 'Operation interrupted.' }]), status: 'cancelled' }) })
    }))
    const streamId = await start(sid, 'Check the rollout')
    await frames(streamId, (f) => f.event === 'tool_complete')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await frames(streamId, (f) => f.event === 'cancel')
    const until = Date.now() + 5000
    while (s.deps.registry.activeRuns.has(streamId) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    expect((await messagesOf(s, sid)).filter((m) => m._error)).toHaveLength(1)
    expect(await nextHistory(sid)).toEqual([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, { role: 'assistant', content: 'Operation interrupted.' }])
  })

  it('work the Agent finishes after a checkpointed Stop stays out of the next request (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let prompt = ''
    const lateCall: Json = { role: 'assistant', content: '', tool_calls: [{ id: 'call-late', type: 'function', function: { name: 'terminal', arguments: '{"command":"kubectl rollout restart"}' } }] }
    const lateResult: Json = { role: 'tool', name: 'terminal', tool_call_id: 'call-late', content: 'restarted after the Stop' }
    sidecar.respond('chat.interrupt', () => ({ ok: true, checkpoint: [...earlier, { role: 'user', content: prompt }, toolCall, toolResult] }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      prompt = str(params.user_message)
      for (const e of toolFrames) emit(e)
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, lateCall, lateResult, { role: 'assistant', content: 'Operation interrupted.' }]), status: 'cancelled' }) })
    }))
    const streamId = await start(sid, 'Check the rollout')
    await frames(streamId, (f) => f.event === 'tool_complete')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await frames(streamId, (f) => f.event === 'cancel')
    const until = Date.now() + 5000
    while (s.deps.registry.activeRuns.has(streamId) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    expect(await nextHistory(sid)).toEqual([...earlier, { role: 'user', content: prompt }, toolCall, toolResult, { role: 'assistant', content: 'Operation interrupted.' }])
  })

  it('an eager-saved prompt is not repeated in a stopped turn\'s context (TAL-364)', async () => {
    const turns = s.deps.turns as unknown as { deps: { saveMode: () => 'deferred' | 'eager' } }
    const original = turns.deps.saveMode
    turns.deps.saveMode = () => 'eager'
    try {
      const sid = await newSession(s)
      sidecar.respond('chat.interrupt', () => ({ ok: true }))
      const started = blockingTurn([{ event: 'token', data: { text: 'Half of the answer' } }])
      const streamId = await start(sid, 'Explain the outage')
      const prompt = await started
      await frames(streamId, (f) => f.event === 'token')
      expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
      await frames(streamId, (f) => f.event === 'cancel')
      expect(await nextHistory(sid)).toEqual([{ role: 'user', content: prompt }, { role: 'assistant', content: 'Half of the answer' }])
    } finally {
      turns.deps.saveMode = original
    }
  })

  it('a stopped worker that unwinds after a successor was admitted cannot overwrite the successor (TAL-364)', async () => {
    const sid = await newSession(s)
    const earlier = await earlierTurn(sid)
    let release: (result: ChatResult) => void = () => undefined
    let prompt = ''
    sidecar.respond('chat.interrupt', () => ({ ok: true, reason: 'still unwinding' }))
    sidecar.respond('chat.start', (params) => new Promise((resolve) => { prompt = str(params.user_message); release = resolve }))
    const oldStream = await start(sid, 'Slow task')
    await frames(oldStream, (f) => f.event === 'context_status')
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${oldStream}`))).cancelled).toBe(true)
    // The old worker ignores the interrupt past the unwind ceiling, so a successor is admitted meanwhile.
    s.deps.registry.activeRuns.get(oldStream)!.cancelled_at = Date.now() / 1000 - 3600
    const successorHistory = await nextHistory(sid)
    const settled = s.deps.sessionStore.get(sid).context_messages
    release({ ...completed([...earlier, { role: 'user', content: prompt }, { role: 'assistant', content: 'late cancelled output' }]), status: 'cancelled' })
    await new Promise((r) => setTimeout(r, 50))
    expect(successorHistory).toEqual(earlier)
    expect(s.deps.sessionStore.get(sid).context_messages).toEqual(settled)
    expect((await messagesOf(s, sid)).filter((m) => m._error)).toHaveLength(1)
  })

  it('[py:test_issue1298_cancel_and_activity.py::test_cancel_no_pending_user_message_does_nothing_extra] cancel without a pending prompt adds no phantom user turn', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'token', data: { text: 'p' } }])
    await cancelTurn(sid, 'only prompt')
    const users = (await messagesOf(s, sid)).filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ content: 'only prompt' })
  })

  it('[py:test_issue1298_cancel_and_activity.py::test_cancel_does_not_double_append_when_streaming_thread_already_merged] a user turn the worker already merged is not appended twice on cancel', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'merged already', timestamp: Date.now() / 1000 + 5 }]
    s.deps.sessionStore.save(session)
    cancellable([{ event: 'token', data: { text: 'p' } }])
    await cancelTurn(sid, 'merged already')
    expect((await messagesOf(s, sid)).filter((m) => m.role === 'user' && m.content === 'merged already')).toHaveLength(1)
  })

  it('[py:test_issue1298_cancel_and_activity.py::test_cancel_synthesizes_when_prior_turn_content_is_substring_of_pending] an older substring turn does not suppress the new user turn', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'ok', timestamp: 1 }, { role: 'assistant', content: 'sure', timestamp: 2 }]
    s.deps.sessionStore.save(session)
    cancellable([{ event: 'token', data: { text: 'p' } }])
    await cancelTurn(sid, 'ok then do it')
    expect((await messagesOf(s, sid)).filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('[py:test_issue1298_cancel_and_activity.py::test_cancel_synthesized_user_message_carries_attachments] the synthesized user turn carries the pending attachments', async () => {
    const sid = await newSession(s)
    cancellable([{ event: 'token', data: { text: 'p' } }])
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'with file', attachments: [{ name: 'notes.txt', type: 'text/plain', content: 'aGVsbG8=' }] })
    expect(res.status, await res.clone().text()).toBe(200)
    const streamId = String((await json(res)).stream_id)
    await frames(streamId, (f) => f.event === 'token')
    await s.get(`/api/chat/cancel?stream_id=${streamId}`)
    await frames(streamId, (f) => f.event === 'cancel')
    const user = (await messagesOf(s, sid)).find((m) => m.role === 'user')
    expect(JSON.stringify(user?.attachments)).toContain('notes.txt')
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_stream_error_materializes_pending_user_turn_before_clearing_runtime_state] a failed start materialises the pending prompt with its timestamp before the error row', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', () => { throw new SidecarError('boom', { condition: 'sidecar_error' }) })
    const streamId = await start(sid, 'will fail')
    await frames(streamId, (f) => f.event === 'apperror')
    const messages = await messagesOf(s, sid)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'will fail', _recovered: true })
    expect(typeof messages[0]?.timestamp).toBe('number')
    expect(messages[1]).toMatchObject({ role: 'assistant', _error: true })
    expect((await detail(s, sid)).active_stream_id).toBeNull()
  })

  it('[py:test_issue1361_cancel_data_loss.py::test_stale_stream_cleanup_materializes_pending_turn_before_clearing_state] loading a session with a dead stream repairs it: user turn plus an error row', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.active_stream_id = 'dead-stream'
    session.pending_user_message = 'lost prompt'
    session.pending_started_at = 1700000000
    session.pending_attachments = [{ name: 'a.txt' }]
    s.deps.sessionStore.save(session)
    const loaded = await detail(s, sid)
    expect(loaded.active_stream_id).toBeNull()
    expect(loaded.pending_user_message ?? null).toBeNull()
    const messages = loaded.messages as Json[]
    expect(messages[0]).toMatchObject({ role: 'user', content: 'lost prompt', timestamp: 1700000000 })
    expect(JSON.stringify(messages[0]?.attachments)).toContain('a.txt')
    expect(messages[1]).toMatchObject({ role: 'assistant', _error: true })
  })

  // ── provider error settlement matrix (test_issue5121) ──
  const seeded = async (): Promise<string> => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'earlier', timestamp: 1 }, { role: 'assistant', content: 'earlier answer', timestamp: 2 }]
    s.deps.sessionStore.save(session)
    return sid
  }
  const failing = (error: string, opts: { partial?: string; replay?: string; status?: ChatResult['status'] } = {}): void => {
    sidecar.respond('chat.start', (params, emit) => {
      if (opts.partial) emit({ event: 'token', data: { text: opts.partial } })
      const messages: Json[] = [{ role: 'user', content: str(params.user_message) }]
      if (opts.replay) messages.push({ role: 'assistant', content: opts.replay })
      return completed(messages, { status: opts.status ?? 'error', error, final_response: '', token_sent: Boolean(opts.partial) })
    })
  }
  const settle = async (sid: string, message = 'go'): Promise<{ frames: SseFrame[]; apperror: Json | undefined; messages: Json[] }> => {
    const streamId = await start(sid, message)
    const out = await frames(streamId, terminal)
    return { frames: out, apperror: out.find((f) => f.event === 'apperror')?.data as Json | undefined, messages: await messagesOf(s, sid) }
  }

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_auth_401_after_partial_preserves_partial_then_error] a 401 after streamed text keeps the partial before the error row', async () => {
    const sid = await newSession(s)
    failing('401 authentication_error: invalid api key', { partial: 'Partial auth text' })
    const { frames: out, apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('auth_mismatch')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    const partialIdx = messages.findIndex((m) => m._partial && m.content === 'Partial auth text')
    const errorIdx = messages.findIndex((m) => m._error)
    expect(partialIdx).toBeGreaterThanOrEqual(0)
    expect(partialIdx).toBeLessThan(errorIdx)
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_auth_401_seeded_multi_turn_partial_persists_error_turn] with a prior turn the earlier answer, the partial, the user row, and the error all persist', async () => {
    const sid = await seeded()
    failing('401 authentication_error', { partial: 'partial two' })
    const { frames: out, apperror, messages } = await settle(sid, 'second question')
    expect(apperror?.type).toBe('auth_mismatch')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.some((m) => m.content === 'earlier answer')).toBe(true)
    expect(messages.some((m) => m._partial && m.content === 'partial two')).toBe(true)
    expect(messages.some((m) => m.role === 'user' && m.content === 'second question')).toBe(true)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_auth_401_seeded_replayed_assistant_does_not_satisfy_current_turn] a replayed prior answer next to a 401 does not count as this turn', async () => {
    const sid = await seeded()
    failing('401 authentication_error', { replay: 'earlier answer' })
    const { frames: out, apperror, messages } = await settle(sid, 'new question')
    expect(apperror?.type).toBe('auth_mismatch')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.some((m) => m.role === 'user' && m.content === 'new question')).toBe(true)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_captured_terminal_http_400_beats_structured_final_answer] a captured non-retryable HTTP 400 wins over a structured final answer', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'status', data: { kind: 'terminal_error', message: 'Non-retryable error (HTTP 400): invalid model format or no credentials' } })
      emit({ event: 'token', data: { text: 'partial' } })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'structured answer' }], { status: 'error', error: null, final_response: 'structured answer' })
    })
    const { frames: out, apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('model_not_found')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_success_repeated_assistant_text_stays_successful_current_turn] an answer identical to the previous one is still a success', async () => {
    const sid = await seeded()
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'earlier answer' }]))
    const { frames: out, apperror, messages } = await settle(sid, 'again?')
    expect(apperror).toBeUndefined()
    expect(out.some((f) => f.event === 'done')).toBe(true)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'earlier answer' })
    expect(messages.some((m) => m._error)).toBe(false)
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_success_repeated_assistant_text_ignores_empty_error_field] the same success with error null', async () => {
    const sid = await seeded()
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'earlier answer' }], { error: null }))
    const { frames: out, apperror, messages } = await settle(sid, 'again')
    expect(apperror).toBeUndefined()
    expect(out.some((f) => f.event === 'done')).toBe(true)
    expect(messages.some((m) => m._error)).toBe(false)
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_live_settlement_empty_hint_does_not_append_empty_emphasis] a hard failure persists exactly the error text with no empty emphasis', async () => {
    const sid = await newSession(s)
    failing('synthetic hard failure')
    const { apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('error')
    expect(apperror?.hint === undefined || apperror.hint === null || apperror.hint === '').toBe(true)
    expect(messages.at(-1)?.content).toBe('**Error:** synthetic hard failure')
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_completed_assistant_answer_with_stale_partial_flag_settles_done] a completed answer flagged partial still settles as done', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'complete answer' }], { result_status: 'partial' }))
    const { frames: out, apperror, messages } = await settle(sid)
    expect(apperror).toBeUndefined()
    expect(out.some((f) => f.event === 'done')).toBe(true)
    expect(messages.at(-1)).toMatchObject({ content: 'complete answer' })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_stale_partial_with_unfinished_tool_call_still_reports_no_response] an unfinished tool call with no answer is no_response', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] }], { result_status: 'partial', final_response: '', token_sent: false }))
    const { frames: out, apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('no_response')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_stale_partial_repeated_prompt_replay_still_reports_no_response] a partial that only replays the prompt is no_response', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params, emit) => { emit({ event: 'token', data: { text: 'echo' } }); return completed([{ role: 'user', content: str(params.user_message) }], { result_status: 'partial', final_response: '', token_sent: false }) })
    const { frames: out, apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('no_response')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_hard_failure_with_completed_answer_still_reports_no_response] a failed status with an empty error and a complete answer is no_response', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'looks complete' }], { status: 'error', error: '', token_sent: false }))
    const { frames: out, apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('no_response')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_non_auth_partial_delivery_persists_error_turn] a silent failure after streamed text keeps the partial and appends the error row', async () => {
    const sid = await newSession(s)
    failing('', { partial: 'Partial text before failure' })
    const { apperror, messages } = await settle(sid)
    expect(apperror?.type).toBe('no_response')
    expect(messages.some((m) => m._partial && m.content === 'Partial text before failure')).toBe(true)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_non_auth_seeded_multi_turn_partial_persists_error_turn] with a seeded prior turn the earlier answer and the partial both survive', async () => {
    const sid = await seeded()
    failing('', { partial: 'partial later' })
    const { frames: out, apperror, messages } = await settle(sid, 'next')
    expect(apperror?.type).toBe('no_response')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.some((m) => m.content === 'earlier answer')).toBe(true)
    expect(messages.some((m) => m._partial && m.content === 'partial later')).toBe(true)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })

  it('[py:test_issue5121_provider_auth_terminal_error.py::test_non_auth_seeded_replayed_assistant_does_not_satisfy_current_turn] a replayed prior answer with an empty error is no_response', async () => {
    const sid = await seeded()
    failing('', { replay: 'earlier answer' })
    const { frames: out, apperror, messages } = await settle(sid, 'fresh')
    expect(apperror?.type).toBe('no_response')
    expect(out.some((f) => f.event === 'done')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ _error: true })
  })
})
