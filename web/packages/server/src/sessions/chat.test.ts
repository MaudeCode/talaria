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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { CANCEL_UNWIND_CEILING_S } from './streams.js'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { sanitizeMessagesForApi } from './merge.js'

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
    // Python closed the reasoning segment with a stable `{text:'', titles:[...]}` snapshot before the first visible token.
    // Python emits the prefill `context_status` frame before the agent runs; the recall hook is dropped, so it is always not_configured.
    expect(names.slice(0, 7)).toEqual(['context_status', 'reasoning', 'tool', 'tool_complete', 'reasoning', 'token', 'token'])
    expect(frames[0]?.data).toEqual({ session_id: sid, prefill: { status: 'not_configured', source: 'none', label: '', message_count: 0 } })
    expect(frames[4]?.data).toEqual({ text: '', titles: ['thinking'] })
    expect(names).toContain('done')
    expect(names).toContain('title')
    expect(names[names.length - 1]).toBe('stream_end')
    expect(frames.every((f) => f.id?.startsWith(`${streamId}:`))).toBe(true)
    expect(frames.map((f) => Number(f.id?.split(':')[1]))).toEqual(frames.map((_, i) => i + 1))
    const done = frames.find((f) => f.event === 'done')?.data as Json
    const doneSession = done.session as Json
    expect((doneSession.messages as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'hello there'], ['assistant', ''], ['tool', 'contents'], ['assistant', 'Hi back']])
    expect((done.usage as Json).input_tokens).toBe(120)
    // Python usage payload: per-turn timing/cache-hit fields the iOS TPS label and the web meter read.
    const usage = done.usage as Json
    expect(usage).toMatchObject({ output_tokens: 30, used_model: 'test-model', cache_hit_percent: null, turn_cache_hit_percent: null })
    expect(typeof usage.duration_seconds).toBe('number')
    expect(typeof usage.tps).toBe('number')
    expect(typeof usage.ttft_ms).toBe('number')
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
    // A frame without `timeout_seconds` (older sidecar) falls back to the Python default of 3600 s; a real sidecar stamps the resolved Agent timeout.
    expect(clarify).toMatchObject({ question: 'Which env?', choices_offered: ['dev', 'prod'], timeout_seconds: 3600 })
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
    expect((rest.find((f) => f.event === 'title_status')?.data as Json)).toMatchObject({ status: 'fallback', reason: 'local_summary:llm_error_aux' })
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

  it('a follow-up message is admitted as soon as the turn is done, while title generation is still running', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'first answer' }]))
    let releaseTitle: (() => void) | null = null
    sidecar.respond('aux.complete', () => new Promise((resolve) => { releaseTitle = () => { resolve({ model: 'aux', text: 'Title: "Slow title"', usage: null }) } }))
    try {
      const first = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'first' }))
      await s.sse(`/api/chat/stream?stream_id=${String(first.stream_id)}`, (f) => f.event === 'done')
      // The title prompt has not answered; the next turn must not be refused with 409 meanwhile.
      const deadline = Date.now() + 5000
      let res = await post(s, '/api/chat/start', { session_id: sid, message: 'second' })
      while (res.status === 409 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 25)); res = await post(s, '/api/chat/start', { session_id: sid, message: 'second' }) }
      expect(res.status).toBe(200)
      await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}`, (f) => f.event === 'done')
    } finally {
      (releaseTitle as (() => void) | null)?.()
      sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Greeting exchange"', usage: null }))
    }
  })

  it('a cancel that lands after done (title work still running) is reported as not cancelled and journals no cancel frame', async () => {
    const sid = await newSession(s)
    let releaseTitle: () => void = () => undefined
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'finished' }]))
    sidecar.respond('aux.complete', () => new Promise((resolve) => { releaseTitle = () => { resolve({ model: 'aux', text: 'Late title', usage: null }) } }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'quick' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'done')
    // Python `cancel_stream` returned False once the worker had popped the run, before the daemon title thread.
    const cancel = await json(await s.get(`/api/chat/cancel?stream_id=${String(start.stream_id)}`))
    expect(cancel).toMatchObject({ ok: true, cancelled: false })
    releaseTitle()
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    expect(frames.some((f) => f.event === 'cancel')).toBe(false)
    expect(frames.some((f) => f.event === 'title')).toBe(true)
    const status = await json(await s.get(`/api/chat/stream/status?stream_id=${String(start.stream_id)}`))
    expect(status.terminal_state).not.toBe('interrupted-by-user')
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Greeting exchange"', usage: null }))
  })

  it('a compression-exhausted turn stamps recovery state so a bare "continue" is refused with 409 (Python compression_recovery)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', () => { throw new SidecarError('compression_exhausted: context length exceeded and cannot compress further', { condition: 'sidecar_error' }) })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'huge task' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'apperror')
    const err = frames.find((f) => f.event === 'apperror')?.data as Json
    expect(err.type).toBe('compression_exhausted')
    expect(err.compression_recovery).toMatchObject({ terminal_state: 'compression_exhausted', recommended_action: 'start_focused_continuation', source_session_id: sid, action_label: 'Start focused continuation' })
    expect(err.recommended_recovery_action).toBe('start_focused_continuation')
    const persisted = s.deps.sessionStore.get(sid)
    expect(persisted.compression_recovery).toMatchObject({ terminal_state: 'compression_exhausted' })
    expect(persisted.messages.at(-1)?._compressionRecovery).toMatchObject({ terminal_state: 'compression_exhausted' })
    for (const prompt of ['continue', 'Carry on!', '继续', 'continue please']) {
      const res = await post(s, '/api/chat/start', { session_id: sid, message: prompt })
      expect(res.status, prompt).toBe(409)
      expect((await json(res)).type).toBe('compression_recovery_required')
    }
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'narrow answer' }]))
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'continue by summarizing file X' })).status).toBe(200)
  })

  it('a run that has been cancelling past the unwind ceiling with no live channel no longer blocks the session', () => {
    const registry = s.deps.registry
    registry.registerActiveRun({ stream_id: 'stuck-run', session_id: 'stuck-session', phase: 'cancelling', cancelled_at: 1_000, started_at: 900 } as never)
    try {
      expect(registry.activeRunStreamForSession('stuck-session', 1_000 + 60)).toBe('stuck-run')
      expect(registry.activeRunStreamForSession('stuck-session', 1_000 + CANCEL_UNWIND_CEILING_S)).toBeNull()
    } finally {
      registry.activeRuns.delete('stuck-run')
    }
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
    let emitLive: ((frame: { event: 'steer_pending' | 'token'; data: { text: string } }) => void) | null = null
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      emitLive = emit
      release = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'working done' }], { pending_steer: 'second' })) }
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'task' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'token')
    const res = await post(s, '/api/chat/steer', { session_id: sid, text: 'prefer tests', display_text: 'Prefer tests', steer_id: 'steer-1' })
    expect(await json(res)).toEqual({ accepted: true, fallback: null, stream_id: start.stream_id, steer_id: 'steer-1' })
    expect(steered).toBe('prefer tests')
    expect((await post(s, '/api/chat/steer', { session_id: sid, text: 'x', steer_id: 'bad id!' })).status).toBe(400)
    await post(s, '/api/chat/steer', { session_id: sid, text: 'second', steer_id: 'steer-2' })
    // Python emitted `steer_consumed` live, before the next content frame, once the Agent had applied the first steer
    // (its pending text shrank to the tail); the second steer stays pending and is reported as a leftover at `done`.
    emitLive!({ event: 'steer_pending', data: { text: 'second' } })
    emitLive!({ event: 'token', data: { text: ' more' } })
    const live = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'steer_consumed')
    const consumedIdx = live.findIndex((f) => f.event === 'steer_consumed')
    expect(consumedIdx).toBeGreaterThan(-1)
    expect(live[consumedIdx]?.data).toMatchObject({ steer_id: 'steer-1', text: 'Prefer tests', agent_text: 'prefer tests' })
    expect(live.slice(consumedIdx + 1).some((f) => f.event === 'token' && String((f.data as Json).text) === ' more')).toBe(true)
    release()
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    expect((frames.find((f) => f.event === 'pending_steer_leftover')?.data as Json)).toMatchObject({ steer_id: 'steer-2', text: 'second' })
    expect(frames.filter((f) => f.event === 'steer_consumed')).toHaveLength(1)
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
    expect(String(bg.task_id)).toMatch(/^[0-9a-f]{8}$/)
    expect(await json(await s.get(`/api/background/status?session_id=${sid}`))).toEqual({ results: [] })
    // The hidden bg session file is removed once the task completes; a failed run still completes the task.
    expect(existsSync(s.deps.sessionStore.pathFor(String(bg.session_id)))).toBe(false)
    sidecar.respond('chat.start', () => { throw new SidecarError('provider exploded', { condition: 'sidecar_error' }) })
    const failed = await json(await post(s, '/api/background', { session_id: sid, prompt: 'doomed' }))
    await s.sse(`/api/chat/stream?stream_id=${String(failed.stream_id)}&replay=1`, (f) => f.event === 'stream_end' || f.event === 'apperror')
    await new Promise((r) => setTimeout(r, 50))
    expect((await json(await s.get(`/api/background/status?session_id=${sid}`))).results).toEqual([{ task_id: failed.task_id, prompt: 'doomed', answer: '(background task failed)', completed_at: expect.any(Number) as number }])
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: `answer to ${str(params.user_message).split('\n').pop() ?? ''}` }]))

    res = await post(s, '/api/btw', { session_id: sid, question: 'what time is it' })
    expect(res.status).toBe(200)
    const btw = await json(res)
    expect(btw.parent_session_id).toBe(sid)
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(btw.stream_id)}&replay=1`, (f) => f.event === 'done')
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
    // Python starts the pending-prompt streams with `Connection: close`; the long-lived session/chat streams do not (#3103).
    for (const path of [`/api/approval/stream?session_id=${sid}`, `/api/clarify/stream?session_id=${sid}`]) {
      const ac = new AbortController()
      const res = await s.get(path, { signal: ac.signal })
      expect(res.headers.get('connection')).toBe('close')
      ac.abort()
    }
    const perSession = await s.sse(`/api/sessions/${sid}/events`, () => false, { timeoutMs: 300 })
    expect(perSession).toEqual([])
    expect((await s.get('/api/session/stream')).status).toBe(400)
  })

  it('answers the goal route through the sidecar goals namespace', async () => {
    const sid = await newSession(s)
    sidecar.respond('goals.snapshot', () => ({ goal: null, snapshot: null }))
    sidecar.respond('goals.command', (params) => ({ ok: true, action: 'status', message: `goal for ${params.session_id}: ${params.args} budget=${String(params.default_max_turns)}`, goal: null }))
    const res = await post(s, '/api/goal', { session_id: sid, args: 'status' })
    expect(res.status).toBe(200)
    // Python `_default_max_turns`: 20 unless `goals.max_turns` is configured.
    expect(await json(res)).toMatchObject({ ok: true, message: `goal for ${sid}: status budget=20` })
    expect((await post(s, '/api/goal', { session_id: sid, args: '[SILENT]' })).status).toBe(200)
  })

  it('carries the queue head on clarify/approval frames, re-emits the new head on resolution, and toasts persisted memory/skills', async () => {
    const sid = await newSession(s)
    let releaseAll: () => void = () => undefined
    sidecar.respond('clarify.respond', (params) => ({ ok: true, clarify_id: String(params.clarify_id) }))
    sidecar.respond('chat.start', async (params, emit) => {
      emit({ event: 'clarify', data: { clarify_id: 'c1', question: 'First?', session_id: sid } })
      emit({ event: 'clarify', data: { clarify_id: 'c2', question: 'Second?', session_id: sid } })
      await new Promise<void>((resolve) => { releaseAll = resolve })
      // The agent wrote memory during the turn: the post-run scan toasts it.
      mkdirSync(join(s.state, 'memories'), { recursive: true })
      writeFileSync(join(s.state, 'memories', 'MEMORY.md'), '- remembered\n')
      mkdirSync(join(s.state, 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(s.state, 'skills', 'deploy', 'SKILL.md'), '# deploy\n')
      emit({ event: 'token', data: { text: 'ok' } })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'ok' }])
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'ask me things' }))
    const streamId = String(start.stream_id)
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'clarify' && (f.data as Json).pending_count === 2)
    const clarifies = frames.filter((f) => f.event === 'clarify').map((f) => f.data as Json)
    // Python `_callback_head_payload_locked`: the second arrival re-sends the head (c1) with the new depth, not c2.
    expect(clarifies.map((c) => [c.clarify_id, c.pending_count])).toEqual([['c1', 1], ['c1', 2]])
    // Resolving the head promotes c2 and re-emits it as the live head.
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'c1', response: 'a' })).status).toBe(200)
    const promoted = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:${String(frames.length)}`, (f) => f.event === 'clarify')
    expect(promoted.filter((f) => f.event === 'clarify').map((f) => f.data as Json)).toMatchObject([{ clarify_id: 'c2', pending_count: 1 }])
    // Resolving a non-head entry does not re-emit (nothing changed at the head).
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'c2', response: 'b' })).status).toBe(200)
    releaseAll()
    const rest = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:${String(frames.length + promoted.length)}`, (f) => f.event === 'stream_end')
    expect(rest.filter((f) => f.event === 'clarify')).toEqual([])
    expect(rest.filter((f) => f.event === 'state_saved').map((f) => f.data)).toEqual([
      { session_id: sid, kind: 'memory', action: 'saved' },
      { session_id: sid, kind: 'skill', action: 'created', name: 'deploy' },
    ])
  })

  it('refuses to commit YOLO from a stale approval card while another approval is parked', async () => {
    const sid = await newSession(s)
    let release: () => void = () => undefined
    sidecar.respond('chat.start', async (params, emit) => {
      emit({ event: 'approval', data: { request_id: 'live-1', command: 'rm -rf build', session_id: sid } })
      await new Promise<void>((resolve) => { release = resolve })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }])
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'clean' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'approval')
    const res = await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'stale-0', yolo: true })
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({ ok: false, choice: 'once', relayed: false, code: 'gateway_run_unavailable', error: expect.stringContaining('could not be relayed') as string, yolo_enabled: false })
    expect(await json(await s.get(`/api/session/yolo?session_id=${sid}`))).toEqual({ yolo_enabled: false })
    // The exact-owner relay fields are never satisfiable here either.
    const relay = await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'live-1', run_id: 'r', mirror_token: 't' })
    expect(relay.status).toBe(409)
    expect(await json(relay)).toMatchObject({ ok: false, choice: 'once', relayed: false, code: 'gateway_run_unavailable' })
    sidecar.respond('approval.respond', (params) => ({ ok: true, resolved: 1, choice: params.choice }))
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'live-1' }))).toEqual({ ok: true, choice: 'once' })
    release()
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&after_event_id=${String(start.stream_id)}:0`, (f) => f.event === 'stream_end')
  })

  it('a cancel that lands while the profile config loads never starts the Agent turn', async () => {
    const sid = await newSession(s)
    let starts = 0
    sidecar.respond('chat.start', (params) => { starts += 1; return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'late' }]) })
    const turns = s.deps.turns as unknown as { deps: { profileConfig: ((profile: string | null) => Promise<Record<string, unknown> | null>) | undefined } }
    const original = turns.deps.profileConfig
    let releaseConfig: () => void = () => undefined
    turns.deps.profileConfig = () => new Promise((resolve) => { releaseConfig = () => { resolve({}); } })
    try {
      const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'slow config' }))
      const streamId = String(start.stream_id)
      const until = Date.now() + 5000
      while (!(s.deps.registry.activeRuns.get(streamId)?.phase === 'running') && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
      expect(await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).toMatchObject({ ok: true, cancelled: true })
      releaseConfig()
      const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel' && (f.data as Json).message === 'Cancelled before start')
      expect(frames.filter((f) => f.event === 'cancel').map((f) => (f.data as Json).message)).toEqual(['Cancelled by user', 'Cancelled before start'])
      expect(starts).toBe(0)
    } finally {
      turns.deps.profileConfig = original
    }
  })

  it('an old turn finishing its title work does not clear the successor turn\'s pending prompts', async () => {
    const sid = await newSession(s)
    let releaseTitle: () => void = () => undefined
    sidecar.respond('aux.complete', () => new Promise((resolve) => { releaseTitle = () => { resolve({ model: 'aux', text: 'Titled', usage: null }); } }))
    let releaseSecond: () => void = () => undefined
    let turn = 0
    sidecar.respond('chat.start', async (params, emit) => {
      turn += 1
      if (turn === 1) return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'first done' }])
      emit({ event: 'approval', data: { request_id: 'succ-1', command: 'deploy', session_id: sid } })
      await new Promise<void>((resolve) => { releaseSecond = resolve })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'second done' }])
    })
    const first = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'one' }))
    await s.sse(`/api/chat/stream?stream_id=${String(first.stream_id)}`, (f) => f.event === 'done')
    // Admission was released at `done`; the title prompt is still parked on the aux call. Start the successor.
    const second = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'two' }))
    expect(second.stream_id).toBeDefined()
    await s.sse(`/api/chat/stream?stream_id=${String(second.stream_id)}`, (f) => f.event === 'approval')
    releaseTitle()
    await s.sse(`/api/chat/stream?stream_id=${String(first.stream_id)}&after_event_id=${String(first.stream_id)}:0`, (f) => f.event === 'stream_end')
    // The old turn tore down after its title work, but the successor's approval is still answerable.
    expect(await json(await s.get(`/api/approval/pending?session_id=${sid}`))).toMatchObject({ pending: { approval_id: 'succ-1' }, pending_count: 1 })
    sidecar.respond('approval.respond', (params) => ({ ok: true, resolved: 1, choice: params.choice }))
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'succ-1' }))).toEqual({ ok: true, choice: 'once' })
    releaseSecond()
    await s.sse(`/api/chat/stream?stream_id=${String(second.stream_id)}&after_event_id=${String(second.stream_id)}:0`, (f) => f.event === 'stream_end')
    sidecar.respond('aux.complete', () => { throw new SidecarError('no aux model', { condition: 'aux_unconfigured' }) })
  })

  it('reports no_cached_agent for a steer against an unknown session', async () => {
    expect(await json(await post(s, '/api/chat/steer', { session_id: 'deadbeef0000', text: 'focus' }))).toEqual({ accepted: false, fallback: 'no_cached_agent', stream_id: null })
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

describe('turn context from config.yaml (Python streaming worker)', () => {
  it('sends the workspace system message, personality + surface + delivery ephemeral prompt, budgets, and reasoning config', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: { agent: { max_turns: 7, reasoning_effort: 'high', personalities: { pirate: { system_prompt: 'Talk like a pirate', tone: 'jolly' } } }, max_tokens: 4096, platforms: { telegram: { home_channel: { name: 'ops' } } } } }))
      writeFileSync(join(s.state, 'config.yaml'), '# cfg\n')
      s.deps.agentConfig.invalidate()
      const sid = await newSession(s)
      const session = s.deps.sessionStore.get(sid)
      session.personality = 'pirate'
      s.deps.sessionStore.save(session)
      let seen: Record<string, unknown> = {}
      sidecar.respond('chat.start', (params, emit) => { seen = params; emit({ event: 'token', data: { text: 'arr' } }); return completed([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'arr' }]) })
      const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hi' }))
      await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
      expect(seen.system_message).toContain('Active workspace at session start: ')
      expect(seen.system_message).toContain('[Workspace::v1: /absolute/path]')
      const ephemeral = String(seen.ephemeral_system_prompt)
      expect(ephemeral.startsWith('Talk like a pirate\nTone: jolly\n\nWebUI session context:')).toBe(true)
      expect(ephemeral).toContain(`- Session ID: ${sid}`)
      expect(ephemeral).toContain('WebUI progress guidance:')
      expect(ephemeral).toContain('**Connected Platforms:** local (files on this machine)')
      expect(ephemeral).toContain('  - telegram: ops')
      expect(ephemeral).toContain('- `"telegram"` → Home channel (ops)')
      expect(seen).toMatchObject({ max_iterations: 7, max_tokens: 4096, reasoning_config: { enabled: true, effort: 'high' } })
    } finally {
      await s.close()
    }
  })
})

describe('model-facing history (Python `_sanitize_messages_for_api`)', () => {
  it('drops display-only rows, orphaned tool traffic and a stale cancelled prompt, keeps API-safe keys', () => {
    const history = sanitizeMessagesForApi([
      { role: 'user', content: 'A', timestamp: 1, _recovered: true },
      { role: 'user', content: 'B', timestamp: 2, attachments: [{ path: '/x' }] },
      { role: 'assistant', content: '', reasoning: 'thinking only', timestamp: 3 },
      { role: 'assistant', content: 'partial', _partial: true, timestamp: 4 },
      { role: 'assistant', content: '', _error: true, timestamp: 5 },
      { role: 'tool', content: 'orphan', tool_call_id: 'nope', timestamp: 6 },
      { role: 'assistant', content: 'calls', tool_calls: [{ id: 't1', function: { name: 'f' } }, { id: 't2', function: { name: 'g' } }], timestamp: 7 },
      { role: 'tool', content: 'ok', tool_call_id: 't1', timestamp: 8 },
      { role: 'assistant', content: 'one [OUT-OF-BAND USER MESSAGE - note]\nsecret[/OUT-OF-BAND USER MESSAGE] two', timestamp: 9 },
      { role: 'user', content: 'C', timestamp: 10, _recovered: true },
      { role: 'assistant', content: 'after C', timestamp: 11 },
    ])
    expect(history.map((m) => [m.role, m.content])).toEqual([
      ['user', 'B'], ['assistant', 'partial'], ['assistant', 'calls'], ['tool', 'ok'], ['assistant', 'one  two'], ['user', 'C'], ['assistant', 'after C'],
    ])
    // The recovered prompt A had no assistant on both sides (stale), C separates two assistant turns and stays (marker gone).
    expect(history.every((m) => !('_recovered' in m) && !('attachments' in m) && !('timestamp' in m))).toBe(true)
    expect((history[2]?.tool_calls as { id: string }[]).map((t) => t.id)).toEqual(['t1'])
  })

})
