import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { CANCEL_UNWIND_CEILING_S } from './streams.js'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { sanitizeMessagesForApi } from './merge.js'
import { attachTodoState } from './todo.js'

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
  status: 'completed', messages, final_response: str(messages[messages.length - 1]?.content), error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false,
  usage: { prompt_tokens: 120, completion_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0.001 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [], ...extra,
})

const eventNames = (frames: SseFrame[]): string[] => frames.map((f) => f.event)
const messageKind = (m: Json): string => (m._background_update ? 'background' : str(m.content))

describe('chat turns through the sidecar', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('refuses new chat admission during a Web update without recording a pending turn', async () => {
    const sid = await newSession(s)
    const guard = vi.spyOn(s.deps.updates, 'blocksNewWork').mockReturnValue(true)
    try {
      const res = await post(s, '/api/chat/start', { session_id: sid, message: 'wait for update' })
      expect(res.status).toBe(503)
      const session = s.deps.sessionStore.get(sid)
      expect(session.pending_user_message).toBeNull()
      expect(session.active_stream_id).toBeNull()
    } finally { guard.mockRestore() }
  })

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
    // The live meter (TAL-397) interleaves its own frames; the content order is pinned without them.
    const content = frames.filter((f) => f.event !== 'metering')
    expect(eventNames(content).slice(0, 7)).toEqual(['context_status', 'reasoning', 'tool', 'tool_complete', 'reasoning', 'token', 'token'])
    expect(content[0]?.data).toEqual({ session_id: sid, prefill: { status: 'not_configured', source: 'none', label: '', message_count: 0 } })
    expect(content[4]?.data).toEqual({ text: '', titles: ['thinking'] })
    expect(names).toContain('done')
    expect(names).toContain('title')
    expect(names[names.length - 1]).toBe('stream_end')
    expect(frames.every((f) => f.id?.startsWith(`${streamId}:`))).toBe(true)
    expect(frames.map((f) => Number(f.id?.split(':')[1]))).toEqual(frames.map((_, i) => i + 1))
    const done = frames.find((f) => f.event === 'done')?.data as Json
    const doneSession = done.session as Json
    expect((doneSession.messages as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'hello there'], ['assistant', ''], ['tool', 'contents'], ['assistant', 'Hi back']])
    // TAL-303: the settled session names its workspace like the list and detail do (the default workspace is Home).
    expect(doneSession.workspace_name).toBe('Home')
    // Every row the turn wrote carries its stream id as the turn identity, matching the start response.
    expect(start.turn_id).toBe(streamId)
    expect((doneSession.messages as Json[]).map((m) => m._turn_id)).toEqual([streamId, streamId, streamId, streamId])
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
    expect((detail.messages as Json[]).map((m) => m._turn_id)).toEqual([streamId, streamId, streamId, streamId])
    // Reasoning streamed before the first tool call belongs to that first assistant row (Python per-segment attribution).
    expect((detail.messages as Json[])[1]).toMatchObject({ role: 'assistant', reasoning: 'thinking' })
    expect((detail.messages as Json[])[3]).toMatchObject({ content: 'Hi back', _usedModel: 'test-model' })
    expect(detail.tool_calls).toEqual([{ name: 'read_file', snippet: 'contents', tid: 'call_1', assistant_msg_idx: 1, args: { path: 'a' }, kind: 'read', target: 'a', is_error: false, duration: expect.any(Number) as number }])
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

  it('ships one server-computed context ring on the done usage, the terminal session, a reload, and list and search rows (TAL-299)', async () => {
    const sid = await newSession(s)
    // The provider's cumulative prompt total (900K) is never the ring's numerator.
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Half full' }], {
      usage: { prompt_tokens: 900_000, completion_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null },
      context: { context_length: 128_000, last_prompt_tokens: 64_000, threshold_tokens: 100_000 },
    }))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Ring"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'fill the ring' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const done = frames.find((f) => f.event === 'done')?.data as Json
    // The shared fixture's populated example is this session: every consumer decodes the same figures.
    const example = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { context_usage_sessions: { populated: Json } }).context_usage_sessions.populated
    const ring = { context_used_tokens: 64_000, context_window_tokens: 128_000, context_usage_percent: 50, context_threshold_percent: 78 }
    expect(example).toMatchObject({ ...ring, input_tokens: 900_000, context_length: 128_000, last_prompt_tokens: 64_000, threshold_tokens: 100_000 })
    expect(done.usage).toMatchObject(ring)
    expect(done.session).toMatchObject(ring)
    expect((await json(await s.get(`/api/session?session_id=${sid}`))).session).toMatchObject(ring)
    const row = ((await json(await s.get('/api/sessions'))).sessions as Json[]).find((r) => r.session_id === sid)
    expect(row).toMatchObject(ring)
    expect(row).not.toHaveProperty('window_usage_percent')
    expect(((await json(await s.get('/api/sessions/search?q=fill'))).sessions as Json[]).find((r) => r.session_id === sid)).toMatchObject(ring)
  })

  it('redacts live, journaled and replayed tool frames and ships one kind and target live, after replay and after reload', async () => {
    const bearer = 'synthetic-bearer-0123456789abcdef'
    const pg = 'pgSyntheticSecret42'
    const gh = 'syntheticGithubToken0123456789'
    const command = `curl -H "Authorization: Bearer ${bearer}" https://x && psql postgres://u:${pg}@h/db && GITHUB_TOKEN=${gh} gh api user`
    const secrets = [bearer, pg, gh]
    const leaks = (value: unknown) => secrets.filter((secret) => JSON.stringify(value).includes(secret))
    const run = async () => {
      const sid = await newSession(s)
      sidecar.respond('chat.start', (params, emit) => {
        emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: command, args: { command }, tid: 'call_1' } })
        emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: command, args: { command }, tid: 'call_1', is_error: false } })
        return completed([
          { role: 'user', content: str(params.user_message) },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command }) } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
          { role: 'assistant', content: 'Done.' },
        ])
      })
      sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Tool run"', usage: null }))
      const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'run it' }))).stream_id)
      const frames = (await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')).filter((f) => f.event === 'tool' || f.event === 'tool_complete')
      const journalPath = join(realpathSync(s.state), 'sessions', '_run_journal', sid, `${streamId}.jsonl`)
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      return { sid, streamId, frames, journalPath, detail }
    }

    const { streamId, frames, journalPath, detail } = await run()
    expect(frames.map((f) => f.event)).toEqual(['tool', 'tool_complete'])
    expect(leaks(frames.map((f) => f.data))).toEqual([])
    expect(leaks(readFileSync(journalPath, 'utf8'))).toEqual([])
    const live = frames.map((f) => f.data as Json)
    expect(live.map((d) => d.kind)).toEqual(['shell', 'shell'])
    const target = String(live[0]?.target)
    expect(target).toMatch(/^curl -H "Authorization: Bearer /)
    expect(live[1]?.target).toBe(target)

    // A journal written before redaction existed is redacted and stamped on read, including the id it replays with.
    const legacyTid = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
    const legacy = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json).map((row) => {
      if (row.event !== 'tool' && row.event !== 'tool_complete') return row
      // New rows record that the server redacted them; a legacy row has no such flag and carries the raw args.
      expect(row.redacted).toBe(true)
      const legacyRow: Json = { ...row, payload: { event_type: 'tool.started', name: 'terminal', preview: command, args: { command }, tid: legacyTid } }
      delete legacyRow.redacted
      return legacyRow
    })
    writeFileSync(journalPath, `${legacy.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const replayed = (await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')).filter((f) => f.event === 'tool' || f.event === 'tool_complete')
    expect(replayed).toHaveLength(2)
    expect(leaks(replayed.map((f) => f.data))).toEqual([])
    expect(JSON.stringify(replayed.map((f) => f.data))).not.toContain(legacyTid)
    expect(replayed.map((f) => [(f.data as Json).kind, (f.data as Json).target])).toEqual([['shell', target], ['shell', target]])

    // After reload: the persisted call, the session-level call, and the scene row carry the same kind and target.
    expect(leaks(detail)).toEqual([])
    const messages = detail.messages as Json[]
    expect((messages[1]?.tool_calls as Json[])[0]).toMatchObject({ kind: 'shell', target })
    expect((detail.tool_calls as Json[])[0]).toMatchObject({ kind: 'shell', target })
    const sceneTool = ((messages[3]?._anchor_activity_scene as Json).activity_rows as Json[]).find((row) => row.role === 'tool')?.tool as Json
    expect(sceneTool).toMatchObject({ kind: 'shell', target })

    // With redaction off, live frames match session detail: both show the command as written.
    s.deps.settings.save({ api_redact_enabled: false })
    let offStream = ''
    let offSid = ''
    try {
      const off = await run()
      offStream = off.streamId
      offSid = off.sid
      expect(off.frames.map((f) => (f.data as Json).target)).toEqual([command, command].map((c) => c.slice(0, 200)))
      expect((off.detail.tool_calls as Json[])[0]).toMatchObject({ kind: 'shell', target: command.slice(0, 200) })
    } finally {
      s.deps.settings.save({ api_redact_enabled: true })
    }
    // Frames journaled while redaction was off are redacted when replayed after it is turned back on.
    const reopened = (await s.sse(`/api/chat/stream?stream_id=${offStream}&after_event_id=${offStream}:0`, (f) => f.event === 'stream_end')).filter((f) => f.event === 'tool' || f.event === 'tool_complete')
    expect(reopened).toHaveLength(2)
    expect(leaks(reopened.map((f) => f.data))).toEqual([])
    // The per-session journal relay replays the same rows through the same projection.
    const perSession = (await s.sse(`/api/sessions/${offSid}/events?after_event_id=${offStream}:1`, (f) => f.event === 'tool_complete', { timeoutMs: 3000 })).filter((f) => f.event === 'tool' || f.event === 'tool_complete')
    expect(perSession).toHaveLength(2)
    expect(leaks(perSession.map((f) => f.data))).toEqual([])
    expect(perSession.map((f) => (f.data as Json).kind)).toEqual(['shell', 'shell'])

    // Frames buffered for a late subscriber while redaction was off are redacted on delivery once it is back on.
    const bufferedSid = await newSession(s)
    let release: () => void = () => undefined
    let bufferedStream = ''
    s.deps.settings.save({ api_redact_enabled: false })
    try {
      sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
        emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: command, args: { command }, tid: 'call_1' } })
        emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: command, args: { command }, tid: 'call_1', is_error: false } })
        release = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Done.' }])) }
      }))
      bufferedStream = String((await json(await post(s, '/api/chat/start', { session_id: bufferedSid, message: 'run it' }))).stream_id)
      const bufferedJournal = join(realpathSync(s.state), 'sessions', '_run_journal', bufferedSid, `${bufferedStream}.jsonl`)
      const deadline = Date.now() + 3000
      while (!(existsSync(bufferedJournal) && readFileSync(bufferedJournal, 'utf8').includes('"tool_complete"')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    } finally {
      s.deps.settings.save({ api_redact_enabled: true })
    }
    try {
      const delivered = (await s.sse(`/api/chat/stream?stream_id=${bufferedStream}`, (f) => f.event === 'tool_complete')).filter((f) => f.event === 'tool' || f.event === 'tool_complete')
      expect(delivered).toHaveLength(2)
      expect(leaks(delivered.map((f) => f.data))).toEqual([])
      expect(delivered.map((f) => (f.data as Json).kind)).toEqual(['shell', 'shell'])
    } finally {
      release()
    }
  })

  it('ships a file edit\'s redacted, capped diff with whole-diff counts live and after reload (TAL-448)', async () => {
    const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
    const added = Array.from({ length: 450 }, (_, i) => `+line ${String(i)}`)
    const diff = ['--- a/app.env', '+++ b/app.env', '@@ -1,2 +1,2 @@', ' KEEP=1', '-OLD=1', `+GITHUB_TOKEN=${secret}`,
      '--- a/notes.md', '+++ b/notes.md', '@@ -1,1 +1,451 @@', '--- dashes', ...added].join('\n') + '\n'
    const patchResult = JSON.stringify({ success: true, diff, files_modified: ['app.env', 'notes.md'] })
    const writeResult = JSON.stringify({ bytes_written: 3 })
    const run = async () => {
      const sid = await newSession(s)
      sidecar.respond('chat.start', (params, emit) => {
        emit({ event: 'tool', data: { event_type: 'tool.started', name: 'patch', args: { path: 'app.env' }, tid: 'call_patch' } })
        // The sidecar's `raw_result` caps the diff; its whole text rides as `result_diff`.
        emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'patch', preview: 'ok', args: { path: 'app.env' }, tid: 'call_patch', raw_result: { success: true, diff: diff.slice(0, 4000) }, result_diff: diff } })
        emit({ event: 'tool', data: { event_type: 'tool.started', name: 'write_file', args: { path: 'b.txt' }, tid: 'call_write' } })
        emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'write_file', preview: writeResult, args: { path: 'b.txt' }, tid: 'call_write', raw_result: { bytes_written: 3 } } })
        return completed([
          { role: 'user', content: str(params.user_message) },
          { role: 'assistant', content: '', tool_calls: [
            { id: 'call_patch', type: 'function', function: { name: 'patch', arguments: JSON.stringify({ path: 'app.env' }) } },
            { id: 'call_write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt' }) } },
          ] },
          { role: 'tool', tool_call_id: 'call_patch', content: patchResult },
          { role: 'tool', tool_call_id: 'call_write', content: writeResult },
          { role: 'assistant', content: 'Edited.' },
        ])
      })
      sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Edit"', usage: null }))
      const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'edit it' }))).stream_id)
      const frames = (await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')).filter((f) => f.event === 'tool_complete').map((f) => f.data as Json)
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      const messages = detail.messages as Json[]
      const scene = ((messages.at(-1)?._anchor_activity_scene as Json).activity_rows as Json[]).filter((row) => row.role === 'tool').map((row) => row.tool as Json)
      return { frames, calls: messages[1]?.tool_calls as Json[], scene }
    }

    const { frames, calls, scene } = await run()
    const live = frames[0]?.edit_diff as Json
    expect(live).toMatchObject({ added: 451, removed: 2, truncated: true })
    expect(String(live.diff).split('\n')).toHaveLength(400)
    expect(String(live.diff)).toContain('+GITHUB_TOKEN=')
    expect(String(live.diff)).not.toContain(secret)
    expect(JSON.stringify(frames)).not.toContain('result_diff')
    // After reload the persisted call and its scene row carry the same change; a write without a diff carries none.
    for (const shown of [frames, calls, scene]) {
      expect(shown.map((call) => call.edit_diff)).toEqual([live, undefined])
    }
    // With redaction off the diff shows as written, like the rest of the call.
    s.deps.settings.save({ api_redact_enabled: false })
    try {
      const off = await run()
      for (const shown of [off.frames, off.calls, off.scene]) expect(String(shown[0]?.edit_diff && (shown[0].edit_diff as Json).diff)).toContain(secret)
    } finally {
      s.deps.settings.save({ api_redact_enabled: true })
    }
  })

  it('ships one canonical tool-call id on live, replayed and pre-change journal tool frames', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params, emit) => {
      // Two same-name calls that finish in reverse order.
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'a' }, tid: 'call_a' } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'b' }, tid: 'call_b' } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'B', tid: 'call_b', is_error: false } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'A', tid: 'call_a', is_error: true } })
      // Agent callbacks without a call id: the server mints one, and a completion settles the newest unfinished same-name call.
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', preview: null, args: { path: 'c' }, tid: '' } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', preview: null, args: { path: 'd' } } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', preview: 'D', is_error: false } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', preview: 'C', is_error: false } })
      // A completion naming its call settles that call even when a newer same-name call has no id.
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'e' }, tid: 'call_e' } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', preview: null, args: { command: 'f' } } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'E', tid: 'call_e', is_error: false } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'F', is_error: false } })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Done.' }])
    })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Tool ids"', usage: null }))
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'run both' }))).stream_id)
    const tools = (frames: SseFrame[]) => frames.filter((f) => f.event === 'tool' || f.event === 'tool_complete').map((f) => f.data as Json)
    const pairs = (frames: Json[]) => frames.map((d) => [d.id, d.preview])

    const live = tools(await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end'))
    const [c, d] = [live[4]?.id, live[5]?.id]
    expect(c).toMatch(new RegExp(`^tool-${streamId}-\\d+$`))
    expect(d).toMatch(new RegExp(`^tool-${streamId}-\\d+$`))
    expect(c).not.toBe(d)
    const f = live[9]?.id
    expect(f).toMatch(new RegExp(`^tool-${streamId}-\\d+$`))
    const expected = [['call_a', null], ['call_b', null], ['call_b', 'B'], ['call_a', 'A'], [c, null], [d, null], [d, 'D'], [c, 'C'], ['call_e', null], [f, null], ['call_e', 'E'], [f, 'F']]
    expect(pairs(live)).toEqual(expected)
    expect(live.filter((frame) => 'tid' in frame)).toEqual([])

    // The journal stores the public frame, so a reconnect from the start replays the same pairing.
    const journalPath = join(realpathSync(s.state), 'sessions', '_run_journal', sid, `${streamId}.jsonl`)
    expect(readFileSync(journalPath, 'utf8')).not.toContain('"tid"')
    const replayed = tools(await s.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=0`, (f) => f.event === 'stream_end'))
    expect(pairs(replayed)).toEqual(expected)

    // A journal written before the public id carries the Agent's call id as `tid`.
    const legacy = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json).map((row) => {
      if (row.event !== 'tool' && row.event !== 'tool_complete') return row
      const { id, ...payload } = row.payload as Json
      return { ...row, payload: { ...payload, tid: str(id).startsWith('call_') ? id : '' } }
    })
    writeFileSync(journalPath, `${legacy.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const fromLegacy = tools(await s.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=0`, (f) => f.event === 'stream_end'))
    expect(pairs(fromLegacy).slice(0, 4)).toEqual(expected.slice(0, 4))
    expect(fromLegacy.every((frame) => typeof frame.id === 'string' && frame.id !== '' && !('tid' in frame))).toBe(true)
    // Its id-less rows pair across the run the way the live server pairs them, even when the cursor is past the start.
    const [lc, ld] = [fromLegacy[4]?.id, fromLegacy[5]?.id]
    expect(lc).not.toBe(ld)
    const lf = fromLegacy[9]?.id
    expect(pairs(fromLegacy).slice(4)).toEqual([[lc, null], [ld, null], [ld, 'D'], [lc, 'C'], ['call_e', null], [lf, null], ['call_e', 'E'], [lf, 'F']])
    const startSeq = legacy.findIndex((row) => row.event === 'tool' && (row.payload as Json).tid === '' && ((row.payload as Json).args as Json).path === 'c') + 1
    const tail = tools(await s.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=${String(startSeq)}`, (f) => f.event === 'stream_end'))
    expect(pairs(tail).slice(0, 3)).toEqual([[ld, null], [ld, 'D'], [lc, 'C']])
  })

  it('names a tool\'s minted id as the causal place of a steer the Agent took after it', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let release: () => void = () => undefined
    let emitLive: ((frame: { event: string; data: Json }) => void) | null = null
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emitLive = emit
      release = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Done.' }])) }
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', args: {} } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', preview: 'A' } })
    }))
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'read' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'tool_complete')
    await post(s, '/api/chat/steer', { session_id: sid, text: 'then stop', steer_id: 'steer-m' })
    emitLive!({ event: 'steer_pending', data: { text: '' } })
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'steer_consumed')
    const toolId = (frames.find((f) => f.event === 'tool_complete')?.data as Json).id
    expect(toolId).toMatch(new RegExp(`^tool-${streamId}-\\d+$`))
    expect((frames.find((f) => f.event === 'steer_consumed')?.data as Json).after_tool_call_id).toBe(toolId)
    release()
  })

  it('builds the settled turn\'s scene with Codex commentary as prose under Worked, leaving the stored rows as the Agent wrote them', async () => {
    const sid = await newSession(s)
    const commentary = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text }] })
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'interim_assistant', data: { text: 'Reading both config files.', already_streamed: false } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', preview: null, args: { path: 'a' }, tid: 'call_1' } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', preview: 'port = 8080', args: { path: 'a' }, tid: 'call_1', is_error: false } })
      // The Agent routes phase=commentary text into `reasoning` and leaves `content` empty on the tool-call row.
      return completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: '', reasoning: 'Plan the lookup.\n\nReading both config files.', codex_message_items: [commentary('Reading both config files.')], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'port = 8080' },
        { role: 'assistant', content: 'The service uses port 8080.', codex_message_items: [{ ...commentary('The service uses port 8080.'), phase: 'final_answer' }] },
      ])
    })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Port check"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'which port?' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const settled = ((frames.find((f) => f.event === 'done')?.data as Json).session as Json).messages as Json[]
    const detail = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    for (const messages of [settled, detail]) {
      expect(messages[1]).toMatchObject({ role: 'assistant', content: '' })
      expect(messages[3]?._anchor_activity_scene).toMatchObject({
        version: 'activity_scene_v1', final_answer: 'The service uses port 8080.', terminal_state: 'completed', expanded_by_default: false,
        activity_rows: [
          { role: 'reasoning', text: 'Plan the lookup.' },
          { role: 'prose', text: 'Reading both config files.' },
          { role: 'tool', row_id: 'tool:call_1', tool: { id: 'call_1', name: 'read_file', args: { path: 'a' }, result: 'port = 8080', done: true, is_error: false } },
        ],
      })
      expect((messages[3]?._anchor_activity_scene as Json).activity_rows).toHaveLength(3)
      expect(messages[1]?._anchor_activity_scene).toBeUndefined()
    }
  })

  it('settles inline thinking and leaked tool-call XML into one display shape on the done frame and every reload (TAL-302)', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'earlier', timestamp: 1000 }, { role: 'assistant', content: '<thinking>old plan</thinking>Old answer', timestamp: 1001 }]
    s.deps.sessionStore.save(session)
    const raw = '<|channel|>thought\nplan<channel|>Answer <｜DSML｜function_calls><｜DSML｜invoke name="x">'
    sidecar.respond('chat.start', (params) => completed([
      { role: 'user', content: 'earlier' }, { role: 'assistant', content: '<thinking>old plan</thinking>Old answer' },
      { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: raw, reasoning_content: 'rc', reasoning: 'rc' },
    ]))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Thinking"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'think' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const done = ((frames.find((f) => f.event === 'done')?.data as Json).session as Json).messages as Json[]
    const shape = (messages: Json[]) => messages.filter((m) => m.role === 'assistant').map((m) => ({ content: m.content, reasoning: m.reasoning, rc: m.reasoning_content, answer: (m._anchor_activity_scene as Json).final_answer }))
    const expected = [{ content: 'Old answer', reasoning: 'old plan', rc: undefined, answer: 'Old answer' }, { content: 'Answer', reasoning: 'rc\n\nplan', rc: undefined, answer: 'Answer' }]
    expect(shape(done)).toEqual(expected)
    for (const query of ['', '&msg_limit=120', '&msg_limit=1']) {
      const detail = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json).messages as Json[]
      expect(shape(detail)).toEqual(expected.slice(-shape(detail).length))
    }
    // Only the settling turn's prose is rewritten in the file; its own fields and the model history stay as the Agent wrote them.
    const stored = s.deps.sessionStore.get(sid)
    expect(stored.messages.filter((m) => m.role === 'assistant').map((m) => [m.content, m.reasoning, m.reasoning_content])).toEqual([['<thinking>old plan</thinking>Old answer', undefined, undefined], ['Answer', 'rc\n\nplan', 'rc']])
    expect(stored.context_messages.at(-1)).toMatchObject({ content: raw, reasoning_content: 'rc' })
  })

  it('persists the tool-limit outcome so the settled scene matches the live done frame after reload', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([
      { role: 'user', content: str(params.user_message) },
      { role: 'assistant', content: 'Working', tool_calls: [{ id: 'l1', name: 'read_file' }] },
      { role: 'tool', tool_call_id: 'l1', content: 'x' },
    ], { tool_limit_reached: true, final_response: 'Tool budget exhausted; here is the saved explanation.' }))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Limited"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'loop' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const done = frames.find((f) => f.event === 'done')?.data as Json
    expect(done.terminal_state).toBe('tool_limit_reached')
    const detail = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    for (const messages of [(done.session as Json).messages as Json[], detail]) {
      expect(messages.at(-1)?._anchor_activity_scene).toMatchObject({ terminal_state: 'tool_limit_reached', expanded_by_default: true, final_answer: 'Tool budget exhausted; here is the saved explanation.' })
    }
  })

  it('marks a long prompt collapsible on the done frame (TAL-452)', async () => {
    const sid = await newSession(s)
    const prompt = Array.from({ length: 21 }, (_, i) => `trace ${i}`).join('\n')
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: prompt }]))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Trace"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: prompt }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const messages = (((frames.find((f) => f.event === 'done')?.data as Json).session as Json).messages as Json[])
    expect(messages.map((m) => [m.role, m._collapsible ?? null])).toEqual([['user', true], ['assistant', null]])
  })

  it('ships an earlier bare-filename attachment as a filename-only object on the done frame (TAL-277)', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'look', timestamp: 1000, attachments: ['example.png'] }, { role: 'assistant', content: 'seen', timestamp: 1001 }]
    s.deps.sessionStore.save(session)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Again' }]))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Legacy"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'again' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const messages = (((frames.find((f) => f.event === 'done')?.data as Json).session as Json).messages as Json[])
    expect(messages.find((m) => m.content === 'look')?.attachments).toEqual([{ name: 'example.png', filename: 'example.png' }])
  })

  it('ships served media references rewritten for display on the done frame and every detail window, keeping content (TAL-186)', async () => {
    const sid = await newSession(s)
    const ws = realpathSync(join(s.state, 'workspace'))
    writeFileSync(join(ws, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const denied = join(s.state, 'sessions', 'leak.png')
    const reply = `**Here MEDIA:${join(ws, 'shot.png')} done**\n\n- ![song](${join(ws, 'song.mp3')})\n\n> ![outside](/etc/outside.png) MEDIA:${denied}\n\n\`MEDIA:${join(ws, 'shot.png')}\``
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: reply }]))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Media"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'show me' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const url = (path: string): string => `./api/media?${new URLSearchParams({ path, session_id: sid }).toString()}`
    const display = `**Here ![shot.png](${url(join(ws, 'shot.png'))}) done**\n\n- [song](${url(join(ws, 'song.mp3'))})\n\n> ![outside](/etc/outside.png) MEDIA:${denied}\n\n\`MEDIA:${join(ws, 'shot.png')}\``
    const media = [
      { url: url(join(ws, 'shot.png')), name: 'shot.png', mime: 'image/png', kind: 'image' },
      { url: url(join(ws, 'song.mp3')), name: 'song.mp3', mime: 'audio/mpeg', kind: 'audio' },
    ]
    const doneMessages = ((frames.find((f) => f.event === 'done')?.data as Json).session as Json).messages as Json[]
    const full = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    const windowed = ((await json(await s.get(`/api/session?session_id=${sid}&msg_limit=1`))).session as Json).messages as Json[]
    for (const messages of [doneMessages, full, windowed]) {
      const settled = messages.find((m) => m.role === 'assistant')
      expect(settled?.content).toBe(reply)
      expect(settled?._display_content).toBe(display)
      expect(settled?._media).toEqual(media)
      expect(settled?._anchor_activity_scene).toMatchObject({ final_answer: reply, final_answer_display: display, final_answer_media: media })
    }
    expect(full.find((m) => m.role === 'user')).not.toHaveProperty('_display_content')
    const served = await s.get(`/${url(join(ws, 'shot.png')).slice(2)}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
  })

  it('ships a long reply\'s excerpt on the done frame (TAL-456)', async () => {
    const sid = await newSession(s)
    const reply = `${'r'.repeat(2800)} ${'s'.repeat(4000)}`
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: reply }]))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Long"', usage: null }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'write a lot' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const messages = (((frames.find((f) => f.event === 'done')?.data as Json).session as Json).messages as Json[])
    const settled = messages.find((m) => m.role === 'assistant')
    expect(settled?._display_truncated).toBe(true)
    expect(settled?._display_excerpt).toBe('r'.repeat(2800))
    expect((settled?._anchor_activity_scene as Json | undefined)?.final_answer_excerpt).toBe('r'.repeat(2800))
    expect(messages.find((m) => m.role === 'user')).not.toHaveProperty('_display_excerpt')
  })

  it('stamps one terminal_state on every terminal frame and the persisted turn, and keeps the journal vocabulary', async () => {
    const cases: [string, (params: Json, emit: (frame: { event: string; data: Json }) => void) => ChatResult, string, string, string, string][] = [
      ['completed', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Answer' }]), 'done', 'completed', 'completed', 'completed'],
      ['no_response', (params, emit) => {
        emit({ event: 'token', data: { text: ' ' } })
        return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: '', tool_calls: [{ id: 'nr1', name: 'read_file' }] }, { role: 'tool', tool_call_id: 'nr1', content: 'x' }])
      }, 'done', 'no_response', 'errored', 'failed'],
      ['cancelled', () => { throw new Error('Task cancelled by user') }, 'apperror', 'cancelled', 'interrupted-by-user', 'cancelled'],
      ['interrupted', () => { throw new Error('Response interrupted') }, 'apperror', 'interrupted', 'interrupted-by-crash', 'failed'],
      ['compression_exhausted', () => { throw new Error('compression_exhausted: context length exceeded and cannot compress further') }, 'apperror', 'compression_exhausted', 'errored', 'failed'],
      ['error', () => { throw new Error('boom') }, 'apperror', 'error', 'errored', 'failed'],
    ]
    const relayPhase = vi.spyOn(s.deps.relay, 'noteTerminal')
    for (const [label, respond, event, state, journalState, phase] of cases) {
      relayPhase.mockClear()
      const sid = await newSession(s)
      sidecar.respond('chat.start', (params, emit) => respond(params as Json, emit as never))
      const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: label }))
      const streamId = String(start.stream_id)
      const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end' || f.event === 'apperror')
      expect((frames.find((f) => f.event === event)?.data as Json).terminal_state, label).toBe(state)
      // The scene rides on the turn's last assistant row, in the full transcript and in each window that holds it.
      const total = s.deps.sessionStore.get(sid).messages.length
      for (const query of ['', '&msg_limit=2', `&msg_limit=2&msg_before=${String(total)}`]) {
        const messages = ((await json(await s.get(`/api/session?session_id=${sid}${query}`))).session as Json).messages as Json[]
        expect(messages.findLast((m) => m.role === 'assistant')?._anchor_activity_scene, `${label}${query}`).toMatchObject({ terminal_state: state })
      }
      if (event === 'apperror') expect(s.deps.sessionStore.get(sid).messages.at(-1)?._terminal_state, label).toBe(state)
      const status = await json(await s.get(`/api/chat/stream/status?stream_id=${streamId}`))
      expect((status.journal as Json).terminal_state, label).toBe(journalState)
      // Relay publishes the same outcome the app shows: only a completed turn is `completed`.
      expect(relayPhase.mock.calls.map(([, p]) => p), label).toEqual([phase])
    }
    relayPhase.mockRestore()
  })

  it('relays approval and clarify prompts and resolves them through the sidecar', async () => {
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

  it('skips background titling when the profile turns auxiliary.title_generation.enabled off; manual regenerate still titles (TAL-531)', async () => {
    const turns = s.deps.turns as unknown as { deps: { profileConfig: ((profile: string | null) => Promise<Record<string, unknown> | null>) | undefined } }
    const original = turns.deps.profileConfig
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Use a feature flag and roll it out per tenant.' }]))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Tenant rollout"', usage: null }))
    // The Agent's `is_truthy_value(default=True)` allowlist: only 1/true/yes/on enable, so an empty string disables too;
    // other values follow Python truthiness, where empty containers are false. An unreadable config (null) fails closed.
    const cases: [Record<string, unknown> | null, string][] = [
      ...[false, 'off', '', [], {}].map((enabled): [Record<string, unknown>, string] => [{ auxiliary: { title_generation: { enabled } } }, 'title_generation_disabled']),
      [null, 'config_unavailable'],
    ]
    for (const [config, reason] of cases) {
      turns.deps.profileConfig = () => Promise.resolve(config)
      try {
        const sid = await newSession(s)
        const before = sidecar.calls.filter((c) => c.method === 'aux.complete').length
        const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'how should we roll out the tenant migration' }))
        const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
        expect(sidecar.calls.filter((c) => c.method === 'aux.complete').length, `config=${JSON.stringify(config)}`).toBe(before)
        expect(frames.find((f) => f.event === 'title_status')?.data as Json).toMatchObject({ status: 'skipped', reason })
        expect(eventNames(frames)).not.toContain('title')
        const regenerated = await post(s, '/api/session/title/regenerate', { session_id: sid })
        expect(regenerated.status, await regenerated.clone().text()).toBe(200)
        expect((await json(regenerated)).title).toBe('Tenant rollout')
      } finally {
        turns.deps.profileConfig = original
      }
    }
  })

  it('cancels a running turn, persists the partial, and refuses a second concurrent start', async () => {
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
    expect(await json(res)).toEqual({ ok: true, cancelled: true, stream_id: streamId, withdrawn_steers: [] })
    expect(interrupted).toBe(true)
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'cancel')
    expect(eventNames(frames)).toContain('cancel')
    // TAL-364: the terminal frame names the outcome only; clients show their one localized status for it.
    const cancel = frames.find((f) => f.event === 'cancel')?.data as Json
    expect(cancel).toMatchObject({ type: 'cancelled', status: 'cancelled', terminal_state: 'cancelled' })
    expect(cancel).not.toHaveProperty('message')
    expect(cancel).not.toHaveProperty('hint')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const messages = detail.messages as Json[]
    expect(messages[0]).toMatchObject({ role: 'user', content: 'long task', _recovered: true })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'partial answer', _partial: true })
    expect(messages[2]).toMatchObject({ role: 'assistant', content: '', _error: true, _terminal_state: 'cancelled', _anchor_activity_scene: { terminal_state: 'cancelled', final_answer: '' } })
    expect(messages.map((m) => m._turn_id)).toEqual([streamId, streamId, streamId])
    expect(((frames.find((f) => f.event === 'cancel')?.data as Json).session as Json | undefined)?.messages).toSatisfy((rows: Json[] | undefined) => !rows || rows.every((m) => m._turn_id === streamId))
    expect(detail.active_stream_id).toBeNull()
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'after cancel' })).status).toBe(200)
    expect(await json(await s.get('/api/chat/cancel?stream_id=nope'))).toEqual({ ok: true, cancelled: false, stream_id: 'nope', withdrawn_steers: [] })
  })

  it('announces every started turn on the session-list stream so an open chat elsewhere can attach (TAL-434)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'answer' }]))
    const first = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'first' }))
    await s.sse(`/api/chat/stream?stream_id=${String(first.stream_id)}`, (f) => f.event === 'done')

    const started = s.sse('/api/sessions/events', (f) => f.event === 'sessions_changed' && (f.data as Json).reason === 'turn_started')
    await new Promise((r) => setTimeout(r, 50))
    const second = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'second' }))
    const frames = await started
    expect(frames.find((f) => (f.data as Json).reason === 'turn_started')?.data).toMatchObject({ type: 'sessions_changed', reason: 'turn_started', session_id: sid })
    await s.sse(`/api/chat/stream?stream_id=${String(second.stream_id)}`, (f) => f.event === 'done')
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

  it('turns sidecar failures into apperror frames and a persisted error bubble', async () => {
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
    expect(messages.map((m) => m._turn_id)).toEqual([streamId, streamId])
    expect(((error.session as Json).messages as Json[]).map((m) => m._turn_id)).toEqual([streamId, streamId])
    expect(detail.active_stream_id).toBeNull()
    // A silent success (no assistant reply, no tokens) is classified as no_response.
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }], { token_sent: false, final_response: '' }))
    const start2 = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'silent' }))
    const frames2 = await s.sse(`/api/chat/stream?stream_id=${String(start2.stream_id)}&replay=1`, (f) => f.event === 'apperror')
    expect((frames2.find((f) => f.event === 'apperror')?.data as Json).type).toBe('no_response')
    // The persisted error row keeps that classification, so the settled scene says the same after a reload.
    const reloaded = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(reloaded.at(-1)?._anchor_activity_scene).toMatchObject({ terminal_state: 'no_response' })
  })

  it('steers the live agent and reports fallbacks when nothing is running', async () => {
    const sid = await newSession(s)
    expect(await json(await post(s, '/api/chat/steer', { session_id: sid, text: 'focus' }))).toEqual({ accepted: false, fallback: 'not_running', stream_id: null })
    let steered: string | null = null
    sidecar.respond('chat.steer', (params) => { steered = params.text; return { accepted: true, fallback: null } })
    let release: () => void = () => undefined
    let emitLive: ((frame: { event: 'steer_pending' | 'token'; data: { text: string } }) => void) | null = null
    const prompts: string[] = []
    sidecar.respond('chat.start', (params, emit) => {
      prompts.push(str(params.user_message))
      if (prompts.length > 1) return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'follow-up done' }])
      return new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'working' } })
        emitLive = emit
        release = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'working done' }], { pending_steer: 'second' })) }
      })
    })
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
    expect(frames.filter((f) => f.event === 'steer_consumed')).toHaveLength(1)
    // TAL-424: the server, not each client, sends the steer the turn ended without taking: one follow-up turn.
    expect(frames.some((f) => f.event === 'pending_steer_leftover')).toBe(false)
    expect(frames.find((f) => f.event === 'steer_withdrawn')?.data).toEqual({ steer_id: 'steer-2', reason: 'followup', text: 'second' })
    await vi.waitFor(() => { expect(prompts).toHaveLength(2) })
    expect(prompts[1]).toMatch(/\nsecond$/)
    await vi.waitFor(() => { expect(s.deps.sessionStore.get(sid).active_stream_id).toBeNull() })
    expect(prompts).toHaveLength(2)
  })

  it('a message sent during a background turn starts its own turn; the background turn stops without a trace (TAL-460)', async () => {
    const sid = await newSession(s)
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    let steered = false
    sidecar.respond('chat.steer', () => { steered = true; return { accepted: true, fallback: null } })
    const histories: Json[][] = []
    sidecar.respond('chat.start', (params, emit, opts) => {
      histories.push(params.conversation_history)
      if (!str(params.user_message).includes('Background process')) return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Here is your answer.' }])
      return new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'Looking at the backup' } })
        opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
      })
    })
    await s.deps.completions.processOne({ process_id: 'proc_bg', session_id: 'proc_bg', type: 'completion', command: 'backup', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
    const background = str(s.deps.sessionStore.get(sid).active_stream_id)
    expect(background).not.toBe('')
    await s.sse(`/api/chat/stream?stream_id=${background}`, (f) => f.event === 'token')
    const res = await json(await post(s, '/api/chat/steer', { session_id: sid, text: 'what about my question?', steer_id: 'steer-bg' }))
    expect(steered, 'the message never joins the background turn').toBe(false)
    expect(res).toMatchObject({ accepted: true, fallback: null, steer_id: 'steer-bg' })
    const turn = res.started_turn as Json
    expect(turn.stream_id).toBe(res.stream_id)
    expect(res.stream_id).not.toBe(background)
    await s.sse(`/api/chat/stream?stream_id=${String(res.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.map((m) => [m.role, messageKind(m)])).toEqual([['user', 'background'], ['user', 'what about my question?'], ['assistant', 'Here is your answer.']])
    expect(messages.some((m) => m._error || m._partial), 'no cancelled or partial artifact').toBe(false)
    // The Agent answers the user with the background result in context.
    expect(JSON.stringify(histories.at(-1))).toContain('Background process')
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).active_turn_origin).toBeNull()
  })

  it('a message sent to a user turn still steers it, and starting during a background turn starts at once (TAL-460)', async () => {
    const sid = await newSession(s)
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      const done = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }])) }
      if (str(params.user_message).includes('Background process')) opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
      else release = done
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'task' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'token')
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).active_turn_origin).toBe('user')
    expect(await json(await post(s, '/api/chat/steer', { session_id: sid, text: 'prefer tests', steer_id: 'steer-u' }))).toEqual({ accepted: true, fallback: null, stream_id: start.stream_id, steer_id: 'steer-u' })
    release()
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    await s.deps.completions.processOne({ process_id: 'proc_bg2', session_id: 'proc_bg2', type: 'completion', command: 'backup', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
    for (let i = 0; i < 60 && !s.deps.sessionStore.get(sid).active_stream_id; i += 1) await new Promise((r) => setTimeout(r, 20))
    const background = str(s.deps.sessionStore.get(sid).active_stream_id)
    await s.sse(`/api/chat/stream?stream_id=${background}`, (f) => f.event === 'token')
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).active_turn_origin).toBe('background')
    expect(await json(await s.get(`/api/session/status?session_id=${sid}`))).toMatchObject({ active_turn_origin: 'background' })
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'new question' })
    expect(res.status).toBe(200)
    const next = await json(res)
    expect(next.stream_id).not.toBe(background)
    release()
    await s.sse(`/api/chat/stream?stream_id=${String(next.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.some((m) => m._error || m._partial)).toBe(false)
    expect(messages.at(-2)).toMatchObject({ role: 'user', content: 'new question' })
  })

  it('persists consumed steers at their causal place, in the settled scene, and out of model history (TAL-300)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let step: (() => void)[] = []
    let emitLive: ((frame: { event: string; data: Json }) => void) | null = null
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emitLive = emit
      const call = (id: string) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })
      step = [() => { resolve(completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: 'Reading a.', tool_calls: [call('ta')] }, { role: 'tool', tool_call_id: 'ta', content: 'A' },
        { role: 'assistant', content: 'Reading b.', tool_calls: [call('tb')] }, { role: 'tool', tool_call_id: 'tb', content: 'B' },
        { role: 'assistant', content: 'All read.' },
      ])); }]
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', args: {}, tid: 'ta' } })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'read files' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'tool')
    emitLive!({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', tid: 'ta', preview: 'A' } })
    await post(s, '/api/chat/steer', { session_id: sid, text: 'check b too', display_text: 'Check b too', steer_id: 'steer-a' })
    emitLive!({ event: 'steer_pending', data: { text: '' } })
    emitLive!({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', tid: 'tb', preview: 'B' } })
    await post(s, '/api/chat/steer', { session_id: sid, text: 'then stop', steer_id: 'steer-b' })
    emitLive!({ event: 'steer_pending', data: { text: '' } })
    const live = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'steer_consumed' && (f.data as Json).steer_id === 'steer-b')
    expect(live.filter((f) => f.event === 'steer_consumed').map((f) => [(f.data as Json).steer_id, (f.data as Json).after_tool_call_id])).toEqual([['steer-a', 'ta'], ['steer-b', 'tb']])
    // Saved as they enter the stream, before the turn settles: a mid-turn reload already has them.
    const midTurn = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect((midTurn.messages as Json[]).filter((m) => m._steer).map((m) => [m.content, m._turn_id, (m._steer as Json).steer_id])).toEqual([
      ['Check b too', streamId, 'steer-a'], ['then stop', streamId, 'steer-b'],
    ])
    step[0]!()
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    const done = frames.find((f) => f.event === 'done')?.data as Json
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    for (const messages of [(done.session as Json).messages as Json[], detail.messages as Json[]]) {
      expect(messages.map((m) => (m._steer ? `steer:${String((m._steer as Json).steer_id)}` : `${String(m.role)}:${String(m.content)}`))).toEqual([
        'user:read files', 'assistant:Reading a.', 'tool:A', 'steer:steer-a', 'assistant:Reading b.', 'tool:B', 'steer:steer-b', 'assistant:All read.',
      ])
      const steer = messages.find((m) => m._steer)!
      expect(steer).toMatchObject({ role: 'user', content: 'Check b too', _turn_id: streamId, _steer: { steer_id: 'steer-a', phase_duration: expect.any(Number) as unknown } })
      const scene = messages.at(-1)?._anchor_activity_scene as Json
      expect((scene.activity_rows as Json[]).map((r) => r.row_id)).toEqual(['i1:prose', 'tool:ta', 'steering:steer-a', 'i4:prose', 'tool:tb', 'steering:steer-b'].map((id) => (id.startsWith('i') ? expect.stringMatching(/:prose$/) as unknown : id)))
      expect(((scene.activity_rows as Json[])[2]?.steering as Json)).toMatchObject({ steer_id: 'steer-a', consumed: true, phase_duration: expect.any(Number) as unknown })
      expect(scene).toMatchObject({ final_answer: 'All read.', final_phase_duration: expect.any(Number) as unknown })
    }
    const stored = s.deps.sessionStore.get(sid)
    expect(sanitizeMessagesForApi(stored.messages).some((m) => m.content === 'Check b too' || m.content === 'then stop')).toBe(false)
    expect(stored.title).not.toContain('Check b too')
  })

  it('keeps a steer consumed before a Stop in the cancelled turn (TAL-300)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    sidecar.respond('chat.interrupt', () => ({ ok: true, pending_steer: '' }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'partial' } })
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'long job' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    await post(s, '/api/chat/steer', { session_id: sid, text: 'wrap up', steer_id: 'steer-c' })
    await s.get(`/api/chat/cancel?stream_id=${streamId}`)
    await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'cancel')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    const steerIndex = messages.findIndex((m) => m._steer)
    expect(steerIndex).toBe(1)
    expect(messages[steerIndex]).toMatchObject({ content: 'wrap up', _turn_id: streamId })
    const scene = messages.at(-1)?._anchor_activity_scene as Json
    expect((scene.activity_rows as Json[]).some((r) => r.role === 'steering' && (r.steering as Json).steer_id === 'steer-c')).toBe(true)
  })

  it('places a steer after the result it followed when one message made several calls (TAL-300)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let release: () => void = () => undefined
    let emitLive: ((frame: { event: string; data: Json }) => void) | null = null
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emitLive = emit
      const call = (id: string) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })
      release = () => { resolve(completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: '', tool_calls: [call('ta'), call('tb')] }, { role: 'tool', tool_call_id: 'ta', content: 'A' }, { role: 'tool', tool_call_id: 'tb', content: 'B' },
        { role: 'assistant', content: 'Done.' },
      ])) }
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', args: {}, tid: 'ta' } })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'read both' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'tool')
    emitLive!({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', tid: 'ta', preview: 'A' } })
    await post(s, '/api/chat/steer', { session_id: sid, text: 'skip b', steer_id: 'steer-m' })
    emitLive!({ event: 'steer_pending', data: { text: '' } })
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'steer_consumed')
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.map((m) => (m._steer ? 'steer' : m.role === 'tool' ? `tool:${String(m.content)}` : String(m.role)))).toEqual(['user', 'assistant', 'tool:A', 'steer', 'tool:B', 'assistant'])
  })

  it('places a steer after the Anthropic-style tool_use call it followed (TAL-300)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let release: () => void = () => undefined
    let emitLive: ((frame: { event: string; data: Json }) => void) | null = null
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emitLive = emit
      release = () => { resolve(completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading a.' }, { type: 'tool_use', id: 'ua', name: 'read_file', input: {} }] }, { role: 'tool', tool_use_id: 'ua', content: 'A' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'ub', name: 'read_file', input: {} }] }, { role: 'tool', tool_use_id: 'ub', content: 'B' },
        { role: 'assistant', content: 'Done.' },
      ])) }
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', args: {}, tid: 'ua' } })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'read' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'tool')
    emitLive!({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', tid: 'ua', preview: 'A' } })
    await post(s, '/api/chat/steer', { session_id: sid, text: 'check b', steer_id: 'steer-u' })
    emitLive!({ event: 'steer_pending', data: { text: '' } })
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'steer_consumed')
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.map((m) => (m._steer ? 'steer' : String(m.role)))).toEqual(['user', 'assistant', 'tool', 'steer', 'assistant', 'tool', 'assistant'])
  })

  it('makes the Agent\'s own record of a delivered steer the persisted steer, not a second copy (TAL-300)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let release: () => void = () => undefined
    let emitLive: ((frame: { event: string; data: Json }) => void) | null = null
    const oob = '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\nmention the weekday\n[/OUT-OF-BAND USER MESSAGE]'
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emitLive = emit
      const call = (id: string) => ({ id, type: 'function', function: { name: 'terminal', arguments: '{}' } })
      release = () => { resolve(completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: '', tool_calls: [call('t1')] }, { role: 'tool', tool_call_id: 't1', content: 'Thu' },
        { role: 'user', content: oob, display_kind: 'steer' },
        { role: 'assistant', content: '', tool_calls: [call('t2')] }, { role: 'tool', tool_call_id: 't2', content: 'up' },
        { role: 'assistant', content: 'On Thursday, all good.' },
      ])) }
      emit({ event: 'token', data: { text: '' } })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'date then uptime' }))
    const streamId = String(start.stream_id)
    await post(s, '/api/chat/steer', { session_id: sid, text: 'mention the weekday', display_text: 'Mention the weekday', steer_id: 'steer-w' })
    emitLive!({ event: 'steer_pending', data: { text: '' } })
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'steer_consumed')
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.map((m) => (m._steer ? `steer:${String((m._steer as Json).steer_id)}:${String(m.content)}` : String(m.role)))).toEqual([
      'user', 'assistant', 'tool', 'steer:steer-w:Mention the weekday', 'assistant', 'tool', 'assistant',
    ])
    const scene = messages.at(-1)?._anchor_activity_scene as Json
    expect((scene.activity_rows as Json[]).filter((r) => r.role === 'steering').map((r) => r.text)).toEqual(['Mention the weekday'])
  })

  it('sends a steer the Agent still held as one follow-up turn when the run returns an error (TAL-300, TAL-424)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    let release: () => void = () => undefined
    const prompts: string[] = []
    sidecar.respond('chat.start', (params, emit) => {
      prompts.push(str(params.user_message))
      if (prompts.length > 1) return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'follow-up done' }])
      return new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'partial' } })
        release = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }], { status: 'error', error: 'provider failed', pending_steer: 'not applied' })) }
      })
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'job' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    await post(s, '/api/chat/steer', { session_id: sid, text: 'not applied', steer_id: 'steer-held' })
    release()
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'apperror')
    expect(frames.some((f) => f.event === 'steer_consumed')).toBe(false)
    expect(frames.some((f) => f.event === 'pending_steer_leftover')).toBe(false)
    await vi.waitFor(() => { expect(prompts).toHaveLength(2) })
    expect(prompts[1]).toMatch(/\nnot applied$/)
    await vi.waitFor(() => { expect(s.deps.sessionStore.get(sid).active_stream_id).toBeNull() })
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.some((m) => m._steer)).toBe(false)
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['job', 'not applied'])
  })

  it('a Stop withdraws a queued steer with its text before the single cancel row, and starts nothing (TAL-424)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null }))
    // The sidecar drains the Agent's unapplied steer text on interrupt (Python `_finalize_webui_steers`).
    sidecar.respond('chat.interrupt', () => ({ ok: true, pending_steer: 'never applied\nalso held' }))
    let starts = 0
    sidecar.respond('chat.start', (params, _emit, opts) => new Promise((resolve) => {
      starts += 1
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'long task' }))
    const streamId = String(start.stream_id)
    expect((await json(await post(s, '/api/chat/steer', { session_id: sid, text: 'never applied', display_text: 'Never applied', steer_id: 'steer-x' }))).accepted).toBe(true)
    expect((await json(await post(s, '/api/chat/steer', { session_id: sid, text: 'also held', steer_id: 'steer-y' }))).accepted).toBe(true)
    const withdrawn = [{ steer_id: 'steer-x', reason: 'stopped', text: 'Never applied' }, { steer_id: 'steer-y', reason: 'stopped', text: 'also held' }]
    // TAL-426: the Stop's answer carries them too, for a client that stops reading the stream once it answers.
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).toEqual({ ok: true, cancelled: true, stream_id: streamId, withdrawn_steers: withdrawn })
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel')
    const names = frames.map((f) => f.event)
    expect(names.lastIndexOf('steer_withdrawn')).toBeLessThan(names.indexOf('cancel'))
    expect(frames.filter((f) => f.event === 'steer_withdrawn').map((f) => f.data)).toEqual(withdrawn)
    // Until TAL-425 / TAL-426 read `steer_withdrawn`, today's clients still get the leftovers they requeue.
    expect(frames.filter((f) => f.event === 'pending_steer_leftover').map((f) => (f.data as Json).steer_id)).toEqual(['steer-x', 'steer-y'])
    expect(names.lastIndexOf('pending_steer_leftover')).toBeLessThan(names.indexOf('cancel'))
    expect(starts).toBe(1)
    // The worker's unwind adds nothing after the terminal row: replay from the start still ends on that one cancel.
    await new Promise((r) => setTimeout(r, 100))
    const replay = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, () => false, { timeoutMs: 300 })
    expect(replay.filter((f) => f.event === 'cancel')).toHaveLength(1)
    expect(replay.filter((f) => f.event === 'steer_withdrawn')).toHaveLength(2)
    expect(starts).toBe(1)
  })

  describe('server-owned pending steers (TAL-424)', () => {
    const detailSteers = async (sid: string): Promise<Json[]> => (((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).pending_steers as Json[] | undefined) ?? []
    const running = async (sid: string, finish: Json[] = []) => {
      let emitLive!: (frame: { event: string; data: Json }) => void
      let release: (extra?: Partial<ChatResult>) => void = () => undefined
      sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null, can_redirect: true }))
      sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
        emitLive = emit
        emit({ event: 'token', data: { text: 'working' } })
        release = (extra = {}) => { resolve(completed([{ role: 'user', content: str(params.user_message) }, ...finish, { role: 'assistant', content: 'done' }], extra)) }
      }))
      const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'task' }))).stream_id)
      await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
      return { streamId, emit: (event: string, data: Json) => { emitLive({ event, data }) }, release: (extra?: Partial<ChatResult>) => { release(extra) } }
    }
    const frames = (streamId: string, until: (f: SseFrame) => boolean) => s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, until)

    it('shows a pending steer to every client in the stream and the session, until the Agent takes it', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      await post(s, '/api/chat/steer', { session_id: sid, text: 'check b', display_text: 'Check b', steer_id: 'steer-p1' })
      const pending = { steer_id: 'steer-p1', text: 'Check b', state: 'pending', actions: { edit: true, cancel: true, send_now: true } }
      expect((await frames(run.streamId, (f) => f.event === 'steer_pending')).find((f) => f.event === 'steer_pending')?.data).toMatchObject(pending)
      expect(await detailSteers(sid)).toMatchObject([pending])
      // Same shape as the shared contract example every client is tested against.
      const example = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { pending_steers_session: { pending_steers: Json[] } }).pending_steers_session.pending_steers[0]!
      expect(Object.keys((await detailSteers(sid))[0]!).sort()).toEqual(Object.keys(example).sort())
      run.emit('steer_pending', { text: '' })
      run.emit('token', { text: ' more' })
      await frames(run.streamId, (f) => f.event === 'steer_consumed')
      expect(await detailSteers(sid)).toEqual([])
      run.release()
      await frames(run.streamId, (f) => f.event === 'stream_end')
    })

    it('withdraws a pending steer for Edit or Cancel with its text, keeping the others in order', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      const calls: Json[] = []
      sidecar.respond('chat.steer_withdraw', (params) => { calls.push(params); return { withdrawn: true } })
      await post(s, '/api/chat/steer', { session_id: sid, text: 'first', display_text: 'First', steer_id: 'steer-w1' })
      await post(s, '/api/chat/steer', { session_id: sid, text: 'second', steer_id: 'steer-w2' })
      expect(await json(await post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'steer-w1', reason: 'edit' }))).toEqual({ withdrawn: true, text: 'First' })
      expect(calls).toEqual([{ stream_id: run.streamId, pending: ['first', 'second'], index: 0 }])
      const withdrawn = (await frames(run.streamId, (f) => f.event === 'steer_withdrawn')).find((f) => f.event === 'steer_withdrawn')
      expect(withdrawn?.data).toEqual({ steer_id: 'steer-w1', reason: 'edit', text: 'First' })
      expect((await detailSteers(sid)).map((p) => p.steer_id)).toEqual(['steer-w2'])
      // Already withdrawn, or never known: never a silent success.
      expect(await json(await post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'steer-w1', reason: 'cancel' }))).toEqual({ withdrawn: false })
      expect(await json(await post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'nope', reason: 'cancel' }))).toEqual({ withdrawn: false })
      expect((await post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'steer-w2', reason: 'later' })).status).toBe(400)
      // The remaining steer is still delivered.
      run.emit('steer_pending', { text: '' })
      run.emit('token', { text: ' more' })
      const consumed = await frames(run.streamId, (f) => f.event === 'steer_consumed')
      expect(consumed.filter((f) => f.event === 'steer_consumed').map((f) => (f.data as Json).steer_id)).toEqual(['steer-w2'])
      run.release()
      await frames(run.streamId, (f) => f.event === 'stream_end')
    })

    it('reports a steer the Agent already took as not withdrawn, and settles it as consumed', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      sidecar.respond('chat.steer_withdraw', () => ({ withdrawn: false }))
      await post(s, '/api/chat/steer', { session_id: sid, text: 'taken', steer_id: 'steer-r1' })
      expect(await json(await post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'steer-r1', reason: 'cancel' }))).toEqual({ withdrawn: false })
      expect((await detailSteers(sid)).map((p) => p.steer_id)).toEqual(['steer-r1'])
      run.emit('steer_pending', { text: '' })
      run.emit('token', { text: ' more' })
      const after = await frames(run.streamId, (f) => f.event === 'steer_consumed')
      expect(after.some((f) => f.event === 'steer_withdrawn')).toBe(false)
      run.release()
      await frames(run.streamId, (f) => f.event === 'stream_end')
    })

    it('sends a pending steer now: a redirect lands it as the turn\'s own steer row, once', async () => {
      const sid = await newSession(s)
      // The Agent records a redirect as a plain user row in the turn.
      const run = await running(sid, [{ role: 'assistant', content: '' , display_kind: 'hidden' }, { role: 'user', content: 'go now' }])
      const calls: Json[] = []
      sidecar.respond('chat.steer_now', (params) => { calls.push(params); return { redirected: true, withdrawn: true, delivery: 'redirect' } })
      await post(s, '/api/chat/steer', { session_id: sid, text: 'go now', display_text: 'Go now', steer_id: 'steer-n1' })
      expect(await json(await post(s, '/api/chat/steer/send-now', { session_id: sid, steer_id: 'steer-n1' }))).toEqual({ redirected: true })
      expect(calls).toEqual([{ stream_id: run.streamId, pending: ['go now'], index: 0 }])
      expect((await frames(run.streamId, (f) => f.event === 'steer_consumed')).find((f) => f.event === 'steer_consumed')?.data).toMatchObject({ steer_id: 'steer-n1', text: 'Go now' })
      expect(await detailSteers(sid)).toEqual([])
      run.release()
      await frames(run.streamId, (f) => f.event === 'stream_end')
      const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
      const rows = messages.filter((m) => m.role === 'user' && ['go now', 'Go now'].includes(str(m.content)))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ content: 'Go now', _steer: { steer_id: 'steer-n1' } })
    })

    it('a Send now during tools keeps the steer pending, last and sending; with nothing live it stays as it was', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      await post(s, '/api/chat/steer', { session_id: sid, text: 'one', steer_id: 'steer-t1' })
      await post(s, '/api/chat/steer', { session_id: sid, text: 'two', steer_id: 'steer-t2' })
      sidecar.respond('chat.steer_now', () => ({ redirected: false, withdrawn: true, requeued: 'kept' }))
      expect(await json(await post(s, '/api/chat/steer/send-now', { session_id: sid, steer_id: 'steer-t1' }))).toEqual({ redirected: false })
      expect((await detailSteers(sid)).map((p) => [p.steer_id, p.state])).toEqual([['steer-t1', 'pending'], ['steer-t2', 'pending']])
      // The Agent's queue changed meanwhile: it went back last, and clients follow the new order.
      sidecar.respond('chat.steer_now', () => ({ redirected: false, withdrawn: true, requeued: 'last' }))
      expect(await json(await post(s, '/api/chat/steer/send-now', { session_id: sid, steer_id: 'steer-t1' }))).toEqual({ redirected: false })
      expect((await detailSteers(sid)).map((p) => p.steer_id)).toEqual(['steer-t2', 'steer-t1'])
      sidecar.respond('chat.steer_now', () => ({ redirected: true, withdrawn: true, delivery: 'steer' }))
      expect(await json(await post(s, '/api/chat/steer/send-now', { session_id: sid, steer_id: 'steer-t1' }))).toEqual({ redirected: true })
      expect(await detailSteers(sid)).toMatchObject([
        { steer_id: 'steer-t2', state: 'pending' },
        { steer_id: 'steer-t1', state: 'sending_now', actions: { edit: false, cancel: false, send_now: false } },
      ])
      const sending = (await frames(run.streamId, (f) => f.event === 'steer_pending' && (f.data as Json).state === 'sending_now')).findLast((f) => f.event === 'steer_pending')
      expect(sending?.data).toMatchObject({ steer_id: 'steer-t1', state: 'sending_now' })
      // An unknown id is not sent.
      expect(await json(await post(s, '/api/chat/steer/send-now', { session_id: sid, steer_id: 'nope' }))).toEqual({ redirected: false })
      run.release({ pending_steer: '' })
      await frames(run.streamId, (f) => f.event === 'stream_end')
    })

    it('does not misread the Agent\'s pending text while a withdraw rewrites its queue', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      await post(s, '/api/chat/steer', { session_id: sid, text: 'aa', steer_id: 'steer-d1' })
      await post(s, '/api/chat/steer', { session_id: sid, text: 'bb', steer_id: 'steer-d2' })
      // Mid-rewrite the Agent reports its queue without the steer being withdrawn: read against the old list, that
      // would wrongly mark it consumed.
      sidecar.respond('chat.steer_withdraw', () => { run.emit('steer_pending', { text: 'bb' }); run.emit('token', { text: ' x' }); return { withdrawn: true } })
      expect(await json(await post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'steer-d1', reason: 'cancel' }))).toEqual({ withdrawn: true, text: 'aa' })
      expect((await detailSteers(sid)).map((p) => p.steer_id)).toEqual(['steer-d2'])
      const seen = await frames(run.streamId, (f) => f.event === 'steer_withdrawn')
      expect(seen.some((f) => f.event === 'steer_consumed')).toBe(false)
      run.release({ pending_steer: '' })
      await frames(run.streamId, (f) => f.event === 'stream_end')
    })

    it('finishes a withdraw that is in flight before the turn ends, so the steer is neither sent nor recorded', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      let reply: (v: { withdrawn: boolean }) => void = () => undefined
      let asked: () => void = () => undefined
      const inFlight = new Promise<void>((resolve) => { asked = resolve })
      sidecar.respond('chat.steer_withdraw', () => new Promise((resolve) => { reply = resolve; asked() }))
      await post(s, '/api/chat/steer', { session_id: sid, text: 'drop me', steer_id: 'steer-x1' })
      const withdraw = post(s, '/api/chat/steer/withdraw', { session_id: sid, steer_id: 'steer-x1', reason: 'cancel' })
      await inFlight
      // The Agent's queue no longer holds it when the turn ends; the server must not call that a consumed steer.
      run.release({ pending_steer: '' })
      reply({ withdrawn: true })
      expect(await json(await withdraw)).toEqual({ withdrawn: true, text: 'drop me' })
      const all = await frames(run.streamId, (f) => f.event === 'stream_end')
      expect(all.filter((f) => f.event === 'steer_consumed')).toEqual([])
      expect(all.filter((f) => f.event === 'steer_withdrawn').map((f) => (f.data as Json).reason)).toEqual(['cancel'])
      const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
      expect(messages.some((m) => m._steer)).toBe(false)
    })

    it('offers no Send now when the Agent cannot redirect', async () => {
      const sid = await newSession(s)
      const run = await running(sid)
      sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null, can_redirect: false }))
      await post(s, '/api/chat/steer', { session_id: sid, text: 'plain', steer_id: 'steer-c1' })
      expect(await detailSteers(sid)).toMatchObject([{ steer_id: 'steer-c1', actions: { edit: true, cancel: true, send_now: false } }])
      expect(await json(await post(s, '/api/chat/steer/send-now', { session_id: sid, steer_id: 'steer-c1' }))).toEqual({ redirected: false })
      run.release({ pending_steer: '' })
      await frames(run.streamId, (f) => f.event === 'stream_end')
    })
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
    // The failure cleanup runs after the error writeback, so the hidden session does not get re-saved into the sidebar.
    expect(existsSync(s.deps.sessionStore.pathFor(String(failed.session_id)))).toBe(false)
    expect((await json(await s.get('/api/sessions'))).sessions as Json[]).not.toContainEqual(expect.objectContaining({ session_id: failed.session_id }))
    // An Agent-reported error (no throw) completes and cleans up the same way.
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }], { status: 'error', error: 'model refused', final_response: '', token_sent: false }))
    const inBand = await json(await post(s, '/api/background', { session_id: sid, prompt: 'doomed too' }))
    await s.sse(`/api/chat/stream?stream_id=${String(inBand.stream_id)}&replay=1`, (f) => f.event === 'apperror')
    await new Promise((r) => setTimeout(r, 50))
    expect((await json(await s.get(`/api/background/status?session_id=${sid}`))).results).toEqual([{ task_id: inBand.task_id, prompt: 'doomed too', answer: '(background task failed)', completed_at: expect.any(Number) as number }])
    expect(existsSync(s.deps.sessionStore.pathFor(String(inBand.session_id)))).toBe(false)
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

  it('keeps every piece of background work as one durable record that every client reads (TAL-372)', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'answer to it' }]))
    const bg = await json(await post(s, '/api/background', { session_id: sid, prompt: 'summarize repo\nin detail' }))
    await s.sse(`/api/chat/stream?stream_id=${String(bg.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    await new Promise((r) => setTimeout(r, 50))
    // The Agent's view: two concurrent delegations (one stalled), the two units of one split call, and a notified process.
    const unit = (id: string, goals: string[], extra: Json = {}): Json => ({ delegation_id: id, origin_ui_session_id: sid, state: 'running', dispatched_at: 10, completed_at: null, updated_at: 11, goals, child_statuses: [], has_result: false, live_status: 'running', ...extra })
    let agent: Json = {
      delegations: [unit('d-a', ['Check logs']), unit('d-b', ['Fix CI'], { live_status: 'stalled' }), unit('call-1-1', ['Write docs']), unit('call-1-2', ['Write tests', 'Run tests']),
        // Still `running` in the ledger, but gone from the live registry: lost in an Agent restart.
        unit('d-lost', ['Lost one'], { live_status: null })],
      processes: [{ process_id: 'proc_1', session_key: sid, command: 'make test', started_at: 12, exited: false, exited_at: null, exit_code: null, completion_reason: '', watched: false }],
    }
    sidecar.respond('process.background_list', (params) => { expect(params.session_ids).toEqual([sid]); return agent as never })
    const read = async (): Promise<Json> => json(await s.get(`/api/background/tasks?session_id=${sid}`))
    const tasks = async (): Promise<Record<string, Json>> => Object.fromEntries(((await read()).tasks as Json[]).map((t) => [str(t.task_id), t]))
    const first = await read()
    expect(first.agent_available).toBe(true)
    // TAL-373: the side panel opens on Agents while a delegation runs or needs attention; the server says so.
    expect(first.agents_working).toBe(true)
    let byId = await tasks()
    expect(Object.keys(byId).sort()).toEqual([String(bg.task_id), 'call-1-1', 'call-1-2', 'd-a', 'd-b', 'd-lost', 'proc_1'].sort())
    expect(byId['d-lost']).toMatchObject({ status: 'unknown', pinned: true, dismissible: true, active: true })
    expect(byId['d-a']).toMatchObject({ status: 'running', active: true, dismissible: false })
    expect(byId[String(bg.task_id)]).toMatchObject({ kind: 'background_command', status: 'completed', title: 'summarize repo', result_available: true, pinned: true, dismissible: true, active: false })
    expect(byId['d-b']).toMatchObject({ kind: 'delegation', status: 'attention', title: 'Fix CI', pinned: true })
    expect(byId['call-1-2']).toMatchObject({ title: '2 subagents: Write tests; Run tests', agents: { total: 2, completed: 0, failed: 0, running: 2 } })
    expect(byId.proc_1).toMatchObject({ kind: 'process', status: 'running', title: 'make test', pinned: true })
    // TAL-373: the Agents page asks for delegations only; the server narrows the same records, in the same order.
    const agents = (await json(await s.get(`/api/background/tasks?session_id=${sid}&kind=delegation`))).tasks as Json[]
    expect(agents.map((t) => t.task_id)).toEqual(((await read()).tasks as Json[]).filter((t) => t.kind === 'delegation').map((t) => t.task_id))
    expect(new Set(agents.map((t) => t.kind))).toEqual(new Set(['delegation']))
    expect((await s.get(`/api/background/tasks?session_id=${sid}&kind=nope`)).status).toBe(400)

    // Reading never consumes: an old client's status read, then another client, still see the result.
    expect((await json(await s.get(`/api/background/status?session_id=${sid}`))).results).toEqual([expect.objectContaining({ task_id: bg.task_id, answer: 'answer to it' })])
    expect((await tasks())[String(bg.task_id)]).toMatchObject({ status: 'completed', result_available: true })
    expect(await json(await s.get(`/api/background/result?session_id=${sid}&task_id=${String(bg.task_id)}`))).toEqual({ task_id: bg.task_id, text: 'answer to it' })

    // Completions settle each record once; a later report saying otherwise changes nothing.
    sidecar.respond('process.format_notification', () => ({ text: '[IMPORTANT: delegation d-a finished]\nall fine' }))
    sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
    await s.deps.completions.processOne({ process_id: 'd-a', delegation_id: 'd-a', type: 'async_delegation', origin_ui_session_id: sid, status: 'completed', goal: 'Check logs', consumed: false })
    await s.deps.completions.processOne({ process_id: 'proc_1', session_id: 'proc_1', type: 'completion', command: 'make test', exit_code: 2, output: 'boom', origin_ui_session_id: sid, consumed: false })
    agent = { ...agent, delegations: [unit('d-a', ['Check logs'], { state: 'error', child_statuses: ['error'], has_result: true }), ...(agent.delegations as Json[]).slice(1)], processes: [] }
    byId = await tasks()
    expect(byId['d-a']).toMatchObject({ status: 'completed', result_available: true, pinned: false })
    expect(byId.proc_1).toMatchObject({ status: 'failed', exit_code: 2, result_available: true })
    expect(Object.keys(byId)).toHaveLength(7)
    expect(str((await json(await s.get(`/api/background/result?session_id=${sid}&task_id=d-a`))).text)).toContain('all fine')

    // Dismissing is read state: the finished `/background` task leaves the tray and stays in the history.
    expect((await json(await post(s, '/api/background/dismiss', { session_id: sid, task_id: bg.task_id }))).task).toMatchObject({ status: 'completed', pinned: false, dismissible: false })
    expect((await tasks())[String(bg.task_id)]).toMatchObject({ status: 'completed', pinned: false })

    // The Agent cannot be asked: its running work shows unknown, settled records stay as they are.
    sidecar.respond('process.background_list', () => { throw new SidecarError('agent down', { condition: 'sidecar_error' }) })
    const offline = await read()
    expect(offline.agent_available).toBe(false)
    expect(offline.agents_working).toBe(false)
    expect(Object.fromEntries((offline.tasks as Json[]).map((t) => [str(t.task_id), t.status]))).toMatchObject({ 'd-a': 'completed', 'd-b': 'unknown', 'call-1-1': 'unknown', proc_1: 'failed', [String(bg.task_id)]: 'completed' })
    // Unknown work stays active, so clients keep refreshing until the Agent answers again.
    expect((offline.tasks as Json[]).find((t) => t.task_id === 'd-b')).toMatchObject({ active: true, dismissible: true })
    expect((await s.get('/api/background/tasks?session_id=nope')).status).toBe(404)
    // Deleting the session removes its background records with it.
    const records = join(s.deps.sessionStore.sessionDir, '_background', `${sid}.json`)
    expect(existsSync(records)).toBe(true)
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
    expect(existsSync(records)).toBe(false)
    expect(s.deps.background.receipts(sid)).toEqual([])
  })

  it('shows the work a delegation row started on that row, updated in place (TAL-372)', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [
      { role: 'user', content: 'split it up', timestamp: 100 },
      { role: 'assistant', content: '', timestamp: 101, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'delegate_task', arguments: '{"tasks":[]}' } }] },
      { role: 'tool', tool_call_id: 'call_x', timestamp: 102, content: JSON.stringify({ status: 'dispatched', mode: 'background', count: 3, delegation_id: 'call-1', goals: ['Write docs', 'Write tests', 'Run tests'] }) },
      { role: 'assistant', content: 'Started three subagents.', timestamp: 103 },
    ]
    s.deps.sessionStore.save(session)
    const unit = (id: string, goals: string[], extra: Json = {}): Json => ({ delegation_id: id, origin_ui_session_id: sid, state: 'running', dispatched_at: 101, completed_at: null, updated_at: 101, goals, child_statuses: [], has_result: false, live_status: 'running', ...extra })
    let delegations = [unit('call-1-1', ['Write docs']), unit('call-1-2', ['Write tests', 'Run tests'])]
    sidecar.respond('process.background_list', () => ({ delegations, processes: [] }) as never)
    const link = async (): Promise<unknown> => {
      await json(await s.get(`/api/background/tasks?session_id=${sid}`))
      const detail = await json(await s.get(`/api/session?session_id=${sid}`))
      const rows = ((detail.session as Json).messages as Json[]).flatMap((m) => ((m._anchor_activity_scene as Json | undefined)?.activity_rows as Json[] | undefined) ?? [])
      return (rows.find((r) => (r.tool as Json | undefined)?.name === 'delegate_task')?.tool as Json | undefined)?.background
    }
    expect(await link()).toEqual({ task_ids: ['call-1-1', 'call-1-2'], status: 'running', agents: { total: 3, completed: 0, failed: 0, running: 3 } })
    // TAL-494: the sidecar names each unit's subagent sessions; the record links each one to its read-only transcript.
    delegations = [unit('call-1-1', ['Write docs'], { children: [{ goal: 'Write docs', session_id: 'child-docs' }] }), unit('call-1-2', ['Write tests', 'Run tests'])]
    const linked = ((await json(await s.get(`/api/background/tasks?session_id=${sid}&kind=delegation`))).tasks as Json[]).map((t) => [t.task_id, t.child_sessions])
    expect(linked).toEqual(expect.arrayContaining([['call-1-1', [{ goal: 'Write docs', session_id: 'child-docs' }]], ['call-1-2', []]]))
    // The Agent cannot be asked: the running unit's row says unknown, like the card.
    sidecar.respond('process.background_list', () => { throw new SidecarError('agent down', { condition: 'sidecar_error' }) })
    expect(await link()).toMatchObject({ status: 'unknown' })
    sidecar.respond('process.background_list', () => ({ delegations, processes: [] }) as never)
    expect(await link()).toMatchObject({ status: 'running' })
    // An Agent restart lost one unit: the row says what the card says.
    delegations = [unit('call-1-1', ['Write docs'], { state: 'completed', child_statuses: ['completed'] }), unit('call-1-2', ['Write tests', 'Run tests'], { live_status: null })]
    expect(await link()).toMatchObject({ status: 'unknown' })
    expect(((await json(await s.get(`/api/background/tasks?session_id=${sid}`))).tasks as Json[]).find((t) => t.task_id === 'call-1-2')).toMatchObject({ status: 'unknown' })
    delegations = [unit('call-1-1', ['Write docs'], { state: 'completed', child_statuses: ['completed'] }), unit('call-1-2', ['Write tests', 'Run tests'], { state: 'completed', child_statuses: ['completed', 'error'] })]
    expect(await link()).toEqual({ task_ids: ['call-1-1', 'call-1-2'], status: 'completed', agents: { total: 3, completed: 2, failed: 1, running: 0 } })
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

  it('exposes a questions-only clarify batch as ordered steps and relays keyed answers as the Agent envelope (TAL-362)', async () => {
    const sid = await newSession(s)
    const relayed: string[] = []
    let release: () => void = () => undefined
    sidecar.respond('clarify.respond', (params) => { relayed.push(params.response); release(); return { ok: true, clarify_id: String(params.clarify_id) } })
    sidecar.respond('chat.start', async (params, emit) => {
      // The Agent's batch callback frame: no top-level question, the questions already Agent-normalized.
      emit({ event: 'clarify', data: { clarify_id: 'batch-1', question: '', choices_offered: [], session_id: sid, questions: [
        { qid: 'q0', id: null, question: 'What sounds best for a quiet evening?', choices: ['A book (Recommended)', 'A movie'], choices_offered: ['A book', 'A movie'], multi_select: false },
        { qid: 'q1', id: 'snacks', question: 'Which snacks?', choices: ['Popcorn (Recommended)', 'Tea', 'Chips'], choices_offered: ['Popcorn', 'Tea', 'Chips'], multi_select: true },
      ] } })
      await new Promise<void>((resolve) => { release = resolve })
      emit({ event: 'clarify', data: { clarify_id: 'single-1', question: 'Which env?', choices_offered: ['dev', 'prod'], session_id: sid } })
      await new Promise<void>((resolve) => { release = resolve })
      emit({ event: 'clarify', data: { clarify_id: 'batch-6', question: '', choices_offered: [], session_id: sid, questions: Array.from({ length: 6 }, (_, i) => ({ qid: `q${String(i)}`, question: `Question ${String(i)}?`, choices: null, choices_offered: null, multi_select: false })) } })
      await new Promise<void>((resolve) => { release = resolve })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'ok' }])
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'plan my evening' }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'clarify')
    const initial = await s.sse(`/api/clarify/stream?session_id=${sid}`, (f) => f.event === 'initial')
    const pending = (initial[initial.length - 1]?.data as Json).pending as Json
    expect(pending.steps).toEqual([
      { qid: 'q0', question: 'What sounds best for a quiet evening?', choices: ['A book (Recommended)', 'A movie'], multi_select: false },
      { qid: 'q1', question: 'Which snacks?', choices: ['Popcorn (Recommended)', 'Tea', 'Chips'], multi_select: true },
    ])
    // Every step needs an answer and only known question ids are accepted; nothing reaches the Agent otherwise.
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'batch-1', answers: { q0: 'A movie' } })).status).toBe(400)
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'batch-1', answers: { q0: 'A movie', q1: ['Tea'], q9: 'x' } })).status).toBe(400)
    expect(relayed).toEqual([])
    const res = await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'batch-1', answers: { q0: 'A movie', q1: ['Popcorn (Recommended)', 'Tea'] } })
    expect(res.status).toBe(200)
    expect(JSON.parse(relayed[0] ?? '')).toEqual({ answers: { q0: 'A movie', q1: ['Popcorn (Recommended)', 'Tea'] } })

    // A single-question prompt is one step and its keyed answer reaches the Agent as plain text.
    const single = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'clarify' && (f.data as Json).clarify_id === 'single-1')
    expect((single[single.length - 1]?.data as Json).steps).toEqual([{ qid: 'q0', question: 'Which env?', choices: ['dev', 'prod'], multi_select: false }])
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'single-1', answers: { q0: 'prod' } })).status).toBe(200)
    expect(relayed[1]).toBe('prod')

    // A batch longer than today's Agent limit stays a batch: every question is a step and the reply is the envelope.
    const six = Array.from({ length: 6 }, (_, i) => ({ qid: `q${String(i)}`, question: `Question ${String(i)}?`, choices: null, choices_offered: null, multi_select: false }))
    const long = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'clarify' && (f.data as Json).clarify_id === 'batch-6')
    expect(((long[long.length - 1]?.data as Json).steps as Json[]).map((step) => step.question)).toEqual(six.map((q) => q.question))
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'batch-6', answers: Object.fromEntries(six.map((q) => [q.qid, 'yes'])) })).status).toBe(200)
    expect(JSON.parse(relayed[2] ?? '')).toEqual({ answers: Object.fromEntries(six.map((q) => [q.qid, 'yes'])) })
    await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
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
      const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel')
      // Exactly one terminal row: the cancel route wrote it, the worker's "before start" unwind adds no second one.
      await new Promise((r) => setTimeout(r, 50))
      const replay = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, () => false, { timeoutMs: 300 })
      expect([...frames, ...replay].filter((f) => f.event === 'cancel').map((f) => (f.data as Json).type)).toEqual(['cancelled', 'cancelled'])
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
      emit({ event: 'clarify', data: { clarify_id: 'succ-c1', question: 'A?', session_id: sid } })
      emit({ event: 'clarify', data: { clarify_id: 'succ-c2', question: 'B?', session_id: sid } })
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
    // ...and the successor's live emitter survived too: resolving the clarify head re-emits the next head on its stream.
    sidecar.respond('clarify.respond', (params) => ({ ok: true, clarify_id: String(params.clarify_id) }))
    const seen = await s.sse(`/api/chat/stream?stream_id=${String(second.stream_id)}&after_event_id=${String(second.stream_id)}:0`, (f) => f.event === 'clarify' && (f.data as Json).pending_count === 2)
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'succ-c1', response: 'a' })).status).toBe(200)
    const promoted = await s.sse(`/api/chat/stream?stream_id=${String(second.stream_id)}&after_event_id=${String(second.stream_id)}:${String(seen.length)}`, (f) => f.event === 'clarify')
    expect(promoted.filter((f) => f.event === 'clarify').map((f) => f.data)).toMatchObject([{ clarify_id: 'succ-c2', pending_count: 1 }])
    expect((await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'succ-c2', response: 'b' })).status).toBe(200)
    releaseSecond()
    await s.sse(`/api/chat/stream?stream_id=${String(second.stream_id)}&after_event_id=${String(second.stream_id)}:0`, (f) => f.event === 'stream_end')
    sidecar.respond('aux.complete', () => { throw new SidecarError('no aux model', { condition: 'aux_unconfigured' }) })
  })

  it('keeps a prompt queued until the sidecar acknowledges the answer', async () => {
    const sid = await newSession(s)
    let release: () => void = () => undefined
    sidecar.respond('chat.start', async (params, emit) => {
      emit({ event: 'approval', data: { request_id: 'ack-1', command: 'rm -rf build', session_id: sid } })
      emit({ event: 'clarify', data: { clarify_id: 'ack-c1', question: 'Sure?', session_id: sid } })
      await new Promise<void>((resolve) => { release = resolve })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }])
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'clean' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'clarify')
    // The relay fails: the card must stay answerable rather than vanish while the Agent is still blocked on it.
    sidecar.respond('approval.respond', () => { throw new SidecarError('sidecar busy', { condition: 'sidecar_unavailable' }) })
    sidecar.respond('clarify.respond', () => { throw new SidecarError('sidecar busy', { condition: 'sidecar_unavailable' }) })
    let res = await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'ack-1' })
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ ok: false, choice: 'once' })
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending_count).toBe(1)
    res = await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'ack-c1', response: 'yes' })
    expect(res.status).toBe(503)
    expect((await json(await s.get(`/api/clarify/pending?session_id=${sid}`))).pending_count).toBe(1)
    // A rejected (not thrown) approval answer keeps the mirror as well.
    sidecar.respond('approval.respond', () => ({ ok: false, resolved: 0, choice: 'once' }))
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'ack-1' }))).toEqual({ ok: false, choice: 'once' })
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending_count).toBe(1)
    // Once the sidecar acknowledges, the prompts are removed.
    sidecar.respond('approval.respond', (params) => ({ ok: true, resolved: 1, choice: params.choice }))
    sidecar.respond('clarify.respond', (params) => ({ ok: true, clarify_id: String(params.clarify_id) }))
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'ack-1' }))).toEqual({ ok: true, choice: 'once' })
    expect((await json(await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: 'ack-c1', response: 'yes' }))).ok).toBe(true)
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending_count).toBe(0)
    expect((await json(await s.get(`/api/clarify/pending?session_id=${sid}`))).pending_count).toBe(0)
    release()
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&after_event_id=${String(start.stream_id)}:0`, (f) => f.event === 'stream_end')
  })

  it('withdraws an approval the Agent timed out and shows the one queued behind it (TAL-514)', async () => {
    const sid = await newSession(s)
    let release: () => void = () => undefined
    let emitFrame: (frame: { event: string; data: Json }) => void = () => undefined
    sidecar.respond('chat.start', async (params, emit) => {
      emitFrame = emit
      emit({ event: 'approval', data: { request_id: 'to-1', command: 'rm -rf build', session_id: sid } })
      emit({ event: 'approval', data: { request_id: 'to-2', command: 'rm -rf dist', session_id: sid } })
      await new Promise<void>((resolve) => { release = resolve })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }])
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'clean' }))
    const streamId = String(start.stream_id)
    const queued = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'approval' && (f.data as Json).pending_count === 2)
    const head = (data: Json): unknown => (data.pending as Json | null)?.approval_id ?? null
    const settled = (approvalId: string | null, count: number) => (f: SseFrame): boolean => f.event === 'approval' && head(f.data as Json) === approvalId && (f.data as Json).pending_count === count
    // The Agent's approvals.timeout expires on the head: the approval stream, GET pending, and the chat card all move on.
    const timedOut = s.sse(`/api/approval/stream?session_id=${sid}`, settled('to-2', 1))
    await new Promise((r) => setTimeout(r, 50))
    emitFrame({ event: 'approval_resolved', data: { approval_id: 'to-1', session_id: sid, reason: 'timeout' } })
    expect((await timedOut).filter((f) => f.event === 'approval').map((f) => f.data)).toMatchObject([{ pending: { approval_id: 'to-2' }, pending_count: 1 }])
    expect(await json(await s.get(`/api/approval/pending?session_id=${sid}`))).toMatchObject({ pending: { approval_id: 'to-2' }, pending_count: 1 })
    const promoted = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:${String(queued.length)}`, (f) => f.event === 'approval')
    expect(promoted.filter((f) => f.event === 'approval').map((f) => f.data)).toMatchObject([{ approval_id: 'to-2', pending_count: 1 }])
    // The second approval is answerable; the Agent's settle frame for it clears the chat card.
    const watcher = s.sse(`/api/approval/stream?session_id=${sid}`, settled('to-3', 1))
    await new Promise((r) => setTimeout(r, 50))
    sidecar.respond('approval.respond', (params) => ({ ok: params.request_id === 'to-2', resolved: params.request_id === 'to-2' ? 1 : 0, choice: params.choice }))
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'to-2' }))).toEqual({ ok: true, choice: 'once' })
    emitFrame({ event: 'approval_resolved', data: { approval_id: 'to-2', session_id: sid, reason: 'resolved' } })
    const cleared = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:${String(queued.length + promoted.length)}`, (f) => f.event === 'approval_cleared')
    expect(cleared.filter((f) => f.event.startsWith('approval')).map((f) => [f.event, f.data])).toEqual([['approval_cleared', { session_id: sid, pending_count: 0 }]])
    // An approval stream that watched the queue empty still hears the next prompt.
    emitFrame({ event: 'approval', data: { request_id: 'to-3', command: 'rm -rf out', session_id: sid } })
    expect((await watcher).filter((f) => f.event === 'approval').map((f) => f.data)).toMatchObject([{ pending: null, pending_count: 0 }, { pending: { approval_id: 'to-3' }, pending_count: 1 }])
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
  })

  it('drops approvals the Agent no longer holds when it rejects an answer (TAL-514)', async () => {
    const sid = await newSession(s)
    let release: () => void = () => undefined
    let emitFrame: (frame: { event: string; data: Json }) => void = () => undefined
    sidecar.respond('chat.start', async (params, emit) => {
      emitFrame = emit
      emit({ event: 'approval', data: { request_id: 'dead-1', command: 'rm -rf build', session_id: sid } })
      emit({ event: 'approval', data: { request_id: 'live-2', command: 'rm -rf dist', session_id: sid } })
      await new Promise<void>((resolve) => { release = resolve })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }])
    })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'clean' }))
    const streamId = String(start.stream_id)
    const queued = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'approval' && (f.data as Json).pending_count === 2)
    // The Agent stopped waiting on dead-1 without the server hearing; it still holds live-2. live-3 parks while the
    // snapshot is in flight, so the snapshot cannot list it and it must survive the reconcile.
    sidecar.respond('approval.respond', () => ({ ok: false, resolved: 0, choice: 'once' }))
    sidecar.respond('approval.pending', () => {
      const snapshot = { pending: [{ request_id: 'live-2', command: 'rm -rf dist' }] }
      emitFrame({ event: 'approval', data: { request_id: 'live-3', command: 'rm -rf out', session_id: sid } })
      return snapshot
    })
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'dead-1' }))).toEqual({ ok: true, choice: 'once', stale_cleared: true, pending_count: 2 })
    expect(await json(await s.get(`/api/approval/pending?session_id=${sid}`))).toMatchObject({ pending: { approval_id: 'live-2' }, pending_count: 2 })
    const promoted = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:${String(queued.length)}`, (f) => f.event === 'approval' && (f.data as Json).approval_id === 'live-2')
    expect(promoted.filter((f) => f.event === 'approval').map((f) => f.data)).toMatchObject([{ approval_id: 'dead-1', pending_count: 3 }, { approval_id: 'live-2', pending_count: 2 }])
    // A dead card answered with YOLO reports YOLO on once it is set.
    sidecar.respond('approval.pending', () => ({ pending: [] }))
    sidecar.respond('approval.set_yolo', (params) => ({ yolo_enabled: params.enabled, released: 0 }))
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'once', approval_id: 'live-2', yolo: true }))).toEqual({ ok: true, choice: 'once', stale_cleared: true, pending_count: 0, yolo_enabled: true })
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending_count).toBe(0)
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
  })

  it('a steer accepted as the turn completes is still reported by that turn', async () => {
    const sid = await newSession(s)
    let finishTurn: () => void = () => undefined
    let replySteer: () => void = () => undefined
    sidecar.respond('chat.start', (params) => new Promise((resolve) => { finishTurn = () => { resolve(completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }], { pending_steer: '' })) } }))
    // The steer reply is held until after the turn result: the Agent applied it, then finished, then replied.
    sidecar.respond('chat.steer', () => new Promise((resolve) => { replySteer = () => { resolve({ accepted: true, fallback: null }) } }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'go' }))
    const streamId = String(start.stream_id)
    const until = Date.now() + 5000
    while (s.deps.registry.activeRuns.get(streamId)?.phase !== 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    const steer = post(s, '/api/chat/steer', { session_id: sid, text: 'late steer', steer_id: 'late-1' })
    await new Promise((r) => setTimeout(r, 30))
    finishTurn()
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    replySteer()
    expect((await json(await steer)).accepted).toBe(true)
    expect(frames.find((f) => f.event === 'steer_consumed')?.data).toMatchObject({ steer_id: 'late-1', text: 'late steer' })
  })

  it('YOLO toggles reach the sidecar both ways and the local flag follows its acknowledgement', async () => {
    const sid = await newSession(s)
    const pushes: boolean[] = []
    sidecar.respond('approval.set_yolo', (params) => { pushes.push(params.enabled); return { yolo_enabled: params.enabled, released: 0 } })
    expect(await json(await post(s, '/api/session/yolo', { session_id: sid, enabled: true }))).toEqual({ ok: true, yolo_enabled: true })
    expect(pushes).toEqual([true])
    // A sidecar that cannot drop its state keeps the UI honest: the flag stays on and the toggle reports 503.
    sidecar.respond('approval.set_yolo', () => { throw new SidecarError('sidecar busy', { condition: 'sidecar_unavailable' }) })
    const failed = await post(s, '/api/session/yolo', { session_id: sid, enabled: false })
    expect(failed.status).toBe(503)
    expect(await json(await s.get(`/api/session/yolo?session_id=${sid}`))).toEqual({ yolo_enabled: true })
    sidecar.respond('approval.set_yolo', (params) => { pushes.push(params.enabled); return { yolo_enabled: params.enabled, released: 0 } })
    expect(await json(await post(s, '/api/session/yolo', { session_id: sid, enabled: false }))).toEqual({ ok: true, yolo_enabled: false })
    expect(pushes).toEqual([true, false])
    // Every turn start re-pushes the local flag, so a restarted sidecar never keeps a stale enable.
    sidecar.respond('chat.start', (params) => completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'ok' }]))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'go' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    expect(pushes).toEqual([true, false, false])
  })

  it('opposing YOLO toggles are serialized per session so the sidecar and the local flag agree', async () => {
    const sid = await newSession(s)
    const pushes: boolean[] = []
    const gates: (() => void)[] = []
    sidecar.respond('approval.set_yolo', (params) => new Promise((resolve) => { gates.push(() => { pushes.push(params.enabled); resolve({ yolo_enabled: params.enabled, released: 0 }) }) }))
    const until = Date.now() + 5000
    const enable = post(s, '/api/session/yolo', { session_id: sid, enabled: true })
    while (gates.length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    // The enable's sidecar mutation is in flight; an opposing toggle arrives now.
    const disable = post(s, '/api/session/yolo', { session_id: sid, enabled: false })
    await new Promise((r) => setTimeout(r, 50))
    // The disable's RPC waits for the enable's mutation + commit to settle.
    expect(gates).toHaveLength(1)
    gates[0]!()
    expect(await json(await enable)).toEqual({ ok: true, yolo_enabled: true })
    while (gates.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    gates[1]!()
    expect(await json(await disable)).toEqual({ ok: true, yolo_enabled: false })
    expect(pushes).toEqual([true, false])
    expect(await json(await s.get(`/api/session/yolo?session_id=${sid}`))).toEqual({ yolo_enabled: false })
    sidecar.respond('approval.set_yolo', (params) => ({ yolo_enabled: params.enabled, released: 0 }))
  })

  it('a cancel that lands while the YOLO state syncs never starts the Agent turn', async () => {
    const sid = await newSession(s)
    let starts = 0
    sidecar.respond('chat.start', (params) => { starts += 1; return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'late' }]) })
    let releaseSync: () => void = () => undefined
    sidecar.respond('approval.set_yolo', (params) => new Promise((resolve) => { releaseSync = () => { resolve({ yolo_enabled: params.enabled, released: 0 }) } }))
    try {
      const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'slow sync' }))
      const streamId = String(start.stream_id)
      const until = Date.now() + 5000
      while (!(s.deps.registry.activeRuns.get(streamId)?.phase === 'running') && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
      await new Promise((r) => setTimeout(r, 30))
      expect(await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).toMatchObject({ ok: true, cancelled: true })
      releaseSync()
      await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel')
      await new Promise((r) => setTimeout(r, 50))
      expect(starts).toBe(0)
    } finally {
      sidecar.respond('approval.set_yolo', (params) => ({ yolo_enabled: params.enabled, released: 0 }))
    }
  })

  it('deleting a session removes its state.db rows through the sidecar and reports the real outcome, except for messaging sessions', async () => {
    const sid = await newSession(s)
    const deletes: string[] = []
    sidecar.respond('state_db.delete_cli_session', (params) => { deletes.push(params.session_id); return { ok: true } })
    expect(await json(await post(s, '/api/session/delete', { session_id: sid }))).toEqual({ ok: true, state_db_cleanup_failed: false })
    expect(deletes).toEqual([sid])
    // A failed state.db cleanup is reported, not hidden behind a hardcoded false.
    const sid2 = await newSession(s)
    sidecar.respond('state_db.delete_cli_session', () => ({ ok: false }))
    expect(await json(await post(s, '/api/session/delete', { session_id: sid2 }))).toEqual({ ok: true, state_db_cleanup_failed: true })
    // A messaging channel's memory is never erased from the WebUI: no sidecar call, nothing reported as failed.
    const sid3 = await newSession(s)
    const tg = s.deps.sessionStore.get(sid3)
    tg.source_tag = 'telegram'
    s.deps.sessionStore.save(tg)
    sidecar.respond('state_db.delete_cli_session', (params) => { deletes.push(params.session_id); return { ok: true } })
    expect(await json(await post(s, '/api/session/delete', { session_id: sid3 }))).toEqual({ ok: true, state_db_cleanup_failed: false })
    expect(deletes).toEqual([sid])
  })

  it('a delegated subagent child is view-only: no goal, side question, or turn can run on it', async () => {
    const sid = await newSession(s)
    const child = s.deps.sessionStore.get(sid)
    child.source_tag = 'subagent'
    child.messages = [{ role: 'user', content: 'delegated work' }, { role: 'assistant', content: 'done by the child' }]
    s.deps.sessionStore.save(child)
    let starts = 0
    sidecar.respond('chat.start', (params) => { starts += 1; return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'nope' }]) })
    let res = await post(s, '/api/goal', { session_id: sid, args: 'set finish the migration' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Subagent sessions are view-only and cannot run /goal from WebUI')
    res = await post(s, '/api/btw', { session_id: sid, question: 'what did you do?' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Subagent sessions are view-only and cannot be used for /btw from WebUI')
    // Python `_get_or_materialize_session` refused the child with PermissionError, which chat start answered as 403.
    res = await post(s, '/api/chat/start', { session_id: sid, message: 'keep going' })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Read-only imported sessions cannot be continued from WebUI')
    res = await post(s, '/api/background', { session_id: sid, prompt: 'summarize' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Subagent sessions are view-only and cannot run background tasks from WebUI')
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
    let auxCalls = 0
    sidecar.respond('aux.complete', () => { auxCalls += 1; return { model: 'aux', text: 'Nope', usage: null } })
    res = await post(s, '/api/session/title/regenerate', { session_id: sid })
    expect(res.status).toBe(403)
    expect(auxCalls).toBe(0)
    sidecar.respond('aux.complete', () => { throw new SidecarError('no aux model', { condition: 'aux_unconfigured' }) })
    expect(starts).toBe(0)
  })

  it('a background task whose admission is refused leaves no tracked task or hidden session behind', async () => {
    const sid = await newSession(s)
    const turns = s.deps.turns as unknown as { deps: { profileDeleting: ((profile: string | null) => boolean) | undefined } }
    const original = turns.deps.profileDeleting
    turns.deps.profileDeleting = () => true
    try {
      const res = await post(s, '/api/background', { session_id: sid, prompt: 'doomed by deletion' })
      expect(res.status).toBe(409)
      expect(String((await json(res)).error)).toContain('being deleted')
    } finally {
      turns.deps.profileDeleting = original
    }
    expect(await json(await s.get(`/api/background/status?session_id=${sid}`))).toEqual({ results: [] })
    const leftover = [...s.deps.sessionStore.persistedIds()].filter((id) => { try { return str(s.deps.sessionStore.get(id, { metadataOnly: true }).title).startsWith('bg: doomed') } catch { return false } })
    expect(leftover).toEqual([])
  })

  it('the next model history includes the Agent state.db turns appended after the WebUI transcript', async () => {
    const sid = await newSession(s)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'from web', timestamp: 5000 }, { role: 'assistant', content: 'web reply', timestamp: 5001 }]
    session.context_messages = [{ role: 'user', content: 'from web', timestamp: 5000 }, { role: 'assistant', content: 'web reply', timestamp: 5001 }]
    s.deps.sessionStore.save(session)
    // A CLI continuation of the same session landed in the profile's state.db.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, title TEXT, model TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT, model_config TEXT, user_id TEXT, chat_id TEXT); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, reasoning TEXT)")
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 5000)
    for (const [role, content, ts] of [['user', 'from web', 5000], ['assistant', 'web reply', 5001], ['user', 'asked in the CLI', 5100], ['assistant', 'answered in the CLI', 5101]] as [string, string, number][]) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    let history: { role: string; content: string }[] = []
    sidecar.respond('chat.start', (params) => { history = params.conversation_history as { role: string; content: string }[]; return completed([...history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'ok' }]) })
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'and now?' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    expect(history.map((m) => m.content)).toEqual(['from web', 'web reply', 'asked in the CLI', 'answered in the CLI'])
  })

  it('a persisted read-only session (an inherited messaging/Claude Code import) is never continued', async () => {
    const sid = await newSession(s)
    const imported = s.deps.sessionStore.get(sid)
    imported.read_only = true
    imported.messages = [{ role: 'user', content: 'imported' }, { role: 'assistant', content: 'from elsewhere' }]
    s.deps.sessionStore.save(imported)
    let starts = 0
    sidecar.respond('chat.start', (params) => { starts += 1; return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'nope' }]) })
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'continue' })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Read-only imported sessions cannot be continued from WebUI')
    expect(starts).toBe(0)
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
    // ...nor run through the auxiliary entry points.
    for (const [path, body] of [['/api/goal', { session_id: sid, args: 'set finish it' }], ['/api/background', { session_id: sid, prompt: 'summarize' }], ['/api/btw', { session_id: sid, question: 'what?' }]] as [string, Json][]) {
      const refused = await post(s, path, body)
      expect(refused.status, path).toBe(403)
      expect((await json(refused)).error).toBe('Read-only imported sessions cannot be continued from WebUI')
    }
    expect(starts).toBe(0)
    // ...nor deleted: its owner's transcript is not the WebUI's to erase.
    const deleted = await post(s, '/api/session/delete', { session_id: sid })
    expect(deleted.status).toBe(400)
    expect((await json(deleted)).error).toBe('Read-only imported sessions cannot be deleted from WebUI')
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
  })

  it('a failed follow-up that replays history is an error turn, not a silent success', async () => {
    const sid = await newSession(s)
    const seeded = s.deps.sessionStore.get(sid)
    seeded.messages = [{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }]
    seeded.context_messages = [{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }]
    s.deps.sessionStore.save(seeded)
    // The Agent's failed result still carries messages: history plus the unanswered prompt.
    sidecar.respond('chat.start', (params) => ({
      ...completed([{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }, { role: 'user', content: str(params.user_message), timestamp: 200 }]),
      status: 'error', final_response: '', error: '401 invalid api key', failed: true, token_sent: false,
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'second question' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'apperror' || f.event === 'done')
    const apperror = frames.find((f) => f.event === 'apperror')?.data as Json | undefined
    expect(apperror, JSON.stringify(frames.map((f) => f.event))).toBeDefined()
    expect(str(apperror?.message)).toContain('401 invalid api key')
    const messages = s.deps.sessionStore.get(sid).messages
    expect(messages.some((m) => m._error)).toBe(true)
  })

  it('answers /btw while the chat\'s own turn runs, leaving that turn untouched (TAL-518)', async () => {
    const sid = await newSession(s)
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params) => {
      const msg = str(params.user_message)
      if (msg.endsWith('side question')) return completed([{ role: 'user', content: msg }, { role: 'assistant', content: 'side answer' }])
      return new Promise((resolve) => { release = () => { resolve(completed([{ role: 'user', content: msg }, { role: 'assistant', content: 'Done.' }])) } })
    })
    const run = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'long task' }))).stream_id)
    const res = await post(s, '/api/btw', { session_id: sid, question: 'side question' })
    expect(res.status).toBe(200)
    const side = await json(res)
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(side.stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    expect(frames.find((f) => f.event === 'done')?.data).toMatchObject({ ephemeral: true, answer: 'side answer' })
    expect(s.deps.sessionStore.get(sid).active_stream_id).toBe(run)
    // The side question sees the running turn's prompt, which deferred save keeps out of the stored history until settlement.
    const asked = sidecar.calls.find((c) => c.method === 'chat.start' && str((c.params as Json).user_message).endsWith('side question'))
    expect(((asked?.params as Json).conversation_history as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'long task']])
    release()
    await s.sse(`/api/chat/stream?stream_id=${run}&replay=1`, (f) => f.event === 'done')
    await new Promise((r) => setTimeout(r, 50))
    expect(s.deps.sessionStore.get(sid).messages.map((m) => [m.role, m.content])).toEqual([['user', 'long task'], ['assistant', 'Done.']])
  })

  it('a failed /btw is an error, never the parent\'s previous answer, and leaves no clone behind (TAL-512)', async () => {
    const sid = await newSession(s)
    const seeded = s.deps.sessionStore.get(sid)
    seeded.messages = [{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }]
    seeded.context_messages = [{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }]
    s.deps.sessionStore.save(seeded)
    const leftovers = (): string[] => [...s.deps.sessionStore.persistedIds()].filter((id) => { try { return str(s.deps.sessionStore.get(id, { metadataOnly: true }).title).startsWith('btw: ') } catch { return false } })
    // A provider error: the Agent's failed result replays history plus the unanswered question, and the sidecar says `completed`.
    sidecar.respond('chat.start', (params) => ({
      ...completed([{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }, { role: 'user', content: str(params.user_message), timestamp: 200 }]),
      final_response: '', error: '401 invalid api key', failed: true, token_sent: false,
    }))
    const failed = await json(await post(s, '/api/btw', { session_id: sid, question: 'side question' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(failed.stream_id)}&replay=1`, (f) => f.event === 'apperror' || f.event === 'done')
    expect(frames.find((f) => f.event === 'done')?.data).toBeUndefined()
    expect(str((frames.find((f) => f.event === 'apperror')?.data as Json | undefined)?.message)).toContain('401 invalid api key')
    await new Promise((r) => setTimeout(r, 50))
    expect(leftovers()).toEqual([])
    // The run journal keeps the error for a late subscriber, but no copy of the parent conversation.
    const journaled = JSON.stringify(s.deps.journal.readRunEvents(String(failed.session_id), String(failed.stream_id)))
    expect(journaled).toContain('apperror')
    expect(journaled).not.toContain('first answer')
    // Text streamed but the result added no reply: the replayed history is still the parent's, not this answer.
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'token', data: { text: 'half an' } })
      return completed([{ role: 'user', content: 'first question', timestamp: 100 }, { role: 'assistant', content: 'first answer', timestamp: 101 }, { role: 'user', content: str(params.user_message), timestamp: 200 }])
    })
    const streamed = await json(await post(s, '/api/btw', { session_id: sid, question: 'side question' }))
    const streamedFrames = await s.sse(`/api/chat/stream?stream_id=${String(streamed.stream_id)}&replay=1`, (f) => f.event === 'apperror' || f.event === 'done')
    expect(streamedFrames.find((f) => f.event === 'done')?.data).toBeUndefined()
    expect(streamedFrames.some((f) => f.event === 'apperror')).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(leftovers()).toEqual([])
    // A sidecar that throws mid-turn.
    sidecar.respond('chat.start', () => { throw new SidecarError('provider exploded', { condition: 'sidecar_error' }) })
    const thrown = await json(await post(s, '/api/btw', { session_id: sid, question: 'side question' }))
    await s.sse(`/api/chat/stream?stream_id=${String(thrown.stream_id)}&replay=1`, (f) => f.event === 'apperror')
    await new Promise((r) => setTimeout(r, 50))
    expect(leftovers()).toEqual([])
    // Admission refused.
    const turns = s.deps.turns as unknown as { deps: { profileDeleting: ((profile: string | null) => boolean) | undefined } }
    const original = turns.deps.profileDeleting
    turns.deps.profileDeleting = () => true
    try {
      expect((await post(s, '/api/btw', { session_id: sid, question: 'side question' })).status).toBe(409)
    } finally {
      turns.deps.profileDeleting = original
    }
    expect(leftovers()).toEqual([])
    // The parent is untouched.
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
  })

  it('keeps the closing explanation when the Agent exhausts its tool budget', async () => {
    const sid = await newSession(s)
    // The budget ran out mid tool-run: the graceful summary exists only in `final_response`.
    sidecar.respond('chat.start', (params) => ({
      ...completed([
        { role: 'user', content: str(params.user_message), timestamp: 300 },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }], timestamp: 301 },
        { role: 'tool', tool_call_id: 'c1', content: 'file contents', timestamp: 302 },
      ]),
      final_response: 'I reached the iteration limit and could not finish.', tool_limit_reached: true,
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'do a lot' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&replay=1`, (f) => f.event === 'stream_end')
    const done = frames.find((f) => f.event === 'done')?.data as Json | undefined
    expect(done?.terminal_state).toBe('tool_limit_reached')
    const persisted = s.deps.sessionStore.get(sid).messages
    expect(str(persisted[persisted.length - 1]?.content)).toBe('I reached the iteration limit and could not finish.')
    const shown = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(str(shown[shown.length - 1]?.content)).toBe('I reached the iteration limit and could not finish.')
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

describe('live tool outcomes (TAL-313)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let clock = 1_800_000_000
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock })
  })
  afterAll(() => s.close())

  it('decides failure from the raw result, measures each duration, never forwards the raw result, and reloads the same values', async () => {
    const sid = await newSession(s)
    const marker = 'raw-result-marker'
    const bearer = 'synthetic-bearer-0123456789abcdef'
    const tools: [string, number, unknown, string][] = [
      ['call-ok', 1.25, { exit_code: 0, output: `fine ${marker}` }, `{"exit_code": 0, "output": "Authorization: Bearer ${bearer}"}`],
      ['call-exit', 0.5, { exit_code: 2, output: `1 failed ${marker}` }, '{"exit_code": 2, "output": "1 failed"}'],
      ['call-error', 2, `{"error": "boom ${marker}"}`, '{"error": "boom"}'],
    ]
    sidecar.respond('chat.start', (params, emit) => {
      for (const [tid, seconds, raw] of tools) {
        emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', args: { command: tid }, tid } })
        clock += seconds
        emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'out', args: { command: tid }, tid, raw_result: raw } })
      }
      return completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: '', tool_calls: tools.map(([tid]) => ({ id: tid, type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: tid }) } })) },
        ...tools.map(([tid, , , content]) => ({ role: 'tool', tool_call_id: tid, content })),
        { role: 'assistant', content: 'Done.' },
      ])
    })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Tools"', usage: null }))
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'run them' }))).stream_id)
    const completes = (frames: SseFrame[]) => frames.filter((f) => f.event === 'tool_complete').map((f) => f.data as Json)
    const expected = [['call-ok', false, 1.25], ['call-exit', true, 0.5], ['call-error', true, 2]]
    const live = completes(await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end'))
    expect(live.map((d) => [d.id, d.is_error, d.duration])).toEqual(expected)
    expect(JSON.stringify(live)).not.toContain('raw_result')
    const journal = readFileSync(join(realpathSync(s.state), 'sessions', '_run_journal', sid, `${streamId}.jsonl`), 'utf8')
    expect(journal).not.toContain('raw_result')
    const replayed = completes(await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end'))
    expect(replayed.map((d) => [d.id, d.is_error, d.duration])).toEqual(expected)

    // A later turn keeps the durations the first one recorded.
    sidecar.respond('chat.start', (params) => completed([...s.deps.sessionStore.get(sid).context_messages, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Again.' }]))
    const next = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'again' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${next}`, (f) => f.event === 'stream_end')

    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect((detail.tool_calls as Json[]).map((c) => [c.tid, c.is_error, c.duration])).toEqual(expected)
    const calls = (detail.messages as Json[]).find((m) => Array.isArray(m.tool_calls))?.tool_calls as Json[]
    expect(calls.map((c) => [c.id, c.is_error, c.duration])).toEqual(expected)
    // The resolved result is redacted like the transcript it comes from.
    expect(String(calls[0]?.result)).toContain('Authorization: Bearer')
    expect(JSON.stringify(detail)).not.toContain(bearer)
    const scene = (detail.messages as Json[]).find((m) => m.content === 'Done.')?._anchor_activity_scene as Json
    expect((scene.activity_rows as Json[]).filter((r) => r.role === 'tool').map((r) => { const t = r.tool as Json; return [t.id, t.is_error, t.duration] })).toEqual(expected)
  })

  it('ships each result view live, on replay and after reload, keeping stderr and the exit code (TAL-315)', async () => {
    const sid = await newSession(s)
    const bearer = 'synthetic-bearer-0123456789abcdef'
    const raw = { output: 'built\\nok', stderr: `warning: deprecated\nAuthorization: Bearer ${bearer}`, exit_code: 2, error: null }
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', args: { command: 'make' }, tid: 'call-make' } })
      // The sidecar's flat preview keeps only the output.
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'built\\nok', args: { command: 'make' }, tid: 'call-make', raw_result: raw } })
      return completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call-make', type: 'function', function: { name: 'terminal', arguments: '{"command":"make"}' } }] },
        { role: 'tool', tool_call_id: 'call-make', content: JSON.stringify(raw) },
        { role: 'assistant', content: 'Built with a warning.' },
      ])
    })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Make"', usage: null }))
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'build' }))).stream_id)
    // Redacted like every string that leaves the server.
    const view = { stdout: 'built\nok', stderr: 'warning: deprecated\nAuthorization: Bearer synthe...cdef', exit_code: 2 }
    const completes = (frames: SseFrame[]) => frames.filter((f) => f.event === 'tool_complete').map((f) => (f.data as Json).result_view)
    const live = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    expect(completes(live)).toEqual([view])
    expect(JSON.stringify(live)).not.toContain(bearer)
    expect(completes(await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end'))).toEqual([view])
    const journal = readFileSync(join(realpathSync(s.state), 'sessions', '_run_journal', sid, `${streamId}.jsonl`), 'utf8')
    expect(journal).toContain('"result_view"')
    expect(journal).not.toContain('raw_result')
    expect(journal).not.toContain(bearer)

    for (const query of ['', '&messages=1&msg_limit=50']) {
      const detail = (await json(await s.get(`/api/session?session_id=${sid}${query}`))).session as Json
      const calls = (detail.messages as Json[]).find((m) => Array.isArray(m.tool_calls))?.tool_calls as Json[]
      expect(calls.map((c) => c.result_view), query).toEqual([view])
      expect(JSON.stringify(detail), query).not.toContain(bearer)
      const scene = (detail.messages as Json[]).find((m) => m.content === 'Built with a warning.')?._anchor_activity_scene as Json
      expect((scene.activity_rows as Json[]).filter((r) => r.role === 'tool').map((r) => (r.tool as Json).result_view), query).toEqual([view])
    }
  })

  it('keeps a failed turn\'s completed tools with their outcomes after reload', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (_params, emit) => {
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'terminal', args: { command: 'make' }, tid: 'call-make' } })
      clock += 4
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'terminal', preview: 'failed', args: { command: 'make' }, tid: 'call-make', raw_result: { exit_code: 2, stderr: 'boom' } } })
      throw new SidecarError('provider exploded', { condition: 'sidecar_error' })
    })
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'build it' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'apperror')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const partial = (detail.messages as Json[]).find((m) => m._partial === true)
    // TAL-315: the sections shown live (stderr, the exit code) survive the failed turn's reload.
    const view = { stderr: 'boom', exit_code: 2 }
    expect((partial?.tool_calls as Json[]).map((c) => [c.id, c.done, c.is_error, c.duration, c.result, c.result_view])).toEqual([['call-make', true, true, 4, 'failed', view]])
    const scene = (detail.messages as Json[]).at(-1)?._anchor_activity_scene as Json
    expect((scene.activity_rows as Json[]).filter((r) => r.role === 'tool').map((r) => { const t = r.tool as Json; return [t.id, t.is_error, t.duration, t.result_view] })).toEqual([['call-make', true, 4, view]])
  })

  it('keeps an Anthropic tool_result call\'s live duration after reload', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'search_files', args: { pattern: 'TODO' }, tid: 'toolu-1' } })
      clock += 2.5
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'search_files', preview: 'denied', args: { pattern: 'TODO' }, tid: 'toolu-1', raw_result: { error: 'denied' } } })
      return completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'search_files', input: { pattern: 'TODO' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: '{"error": "denied"}' }] },
        { role: 'assistant', content: 'The search failed.' },
      ])
    })
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'search' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect((detail.tool_calls as Json[]).map((c) => [c.tid, c.is_error, c.duration])).toEqual([['toolu-1', true, 2.5]])
    const calls = (detail.messages as Json[]).find((m) => Array.isArray(m.tool_calls))?.tool_calls as Json[]
    expect(calls.map((c) => [c.id, c.done, c.is_error, c.duration])).toEqual([['toolu-1', true, true, 2.5]])
  })
})

describe('live metering and todo_state (TAL-397)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let clock = 1_800_000_000
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Plan"', usage: null }))
  })
  afterAll(() => s.close())

  const turn = async (sid: string, message: string): Promise<SseFrame[]> => {
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message }))).stream_id)
    return s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
  }
  const meterings = (frames: SseFrame[]): Json[] => frames.slice(0, frames.findIndex((f) => f.event === 'done')).filter((f) => f.event === 'metering').map((f) => f.data as Json)

  it('streams server-computed metering and todo_state during the turn and ends on the persisted values', async () => {
    const sid = await newSession(s)
    const todos = [{ id: '1', content: 'Write the test', status: 'completed' }, { id: '2', content: 'Fix the server', status: 'in_progress' }]
    const todoResult = JSON.stringify({ todos, summary: { total: 2, pending: 0, in_progress: 1, completed: 1, cancelled: 0 } })
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'token', data: { text: 'Planning ' } })
      clock += 0.5
      emit({ event: 'token', data: { text: 'now.' } })
      // The Agent's session counters after its first API call.
      emit({ event: 'usage', data: { prompt_tokens: 100, completion_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0.0005 } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'todo', args: {}, tid: 'call_todo' } })
      // `raw_result` caps nested values; the todo tool's full result rides as `todo_result`.
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'todo', preview: todoResult.slice(0, 20), args: {}, tid: 'call_todo', raw_result: { todos: todoResult.slice(9, 30), summary: '{}' }, todo_result: todoResult } })
      clock += 2
      emit({ event: 'token', data: { text: 'Done.' } })
      return completed([
        { role: 'user', content: str(params.user_message) },
        { role: 'assistant', content: 'Planning now.', tool_calls: [{ id: 'call_todo', type: 'function', function: { name: 'todo', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_todo', content: todoResult },
        { role: 'assistant', content: 'Done.' },
      ])
    })
    const frames = await turn(sid, 'plan it')
    const names = eventNames(frames)
    const done = frames.find((f) => f.event === 'done')?.data as Json
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json

    // Live metering: the first delta reports at once, a usage change reports before the next content frame.
    const live = meterings(frames)
    expect(live[0]).toMatchObject({ session_id: sid, usage: { input_tokens: 0, output_tokens: 0 }, tps: null, tps_available: false, estimated: false })
    const usageIdx = frames.findIndex((f) => f.event === 'metering' && ((f.data as Json).usage as Json).input_tokens === 100)
    expect(usageIdx).toBeGreaterThan(0)
    expect(usageIdx).toBeLessThan(names.indexOf('tool'))
    expect((frames[usageIdx]?.data as Json).usage).toEqual({ input_tokens: 100, output_tokens: 10, estimated_cost: 0.0005, cache_read_tokens: 0, cache_write_tokens: 0 })

    // Live todo_state: the full list, before the turn settles, equal to the settled and reloaded snapshot.
    const todoFrame = frames.find((f) => f.event === 'todo_state')?.data as Json
    expect(names.indexOf('todo_state')).toBeGreaterThan(names.indexOf('tool_complete'))
    expect(names.indexOf('todo_state')).toBeLessThan(names.indexOf('done'))
    expect(todoFrame).toMatchObject({ session_id: sid, source: 'live', todos, summary: { total: 2, in_progress: 1 }, version: 1 })
    expect((done.session as Json).todo_state).toMatchObject({ todos: todoFrame.todos, summary: todoFrame.summary, version: todoFrame.version })
    expect(detail.todo_state).toMatchObject({ todos: todoFrame.todos, summary: todoFrame.summary, version: todoFrame.version })

    // The last metering frame before `done` carries the persisted counters and the persisted turn rate.
    const last = live[live.length - 1]!
    expect(last.usage).toEqual({ input_tokens: detail.input_tokens, output_tokens: detail.output_tokens, estimated_cost: detail.estimated_cost, cache_read_tokens: detail.cache_read_tokens, cache_write_tokens: detail.cache_write_tokens })
    expect(last.usage).toMatchObject({ input_tokens: 120, output_tokens: 30, estimated_cost: 0.001 })
    const settledRow = (detail.messages as Json[]).filter((m) => m.role === 'assistant').at(-1)!
    expect(last).toMatchObject({ tps: settledRow._turnTps, tps_available: true, estimated: false })
    expect(last.tps).toBe((done.usage as Json).tps)
    // The todo tool's full result is server-only, like `raw_result`.
    expect(JSON.stringify(frames)).not.toContain('todo_result')
  })

  // Codex review on #329: a turn that errors or is cancelled after the Agent spent tokens and wrote todos must not roll back.
  const spent = { prompt_tokens: 300, completion_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0.02 }
  it.each([
    ['an error', 'apperror', (): ChatResult => { throw new SidecarError('provider exploded', { condition: 'sidecar_error' }) }],
    ['a cancel', 'cancel', (): ChatResult => completed([], { status: 'cancelled', final_response: '', usage: spent })],
  ] as const)('keeps the live counters and todo list when the turn ends in %s', async (_label, terminal, end) => {
    const sid = await newSession(s)
    const todos = [{ id: '1', content: 'Survive the exit', status: 'in_progress' }]
    const todoResult = JSON.stringify({ todos, summary: { total: 1, in_progress: 1 } })
    sidecar.respond('chat.start', (_params, emit) => {
      emit({ event: 'usage', data: spent })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'todo', args: {}, tid: 'call_todo' } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'todo', preview: 'x', args: {}, tid: 'call_todo', raw_result: {}, todo_result: todoResult } })
      clock += 1
      return end()
    })
    const frames = await turn(sid, 'then fail')
    const last = meterings(frames.concat({ event: 'done', data: {}, id: null, raw: '' })).at(-1)!
    expect(last.usage).toMatchObject({ input_tokens: 300, output_tokens: 40, estimated_cost: 0.02 })
    const terminalSession = (frames.find((f) => f.event === terminal)?.data as Json).session as Json
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    for (const session of [terminalSession, detail]) {
      expect(session).toMatchObject({ input_tokens: 300, output_tokens: 40, estimated_cost: 0.02 })
      expect(session.todo_state).toMatchObject({ todos })
    }
  })

  it('keeps an unsettled todo list only until the transcript holds a newer todo write', () => {
    const row = (content: string, timestamp: number): Json => ({ role: 'tool', content: JSON.stringify({ todos: [{ id: '1', content, status: 'pending' }] }), timestamp })
    const unsettled = { todos: [{ id: '1', content: 'kept', status: 'in_progress' }], summary: {}, version: 1, ts: 200 }
    const pick = (messages: Json[]): unknown => { const payload: Json = {}; attachTodoState(payload, messages, unsettled); return ((payload.todo_state as Json).todos as Json[])[0]?.content }
    expect(pick([row('older', 100)])).toBe('kept')
    expect(pick([])).toBe('kept')
    expect(pick([row('older', 100), row('newer', 300)])).toBe('newer')
  })

  it('throttles delta metering to once a second and reports the delta rate', async () => {
    const sid = await newSession(s)
    sidecar.respond('chat.start', (params, emit) => {
      for (let i = 0; i < 20; i += 1) emit({ event: 'token', data: { text: `t${String(i)} ` } })
      clock += 0.4
      emit({ event: 'reasoning', data: { text: 'still inside the window' } })
      clock += 0.6
      emit({ event: 'token', data: { text: 'end' } })
      return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'end' }])
    })
    const live = meterings(await turn(sid, 'stream a lot'))
    // 22 deltas: the first reports at once, the rest of the window is throttled, the delta a second later reports 22/s.
    expect(live.slice(0, -1).map((m) => [m.tps, m.tps_available])).toEqual([[null, false], [22, true]])
  })
})
