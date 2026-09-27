import { describe, expect, it } from 'vitest'
import { initialStreamState, isTerminal, liveText, parseSeq, streamReducer, type StreamState } from './reducer'
import { parseChatEvent } from '../contracts/sse'

const SID = 'sess-1'
const STREAM = 'stream-a'

function ev(state: StreamState, name: string, data: unknown, opts: { id?: string; streamId?: string; now?: number } = {}): StreamState {
  const event = parseChatEvent(name, JSON.stringify(data))
  if (!event) throw new Error(`unparseable ${name}`)
  return streamReducer(state, { type: 'event', sessionId: SID, streamId: opts.streamId ?? STREAM, event, lastEventId: opts.id ?? '', now: opts.now ?? 1000 })
}

function started(): StreamState {
  return streamReducer(initialStreamState, { type: 'start', sessionId: SID, streamId: STREAM, turnId: 't1', userMessageId: 'u1', userText: 'hi', now: 1 })
}

describe('stream reducer: ordering and projection', () => {
  it('appends tokens in order and merges consecutive text', () => {
    let s = started()
    s = ev(s, 'token', { text: 'Hel' })
    s = ev(s, 'token', { text: 'lo' })
    const turn = s.turns[SID]!
    expect(turn.status).toBe('streaming')
    expect(liveText(turn)).toBe('Hello')
    expect(turn.segments).toHaveLength(1)
  })
  it('splits prose around tool calls and completes them by id', () => {
    let s = started()
    s = ev(s, 'token', { text: 'Let me check. ' })
    s = ev(s, 'tool', { name: 'read_file', args: { path: 'a.txt' }, id: 'c1' })
    s = ev(s, 'tool_complete', { name: 'read_file', id: 'c1', is_error: false, duration: 0.3, preview: 'ok' })
    s = ev(s, 'token', { text: 'Done.' })
    const turn = s.turns[SID]!
    expect(turn.segments.map((x) => x.kind)).toEqual(['text', 'tool', 'text'])
    expect(turn.tools.c1).toMatchObject({ done: true, isError: false, duration: 0.3, preview: 'ok' })
  })
  it('settles each same-name call by its own id when they finish out of order, and a replay adds no card', () => {
    const run = (s: StreamState, from = 1) => [
      ['tool', { id: 'a', name: 'terminal', args: { command: 'a' } }],
      ['tool', { id: 'b', name: 'terminal', args: { command: 'b' } }],
      ['tool_complete', { id: 'b', name: 'terminal', is_error: false, duration: 0.2, preview: 'B' }],
      ['tool_complete', { id: 'a', name: 'terminal', is_error: true, duration: 1.5, preview: 'A' }],
    ].reduce((acc, [name, data], i) => ev(acc, name as string, data, { id: `${STREAM}:${String(from + i)}` }), s)
    const live = run(started())
    const turn = live.turns[SID]!
    expect(turn.toolOrder).toEqual(['a', 'b'])
    expect(turn.tools.a).toMatchObject({ done: true, isError: true, duration: 1.5, preview: 'A' })
    expect(turn.tools.b).toMatchObject({ done: true, isError: false, duration: 0.2, preview: 'B' })
    // A reconnect from the start of the journal re-delivers the same frames.
    expect(run(live).turns[SID]).toEqual(turn)
  })
  it('accumulates reasoning with bounded titles', () => {
    let s = started()
    s = ev(s, 'reasoning', { text: 'think ', titles: ['Plan', ' ', 'Check'] })
    s = ev(s, 'reasoning', { text: 'more' })
    const turn = s.turns[SID]!
    expect(turn.reasoningText).toBe('think more')
    expect(turn.reasoningTitles).toEqual(['Plan', 'Check'])
    expect(turn.segments[0]).toMatchObject({ kind: 'reasoning', text: 'think more' })
  })
  it('records approval and clarify prompts and clears them on done', () => {
    let s = started()
    s = ev(s, 'approval', { approval_id: 'a1', command: 'rm -rf x', pending_count: 1 })
    expect(s.turns[SID]!.approval?.approval_id).toBe('a1')
    s = ev(s, 'clarify', { clarify_id: 'q1', question: 'Which?', choices: ['a', 'b'] })
    expect(s.turns[SID]!.clarify?.question).toBe('Which?')
    s = ev(s, 'done', { session: { session_id: SID, title: 'T' }, usage: { input_tokens: 3 } })
    expect(s.turns[SID]!.approval).toBeNull()
    expect(s.turns[SID]!.clarify).toBeNull()
    expect(s.turns[SID]!.doneSession?.title).toBe('T')
  })
  it('projects metering, context status, steer consumption and compression', () => {
    let s = started()
    s = ev(s, 'metering', { tps: 21.5, usage: { output_tokens: 10 } })
    s = ev(s, 'context_status', { state: 'near_limit', message: 'x' })
    s = ev(s, 'steer_consumed', { steer_id: 's1', text: 'also do y' })
    s = ev(s, 'steer_consumed', { steer_id: 's1', text: 'also do y' })
    s = ev(s, 'compressing', { new_session_id: 'n1' })
    const turn = s.turns[SID]!
    expect(turn.tps).toBe(21.5)
    expect(turn.contextStatus?.state).toBe('near_limit')
    expect(turn.segments.filter((seg) => seg.kind === 'steering')).toEqual([{ kind: 'steering', steerId: 's1', text: 'also do y' }])
    expect(turn.compression).toEqual({ state: 'compressing', newSessionId: 'n1' })
  })
})

