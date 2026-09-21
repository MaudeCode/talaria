/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue1217_transcript_compaction.py
 *   web/tests/test_issue1913_workspace_prefix_sentinel.py
 *   web/tests/test_issue2028_compression_anchor_helpers.py
 *   web/tests/test_issue2592_partial_dedupe.py
 *   web/tests/test_issue2914_truncation_watermark.py
 *   web/tests/test_issue3293_title_language_drift.py
 *   web/tests/test_issue3405_profile_provider_resolution.py
 *   web/tests/test_issue3455_think_block_extraction.py
 *   web/tests/test_issue3468_duplicate_after_compression.py
 *   web/tests/test_issue3548_sessiondb_self_heal.py
 *   web/tests/test_issue3583_orphaned_tool_calls.py
 *   web/tests/test_issue3599_inline_thinking_extraction.py
 *   web/tests/test_issue3800_compaction_summary_length.py
 *   web/tests/test_issue3802_delete_session_journals.py
 *   web/tests/test_issue3831_watermark_clear.py
 *   web/tests/test_issue3875_recovery_anchor_dedup.py
 *   web/tests/test_issue3929_error_preserves_partial.py
 *   web/tests/test_issue3929_partial_work_recovery.py
 *   web/tests/test_issue4283_recovered_context_replay.py
 *   web/tests/test_issue4685_post_compression_context_metering.py
 *   web/tests/test_issue4928_tool_arg_content_cap.py
 *   web/tests/test_issue5121_provider_auth_terminal_error.py
 *   web/tests/test_issue5139_gateway_approval_offline_notice.py
 *   web/tests/test_issue5141_terminal_failure_transcript_evaluator.py
 *   web/tests/test_issue5270_cli_webui_continuity.py
 *   web/tests/test_issue5339_restart_stale_user_dedup.py
 *   web/tests/test_issue5871_redaction_awareness_prompt.py
 *   web/tests/test_issue607.py
 *   web/tests/test_issue6611_regeneration_authority.py
 *   web/tests/test_issue6722_provider_qualified_model_leak.py
 *   web/tests/test_issue6751_api_content_agent_replay.py
 *   web/tests/test_issue6935_persist_user_timestamp_kwarg.py
 *   web/tests/test_issue7396_key_cmd_cache.py
 *   web/tests/test_issue7543_title_first_exchange.py
 *   web/tests/test_issue_progress_echo_dedupe.py
 *   web/tests/test_issue_raw_pending_approval_id.py
 *   web/tests/test_issues_853_857.py
 * (issues #607, #1217, #1913, #2028, #2592, #2914, #3293, #3405, #3455, #3468, #3548, #3583, #3599, #3800, #3802, #3831, #3875, #3929, #4283, #4685, #4928, #5121, #5139, #5141, #5270, #5339, #5871, #6611, #6722, #6751, #6935, #7396, #7543) is covered here; see docs/architecture/regression-port-ledger.md.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'

type ChatResult = SidecarResult<'chat.start'>

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

async function newSession(s: TestServer): Promise<string> {
  const res = await post(s, '/api/session/new', {})
  expect(res.status).toBe(200)
  return String(((await json(res)).session as Json).session_id)
}

const completed = (messages: Json[], extra: Partial<ChatResult> = {}): ChatResult => ({
  status: 'completed', messages, final_response: str(messages[messages.length - 1]?.content), error: null, result_status: 'completed', tool_limit_reached: false,
  usage: { prompt_tokens: 120, completion_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0.001 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [], ...extra,
})

const eventNames = (frames: SseFrame[]): string[] => frames.map((f) => f.event)

describe('chat turns through the sidecar', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('streams a turn, settles the transcript, journals every frame, and replays it after the run', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params, emit) => {
      expect(params.session_id).toBe(sid)
      expect(str(params.user_message)).toMatch(/^\[Workspace::v1: .*\]\nhello there$/)
      expect(params.conversation_history).toEqual([])
      emit({ event: 'reasoning', data: { text: 'thinking' } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', preview: null, args: { path: 'a' }, tid: 'call_1' } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', preview: 'contents', args: { path: 'a' }, tid: 'call_1', is_error: false } })
      emit({ event: 'token', data: { text: 'Hi ' } })
      emit({ event: 'token', data: { text: 'back' } })
      const history = [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'contents' }, { role: 'assistant', content: 'Hi back' }]
      return completed(history)
    })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Greeting exchange"', usage: null }))
    let res = await post(s, '/api/chat/start', { session_id: sid, message: 'hello there' })
    expect(res.status).toBe(200)
    const start = await json(res)
    const streamId = String(start.stream_id)
    expect(streamId).toMatch(/^[0-9a-f]{32}$/)
    expect(start.session_id).toBe(sid)
    expect(typeof start.pending_started_at).toBe('number')
    expect(start.title).toBe('hello there')

    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    const names = eventNames(frames)
    expect(names.slice(0, 5)).toEqual(['reasoning', 'tool', 'tool_complete', 'token', 'token'])
    expect(names).toContain('done')
    expect(names).toContain('title')
    expect(names[names.length - 1]).toBe('stream_end')
    expect(frames.every((f) => f.id?.startsWith(`${streamId}:`))).toBe(true)
    expect(frames.map((f) => Number(f.id?.split(':')[1]))).toEqual(frames.map((_, i) => i + 1))
    const done = frames.find((f) => f.event === 'done')?.data as Json
    const doneSession = done.session as Json
    expect((doneSession.messages as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'hello there'], ['assistant', ''], ['tool', 'contents'], ['assistant', 'Hi back']])
    expect((done.usage as Json).input_tokens).toBe(120)
    expect((frames.find((f) => f.event === 'title')?.data as Json).title).toBe('Greeting exchange')

    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect(detail.title).toBe('Greeting exchange')
    expect(detail.active_stream_id).toBeNull()
    expect(detail.pending_user_message).toBeNull()
    expect((detail.messages as Json[])[0]?.content).toBe('hello there')
    // Reasoning streamed before the first tool call belongs to that first assistant row (Python per-segment attribution).
    expect((detail.messages as Json[])[1]).toMatchObject({ role: 'assistant', reasoning: 'thinking' })
    expect((detail.messages as Json[])[3]).toMatchObject({ content: 'Hi back', _usedModel: 'test-model' })
    expect(detail.tool_calls).toEqual([{ name: 'read_file', snippet: 'contents', tid: 'call_1', assistant_msg_idx: 1, args: { path: 'a' } }])
    expect(detail.input_tokens).toBe(120)
    expect(detail.output_tokens).toBe(30)
    expect(detail.context_length).toBe(200000)
    const journalPath = join(realpathSync(s.state), 'sessions', '_run_journal', sid, `${streamId}.jsonl`)
    expect(existsSync(journalPath)).toBe(true)
    const rows = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json)
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1))
    expect(rows[rows.length - 1]).toMatchObject({ event: 'stream_end', terminal: true, terminal_state: 'completed', version: 1, run_id: streamId, session_id: sid })

    res = await s.get(`/api/chat/stream/status?stream_id=${streamId}`)
    expect(await json(res)).toEqual({ active: false, stream_id: streamId, replay_available: true, journal: { session_id: sid, run_id: streamId, last_seq: rows.length, last_event_id: `${streamId}:${String(rows.length)}`, last_event: 'stream_end', terminal: true, terminal_state: 'completed' } })
    // A late reconnect replays the journal from the cursor and closes at the terminal fence.
    const replay = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:5`, (f) => f.event === 'stream_end')
    expect(replay.map((f) => Number(f.id?.split(':')[1]))[0]).toBe(6)
    expect(eventNames(replay)[eventNames(replay).length - 1]).toBe('stream_end')
    expect((await s.get('/api/chat/stream?stream_id=unknownstream')).status).toBe(404)
    const list = await json(await s.get('/api/sessions'))
    expect((list.sessions as Json[]).find((r) => r.session_id === sid)).toMatchObject({ title: 'Greeting exchange', message_count: 4 })
  })

  it('relays approval and clarify prompts and resolves them through the sidecar [py:test_issue4771_local_approval_regression.py::test_local_mirrored_approval_resolves_not_409] [py:test_issue4948_local_stale_approval.py::test_stale_card_click_clears_not_dead_ends] [py:test_issue4948_local_stale_approval.py::test_fresh_local_approval_still_resolves] [py:test_issue5345_clarify_toast_and_interrupt_provenance.py::test_clarify_pending_never_404s]', async () => {
    const sid = await newSession(s)
    let releaseApproval: (choice: string) => void = () => undefined
    let releaseClarify: (answer: string) => void = () => undefined
    sidecar.respond('approval.respond', (params) => { releaseApproval(params.choice); return { ok: true, resolved: 1, choice: params.choice } })
    sidecar.respond('clarify.respond', (params) => { releaseClarify(params.response); return { ok: true, clarify_id: String(params.clarify_id) } })
    sidecar.respond('chat.start', async (params, emit) => {
      emit({ event: 'approval', data: { request_id: 'req-1', command: 'rm -rf build', pattern_key: 'rm', session_id: sid } })
      const choice = await new Promise<string>((resolve) => { releaseApproval = resolve })
      emit({ event: 'clarify', data: { question: 'Which env?', choices_offered: ['dev', 'prod'], session_id: sid } })
      const answer = await new Promise<string>((resolve) => { releaseClarify = resolve })
      emit({ event: 'clarify_resolved', data: { clarify_id: 'ignored' } })
      emit({ event: 'token', data: { text: `ran with ${choice} on ${answer}` } })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: `ran with ${choice} on ${answer}` }])
    })
    sidecar.respond('aux.complete', () => { throw new SidecarError('no aux model', { condition: 'aux_unconfigured' }) })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'clean up' }))
    const streamId = String(start.stream_id)
    const untilApproval = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'approval')
    const approval = untilApproval[untilApproval.length - 1]?.data as Json
    expect(approval).toMatchObject({ approval_id: 'req-1', command: 'rm -rf build', pending_count: 1 })
    let pending = await json(await s.get(`/api/approval/pending?session_id=${sid}`))
    expect((pending.pending as Json).approval_id).toBe('req-1')
    expect(pending.pending_count).toBe(1)
    const sidebar = await json(await s.get('/api/sessions'))
    expect((sidebar.sessions as Json[]).find((r) => r.session_id === sid)?.attention).toEqual({ kind: 'approval', count: 1, severity: 'critical' })
    let res = await post(s, '/api/approval/respond', { session_id: sid, choice: 'bogus' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'req-1' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, choice: 'once' })
    pending = await json(await s.get(`/api/approval/pending?session_id=${sid}`))
    expect(pending).toEqual({ pending: null, pending_count: 0 })

    const untilClarify = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'clarify')
    const clarify = untilClarify[untilClarify.length - 1]?.data as Json
    expect(clarify).toMatchObject({ question: 'Which env?', choices_offered: ['dev', 'prod'], timeout_seconds: 120 })
    expect(String(clarify.clarify_id)).toMatch(/^[0-9a-f]{32}$/)
    const clarifyPending = await json(await s.get(`/api/clarify/pending?session_id=${sid}`))
    expect((clarifyPending.pending as Json).clarify_id).toBe(clarify.clarify_id)
    res = await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'stale', response: 'prod' })
    expect(res.status).toBe(409)
    res = await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: clarify.clarify_id, response: 'prod' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, response: 'prod' })
    const rest = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:${String(untilClarify.length)}`, (f) => f.event === 'stream_end')
    expect(eventNames(rest)).toContain('done')
    expect((rest.find((f) => f.event === 'title_status')?.data as Json)).toMatchObject({ status: 'fallback', reason: 'local_summary' })
    expect((rest.find((f) => f.event === 'title')?.data as Json).title).toBe('clean')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect((detail.messages as Json[]).map((m) => m.content)).toEqual(['clean up', 'ran with once on prod'])
    expect(await json(await s.get(`/api/clarify/pending?session_id=${sid}`))).toEqual({ pending: null, pending_count: 0 })
    // Stale approval clicks after everything settled are benign.
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'deny', approval_id: 'old' }))).toEqual({ ok: true, choice: 'deny', stale_cleared: true })
  })

  it('cancels a running turn, persists the partial, and refuses a second concurrent start [py:test_issue1298_cancel_and_activity.py::test_cancel_synthesizes_user_message_when_messages_empty] [py:test_issue893_cancel_preserves_partial.py::test_cancel_stream_saves_partial_text_to_session]', async () => {
    const sid = await newSession(s)
    let interrupted = false
    sidecar.respond('chat.interrupt', () => { interrupted = true; return { ok: true } })
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'partial answer' } })
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'long task' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    let res = await post(s, '/api/chat/start', { session_id: sid, message: 'again' })
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ error: 'session already has an active stream', active_stream_id: streamId })
    expect(await json(await s.get(`/api/chat/stream/status?stream_id=${streamId}`))).toMatchObject({ active: true, replay_available: true })
    res = await s.get(`/api/chat/cancel?stream_id=${streamId}`)
    expect(await json(res)).toEqual({ ok: true, cancelled: true, stream_id: streamId })
    expect(interrupted).toBe(true)
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'cancel')
    expect(eventNames(frames)).toContain('cancel')
    expect(frames.find((f) => f.event === 'cancel')?.data).toMatchObject({ type: 'cancelled', message: 'Cancelled by user' })
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const messages = detail.messages as Json[]
    expect(messages[0]).toMatchObject({ role: 'user', content: 'long task', _recovered: true })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'partial answer', _partial: true })
    expect(String(messages[2]?.content)).toMatch(/^\*\*Task cancelled:\*\* Task cancelled\./)
    expect(detail.active_stream_id).toBeNull()
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'after cancel' })).status).toBe(200)
    expect(await json(await s.get('/api/chat/cancel?stream_id=nope'))).toEqual({ ok: true, cancelled: false, stream_id: 'nope' })
  })

  it('turns sidecar failures into apperror frames and a persisted error bubble [py:test_issue5121_provider_auth_terminal_error.py::test_auth_401_without_delivery_persists_error_turn] [py:test_issue5121_provider_auth_terminal_error.py::test_non_auth_silent_failure_still_uses_no_response]', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', () => { throw new SidecarError('No credentials found for provider openai', { condition: 'credential_missing' }) })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'broken' }))
    const streamId = String(start.stream_id)
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'apperror')
    const error = frames.find((f) => f.event === 'apperror')?.data as Json
    expect(error).toMatchObject({ type: 'auth_mismatch', session_id: sid })
    expect(String(error.message)).toContain('No credentials')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const messages = detail.messages as Json[]
    expect(messages[0]).toMatchObject({ role: 'user', content: 'broken', _recovered: true })
    expect(messages[1]).toMatchObject({ role: 'assistant', _error: true })
    expect(String(messages[1]?.content)).toContain('**Authentication failed:**')
    expect(detail.active_stream_id).toBeNull()
    // A silent success (no assistant reply, no tokens) is classified as no_response.
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }], { token_sent: false, final_response: '' }))
    const start2 = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'silent' }))
    const frames2 = await s.sse(`/api/chat/stream?stream_id=${String(start2.stream_id)}&replay=1`, (f) => f.event === 'apperror')
    expect((frames2.find((f) => f.event === 'apperror')?.data as Json).type).toBe('no_response')
  })

  it('steers the live agent and reports fallbacks when nothing is running', async () => {
    const sid = await newSession(s)
    expect(await json(await post(s, '/api/chat/steer', { session_id: sid, text: 'focus' }))).toEqual({ accepted: false, fallback: 'not_running', stream_id: null })
    let steered: string | null = null
    sidecar.respond('chat.steer', (params) => { steered = params.text; return { accepted: true, fallback: null } })
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      release = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'working done' }])) }
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'task' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'token')
    const res = await post(s, '/api/chat/steer', { session_id: sid, text: 'prefer tests', display_text: 'Prefer tests', steer_id: 'steer-1' })
    expect(await json(res)).toEqual({ accepted: true, fallback: null, stream_id: start.stream_id, steer_id: 'steer-1' })
    expect(steered).toBe('prefer tests')
    expect((await post(s, '/api/chat/steer', { session_id: sid, text: 'x', steer_id: 'bad id!' })).status).toBe(400)
    release()
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    expect((frames.find((f) => f.event === 'steer_consumed')?.data as Json)).toMatchObject({ steer_id: 'steer-1', text: 'Prefer tests' })
  })

  it('runs background tasks and side questions in hidden sessions', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: `answer to ${str(params.user_message).split('\n').pop() ?? ''}` }]))
    let res = await post(s, '/api/background', { session_id: sid, prompt: 'summarize repo' })
    expect(res.status).toBe(200)
    const bg = await json(res)
    expect(bg.session_id).not.toBe(sid)
    await s.sse(`/api/chat/stream?stream_id=${String(bg.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    const status = await json(await s.get(`/api/background/status?session_id=${sid}`))
    expect(status.results).toEqual([{ task_id: bg.task_id, prompt: 'summarize repo', answer: 'answer to summarize repo', completed_at: expect.any(Number) as number }])
    expect(await json(await s.get(`/api/background/status?session_id=${sid}`))).toEqual({ results: [] })

    res = await post(s, '/api/btw', { session_id: sid, question: 'what time is it' })
    expect(res.status).toBe(200)
    const btw = await json(res)
    expect(btw.parent_session_id).toBe(sid)
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(btw.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    expect(frames.find((f) => f.event === 'done')?.data).toMatchObject({ ephemeral: true, answer: 'answer to what time is it' })
    expect((await s.get(`/api/session?session_id=${String(btw.session_id)}`)).status).toBe(404)
    expect(await json(await post(s, '/api/bg-task-complete-ack', { session_id: sid, task_id: 't1' }))).toEqual({ ok: true, session_id: sid, task_id: 't1', noop: true })
  })

  it('serves the session-list, per-session, and prompt streams with initial frames', async () => {
    const sid = await newSession(s)
    const events = s.sse('/api/sessions/events', (f) => f.event === 'sessions_changed' && (f.data as Json).reason === 'session_rename')
    await new Promise((r) => setTimeout(r, 50))
    await post(s, '/api/session/rename', { session_id: sid, title: 'Renamed' })
    const frames = await events
    expect(frames.some((f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'sessions')).toBe(true)
    const gateway = await s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'gateway_status')
    expect(gateway[0]?.data).toMatchObject({ ok: true, watcher_running: true, scope: 'gateway_sessions', session_stream_path: '/api/session/stream' })
    const session = await s.sse(`/api/session/stream?session_id=${sid}&known_count=0`, (f) => f.event === 'initial')
    expect(session[0]).toMatchObject({ event: 'initial', data: { session_id: sid } })
    const approvals = await s.sse(`/api/approval/stream?session_id=${sid}`, (f) => f.event === 'initial')
    expect(approvals[0]?.data).toEqual({ pending: null, pending_count: 0 })
    const clarifies = await s.sse(`/api/clarify/stream?session_id=${sid}`, (f) => f.event === 'initial')
    expect(clarifies[0]?.data).toEqual({ pending: null, pending_count: 0 })
    const perSession = await s.sse(`/api/sessions/${sid}/events`, () => false, { timeoutMs: 300 })
    expect(perSession).toEqual([])
    expect((await s.get('/api/session/stream')).status).toBe(400)
  })

  it('answers the goal route through the sidecar goals namespace', async () => {
    const sid = await newSession(s)
    sidecar.respond('goals.snapshot', () => ({ goal: null, snapshot: null }))
    sidecar.respond('goals.command', (params) => ({ ok: true, action: 'status', message: `goal for ${params.session_id}: ${params.args}`, goal: null }))
    const res = await post(s, '/api/goal', { session_id: sid, args: 'status' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, message: `goal for ${sid}: status` })
    expect((await post(s, '/api/goal', { session_id: sid, args: '[SILENT]' })).status).toBe(200)
  })
})

describe('chat without a sidecar', () => {
  it('fails closed with a sidecar_unavailable apperror and 503 goal controls', async () => {
    const s = await bootTestServer()
    try {
      const sid = await newSession(s)
      const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hi' }))
      const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'apperror')
      expect(frames.find((f) => f.event === 'apperror')?.data).toMatchObject({ type: 'sidecar_unavailable', condition: 'sidecar_unavailable' })
      expect((await post(s, '/api/goal', { session_id: sid, args: 'status' })).status).toBe(503)
      expect((await post(s, '/api/chat/start', { session_id: 'deadbeef0000', message: 'hi' })).status).toBe(404)
      expect((await post(s, '/api/chat/start', { session_id: sid, message: '' })).status).toBe(400)
      expect(await json(await post(s, '/api/chat/start', { session_id: sid, message: '[SILENT]' }))).toEqual({ status: 'suppressed', reason: 'silent_control_message' })
    } finally {
      await s.close()
    }
  })
})