describe('stream reducer: consumed steering', () => {
  it('places a consumed steer after the tool that had completed, where the server persists it', () => {
    let s = started()
    s = ev(s, 'token', { text: 'Reading a.' })
    s = ev(s, 'tool', { id: 'ta', name: 'read_file' })
    s = ev(s, 'tool_complete', { id: 'ta', name: 'read_file', result: 'A' })
    s = ev(s, 'tool', { id: 'tb', name: 'read_file' })
    s = ev(s, 'steer_consumed', { steer_id: 's1', text: 'check b too', after_tool_call_id: 'ta' })
    s = ev(s, 'steer_consumed', { steer_id: 's0', text: 'before any tool', after_tool_call_id: null })
    const kinds = s.turns[SID]!.segments.map((seg) => (seg.kind === 'steering' ? `steer:${seg.steerId}` : seg.kind === 'tool' ? `tool:${seg.toolId}` : seg.kind))
    expect(kinds).toEqual(['steer:s0', 'text', 'tool:ta', 'steer:s1', 'tool:tb'])
  })

  it('keeps steers taken after the same tool in consumption order', () => {
    let s = started()
    s = ev(s, 'tool', { id: 'ta', name: 'read_file' })
    s = ev(s, 'tool_complete', { id: 'ta', name: 'read_file', result: 'A' })
    s = ev(s, 'tool', { id: 'tb', name: 'read_file' })
    for (const id of ['s1', 's2']) s = ev(s, 'steer_consumed', { steer_id: id, text: id, after_tool_call_id: 'ta' })
    const kinds = s.turns[SID]!.segments.map((seg) => (seg.kind === 'steering' ? `steer:${seg.steerId}` : seg.kind === 'tool' ? `tool:${seg.toolId}` : seg.kind))
    expect(kinds).toEqual(['tool:ta', 'steer:s1', 'steer:s2', 'tool:tb'])
  })
})

describe('stream reducer: idempotency and ownership', () => {
  it('drops replayed events at or below the last applied cursor and keeps newer ones', () => {
    let s = started()
    s = ev(s, 'token', { text: 'a' }, { id: `${STREAM}:1` })
    s = ev(s, 'token', { text: 'b' }, { id: `${STREAM}:2` })
    s = ev(s, 'token', { text: 'b' }, { id: `${STREAM}:2` })
    s = ev(s, 'token', { text: 'a' }, { id: `${STREAM}:1` })
    s = ev(s, 'token', { text: 'c' }, { id: `${STREAM}:3` })
    expect(liveText(s.turns[SID]!)).toBe('abc')
    expect(s.turns[SID]!.lastSeq).toBe(3)
  })
  it('does not treat cursors from another stream as sequence numbers', () => {
    expect(parseSeq('other:5', STREAM)).toBeNull()
    expect(parseSeq(`${STREAM}:7`, STREAM)).toBe(7)
    expect(parseSeq('', STREAM)).toBeNull()
  })
  it('ignores events from a stream that does not own the turn', () => {
    let s = started()
    s = ev(s, 'token', { text: 'mine' })
    const before = s
    s = ev(s, 'token', { text: 'stale' }, { streamId: 'stream-old' })
    expect(s).toBe(before)
    s = ev(s, 'done', {}, { streamId: 'stream-old' })
    expect(s.turns[SID]!.status).toBe('streaming')
  })
  it('ignores content after a terminal event and finalizes only once', () => {
    let s = started()
    s = ev(s, 'token', { text: 'x' })
    s = ev(s, 'done', { session: { session_id: SID, title: 'A' } }, { now: 5 })
    s = ev(s, 'token', { text: 'late' })
    s = ev(s, 'tool', { name: 'shell', id: 'z' })
    s = ev(s, 'apperror', { type: 'error', message: 'boom' }, { now: 9 })
    const turn = s.turns[SID]!
    expect(liveText(turn)).toBe('x')
    expect(turn.status).toBe('done')
    expect(turn.doneAt).toBe(5)
    expect(turn.error).toBeNull()
    expect(turn.toolOrder).toEqual([])
  })
})

describe('stream reducer: every lifecycle exit', () => {
  it('normal completion: done then stream_end', () => {
    let s = started()
    s = ev(s, 'done', { session: { session_id: SID, title: 'A' }, usage: { input_tokens: 1 } })
    s = ev(s, 'stream_end', { session_id: SID })
    expect(s.turns[SID]).toMatchObject({ status: 'done', streamEnded: true })
    expect(isTerminal(s.turns[SID]!.status)).toBe(true)
  })
  it('terminal error: apperror carries type, message and continuation', () => {
    let s = started()
    s = ev(s, 'apperror', { type: 'chat_admission_timeout', message: 'busy', hint: 'retry', continuation_session_id: 'c2' })
    expect(s.turns[SID]).toMatchObject({ status: 'error', streamEnded: true, error: { type: 'chat_admission_timeout', message: 'busy', hint: 'retry', continuationSessionId: 'c2' } })
  })
  it('legacy error event and interrupted apperror map to error and cancelled', () => {
    let s = started()
    s = ev(s, 'error', { message: 'legacy' })
    expect(s.turns[SID]!.status).toBe('error')
    let c = started()
    c = ev(c, 'apperror', { type: 'interrupted', terminal_state: 'interrupted', message: 'stopped' })
    expect(c.turns[SID]).toMatchObject({ status: 'cancelled', cancelledMessage: 'stopped', error: null })
  })
  it.each([
    ['done', { terminal_state: 'no_response' }, 'done', 'no_response'],
    ['apperror', { type: 'cancelled', terminal_state: 'cancelled', message: 'stopped' }, 'cancelled', 'cancelled'],
    ['apperror', { type: 'compression_exhausted', terminal_state: 'compression_exhausted', message: 'full' }, 'error', 'compression_exhausted'],
    ['apperror', { type: 'cancelled', message: 'no outcome' }, 'error', 'error'],
    ['cancel', { terminal_state: 'cancelled' }, 'cancelled', 'cancelled'],
  ] as const)('takes the outcome of %s from its terminal_state, never from the error type (%j)', (name, data, status, terminalState) => {
    const s = ev(started(), name, data)
    expect(s.turns[SID]).toMatchObject({ status, terminalState })
  })
  it('cancellation: cancel event finalizes and ends the stream', () => {
    let s = started()
    s = ev(s, 'token', { text: 'partial' })
    s = ev(s, 'cancel', {})
    expect(s.turns[SID]).toMatchObject({ status: 'cancelled', streamEnded: true })
    expect(liveText(s.turns[SID]!)).toBe('partial')
  })
  it('reconnect: connection error marks reconnecting; open resumes streaming without losing text', () => {
    let s = started()
    s = ev(s, 'token', { text: 'keep' })
    s = streamReducer(s, { type: 'connection', sessionId: SID, streamId: STREAM, status: 'error' })
    expect(s.turns[SID]!.status).toBe('reconnecting')
    s = streamReducer(s, { type: 'connection', sessionId: SID, streamId: STREAM, status: 'open' })
    expect(s.turns[SID]!.status).toBe('streaming')
    expect(liveText(s.turns[SID]!)).toBe('keep')
  })
  it('replay: attach to a running stream after reload and apply journal events once', () => {
    let s = streamReducer(initialStreamState, { type: 'attach', sessionId: SID, streamId: STREAM, now: 1, replay: true })
    expect(s.turns[SID]).toMatchObject({ status: 'connecting', replayed: true })
    s = ev(s, 'token', { text: 'r1' }, { id: `${STREAM}:1` })
    s = ev(s, 'token', { text: 'r1' }, { id: `${STREAM}:1` })
    s = ev(s, 'done', {}, { id: `${STREAM}:2` })
    expect(liveText(s.turns[SID]!)).toBe('r1')
    expect(s.turns[SID]!.status).toBe('done')
  })
  it('session replacement: a new start for the same session replaces the turn', () => {
    let s = started()
    s = ev(s, 'token', { text: 'old' })
    s = streamReducer(s, { type: 'start', sessionId: SID, streamId: 'stream-b', turnId: 't2', userMessageId: 'u2', userText: 'again', now: 2 })
    expect(s.turns[SID]!.streamId).toBe('stream-b')
    expect(liveText(s.turns[SID]!)).toBe('')
    s = ev(s, 'token', { text: 'late' }, { streamId: STREAM })
    expect(liveText(s.turns[SID]!)).toBe('')
  })
  it('profile change and teardown drop the local turn without touching other sessions', () => {
    let s = started()
    s = streamReducer(s, { type: 'start', sessionId: 'other', streamId: 'so', turnId: null, userMessageId: null, userText: '', now: 1 })
    s = streamReducer(s, { type: 'teardown', sessionId: SID })
    expect(s.turns[SID]).toBeUndefined()
    expect(s.turns.other).toBeDefined()
    expect(streamReducer(s, { type: 'teardown', sessionId: SID })).toBe(s)
  })
  it('settle: stream_end without done converges on the persisted session', () => {
    let s = started()
    s = ev(s, 'token', { text: 'x' })
    s = ev(s, 'stream_end', { session_id: SID })
    expect(s.turns[SID]!.status).toBe('streaming')
    s = streamReducer(s, { type: 'settle', sessionId: SID, streamId: STREAM, session: { session_id: SID, title: 'settled', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true } })
    expect(s.turns[SID]).toMatchObject({ status: 'done', streamEnded: true })
    expect(s.turns[SID]!.doneSession?.title).toBe('settled')
  })
})
