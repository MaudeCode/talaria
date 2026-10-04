/** Anchor activity scenes: one normalized row shape for both clients, identical in the detail preview and the paged rows. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { anchorActivitySceneTransportPreview, buildTurnScene, hydrateAnchorActivityScenes, normalizeSceneRows, withTurnIds } from './anchor.js'
import { withSceneToolDisplay } from '../redact.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

/** A legacy scene as the predecessor browser saved it: every shape the clients used to decode differently. */
const legacyRows = [
  { row_id: 'steer', order_index: '4', role: 'steering', text: 'Also check b.txt', status: 'pending', payload: { steer_id: 's1', created_at: 3 } },
  { row_id: 'think', order_index: 0, role: 'thinking', thinking: { text: 'Plan the check.', titles: ['Plan', ' ', 7] } },
  { row_id: 'failed', order_index: 1, role: 'tool', status: 'failed', tool_call_id: 'c1', tool: { name: 'terminal', args: { command: 'false' }, snippet: 'exit 1' } },
  { row_id: 'plain', order_index: 2, role: 'tool', tool: { id: 'c2', name: 'read_file', args: { path: 'a.txt' }, result: 'A' } },
  { row_id: 'running', order_index: 3, role: 'tool', status: 'running', tool: { id: 'c3', name: 'read_file' } },
  { row_id: 'prose', role: 'prose', text: '<think>hidden plan</think>Reading files.', order_index: 5 },
  'not a row',
  { row_id: 'empty', role: 'prose', text: '   ', order_index: 6 },
]

describe('normalizeSceneRows', () => {
  it('orders rows and gives every role one explicit shape', () => {
    const rows = normalizeSceneRows(legacyRows)
    expect(rows.map((r) => [r.order_index, r.row_id, r.role])).toEqual([
      [0, 'think', 'reasoning'], [1, 'tool:c1', 'tool'], [2, 'tool:c2', 'tool'], [3, 'tool:c3', 'tool'],
      [4, 'steering:s1', 'steering'], [5, 'prose:thinking', 'reasoning'], [6, 'prose', 'prose'],
    ])
    expect(rows[0]).toMatchObject({ text: 'Plan the check.', titles: ['Plan'] })
    expect(rows[1]?.tool).toEqual({ id: 'c1', name: 'terminal', args: { command: 'false' }, preview: 'exit 1', result: 'exit 1', result_view: { text: 'exit 1' }, done: true, is_error: true, duration: null, cost_usd: null })
    expect(rows[2]?.tool).toMatchObject({ id: 'c2', done: true, is_error: false, result: 'A' })
    expect(rows[3]?.tool).toMatchObject({ id: 'c3', done: false, is_error: false })
    expect(rows[4]?.steering).toEqual({ steer_id: 's1', consumed: false, submitted_at: 3, consumed_at: null, phase_duration: null })
    expect(rows[5]).toMatchObject({ text: 'hidden plan' })
    expect(rows[6]).toMatchObject({ text: 'Reading files.' })
  })

  it('marks steering consumed only when stored so, and keeps a repeated tool at its first position', () => {
    const rows = normalizeSceneRows([
      { role: 'tool', tool_call_id: 'c1', status: 'running', tool: { name: 'read_file' } },
      { role: 'steering', text: 'Stop', status: 'consumed', created_at: 9, payload: { steer_id: 's1' } },
      { role: 'tool', tool_call_id: 'c1', status: 'completed', tool: { name: 'read_file', done: true } },
    ])
    expect(rows.map((r) => r.row_id)).toEqual(['tool:c1', 'steering:s1'])
    expect(rows[0]?.tool?.done).toBe(true)
    expect(rows[1]?.steering).toMatchObject({ consumed: true, consumed_at: 9 })
  })

  it('is idempotent: normalizing normalized rows changes nothing', () => {
    const once = normalizeSceneRows(legacyRows)
    expect(normalizeSceneRows(once)).toEqual(once)
    const consumed = normalizeSceneRows([{ role: 'steering', text: 'Stop', status: 'consumed', created_at: 9, payload: { steer_id: 's1', created_at: 8 } }])
    expect(normalizeSceneRows(consumed)).toEqual(consumed)
  })

  it('returns no rows for a malformed list', () => {
    expect(normalizeSceneRows(null)).toEqual([])
    expect(normalizeSceneRows({ rows: [] })).toEqual([])
  })
})

describe('anchorActivitySceneTransportPreview', () => {
  it('reports a consumed steer the tail preview leaves out', () => {
    const steer = { row_id: 'steering:s', order_index: 0, role: 'steering', text: 'Stop', steering: { steer_id: 's', consumed: true, submitted_at: 1, consumed_at: 2 } }
    const work = Array.from({ length: 90 }, (_, i) => ({ row_id: `r${String(i)}`, order_index: i + 1, role: 'reasoning', text: `step ${String(i)}` }))
    const preview = anchorActivitySceneTransportPreview({ version: 'activity_scene_v1', final_answer: 'Done.', activity_rows: [steer, ...work] })
    expect((preview.activity_rows as Json[]).some((r) => r.role === 'steering')).toBe(false)
    expect(preview.has_consumed_steering).toBe(true)
    expect(anchorActivitySceneTransportPreview({ version: 'activity_scene_v1', activity_rows: work }).has_consumed_steering).toBe(false)
  })

  it('ships a stored answer without inline thinking or tool-call XML, and drops a stored excerpt (TAL-302)', () => {
    const stored = { version: 'activity_scene_v1', final_answer: '<think>plan</think>Done. <tool_call>{}</tool_call>', final_answer_excerpt: '<think>plan', activity_rows: [{ row_id: 'p', order_index: 0, role: 'prose', text: 'Done.' }] }
    const preview = anchorActivitySceneTransportPreview(stored)
    expect(preview.final_answer).toBe('Done.')
    expect(preview).not.toHaveProperty('final_answer_excerpt')
    // The answer's own prose row still renders only below "Worked".
    expect(preview.activity_rows).toEqual([])
    expect(stored.final_answer).toBe('<think>plan</think>Done. <tool_call>{}</tool_call>')
  })

  it('reads a completed scene whose stored answer was only markup as one that did not reply (TAL-302)', () => {
    const work = { row_id: 'r', order_index: 0, role: 'reasoning', text: 'step' }
    const emptied = anchorActivitySceneTransportPreview({ version: 'activity_scene_v1', final_answer: '<think>plan</think>', terminal_state: 'completed', expanded_by_default: false, activity_rows: [work] })
    expect(emptied).toMatchObject({ final_answer: '', terminal_state: 'no_response', expanded_by_default: true })
    // An explicit outcome, and an answer that keeps its prose, stay as stored.
    expect(anchorActivitySceneTransportPreview({ version: 'activity_scene_v1', final_answer: '<think>plan</think>', terminal_state: 'error', activity_rows: [work] }).terminal_state).toBe('error')
    expect(anchorActivitySceneTransportPreview({ version: 'activity_scene_v1', final_answer: '<think>plan</think>Done.', terminal_state: 'completed', expanded_by_default: false, activity_rows: [work] })).toMatchObject({ terminal_state: 'completed', expanded_by_default: false })
  })
})

describe('withTurnIds', () => {
  it('keeps stamped ids and opens legacy turns only at user rows the reader sees', () => {
    const rows = withTurnIds([
      { role: 'assistant', content: 'Greeting' },
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'One', finish_reason: 'stop' },
      { role: 'user', content: '' },
      { role: 'user', content: '[CONTEXT COMPACTION] summary' },
      { role: 'assistant', content: 'Two', finish_reason: 'stop' },
      { role: 'user', content: 'Stamped', _turn_id: 'run-1' },
      { role: 'assistant', content: 'Three', _turn_id: 'run-1' },
      { role: 'assistant', content: 'CLI row appended after the turn' },
      { role: 'user', content: '', attachments: [{ name: 'a.png' }] },
      { role: 'assistant', content: 'Four' },
    ]).map((m) => m._turn_id)
    expect(rows).toEqual(['legacy:start', 'legacy:1', 'legacy:1', 'legacy:1', 'legacy:1', 'legacy:1', 'run-1', 'run-1', 'run-1', 'legacy:9', 'legacy:9'])
  })

  it('shows a stored Agent steer delivery as a steer inside its turn', () => {
    const rows = withTurnIds<Json>([
      { role: 'user', content: 'Check the date' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't' }] },
      { role: 'tool', tool_call_id: 't', content: 'Thu' },
      { role: 'user', content: '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position]\nMention the weekday\n[/OUT-OF-BAND USER MESSAGE]' },
      { role: 'user', content: 'Plain steer text', display_kind: 'steer' },
      { role: 'assistant', content: 'Thursday.' },
    ])
    expect(rows.map((m) => [m._turn_id, m.content, (m._steer as Json | undefined)?.steer_id ?? null])).toEqual([
      ['legacy:0', 'Check the date', null], ['legacy:0', '', null], ['legacy:0', 'Thu', null],
      ['legacy:0', 'Mention the weekday', 'agent:3'], ['legacy:0', 'Plain steer text', 'agent:4'], ['legacy:0', 'Thursday.', null],
    ])
    const scene = buildTurnScene(turnOf(rows))!
    expect((scene.activity_rows as Json[]).filter((r) => r.role === 'steering').map((r) => r.text)).toEqual(['Mention the weekday', 'Plain steer text'])
    expect(scene.final_answer).toBe('Thursday.')
  })
})

const turnOf = (rows: Json[]): [Json, number][] => rows.map((m, i) => [m, i])
const commentaryItem = (text: string) => ({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }] })

describe('buildTurnScene', () => {
  it('keeps the result view its full result decided, and decides one for a row stored without it (TAL-315)', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Show the path' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'terminal', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'p1', content: 'C:\\new\\table' },
      { role: 'assistant', content: 'Done.' },
    ]))!
    // Text that is not JSON shows exactly as written, after every normalization the row passes through.
    expect(anchorActivitySceneTransportPreview(scene).activity_rows).toMatchObject([{ tool: { id: 'p1', result_view: { text: 'C:\\new\\table' } } }])
    const stored = normalizeSceneRows([{ role: 'tool', tool: { id: 's1', name: 'terminal', result: '{"output": "a\\\\nb", "exit_code": 3}' } }])
    expect(stored[0]?.tool?.result_view).toEqual({ stdout: 'a\nb', exit_code: 3 })
  })

  it('orders each step as reasoning, prose, tools and keeps the one final answer out of the rows', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Check' },
      { role: 'assistant', id: 1, content: 'Reading a.', reasoning: 'Plan', reasoning_titles: ['Planning'], tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'A' },
      { role: 'assistant', id: 2, content: '<think>compare</think>Reading b.', tool_calls: [{ id: 'b', name: 'read_file', args: { path: 'b' }, is_error: true }] },
      { role: 'tool', tool_call_id: 'b', content: 'missing' },
      { role: 'assistant', id: 3, content: 'Both checked.', _turnDuration: 4.5 },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [r.row_id, r.role, r.text ?? (r.tool as Json).result])).toEqual([
      ['1:reasoning', 'reasoning', 'Plan'], ['1:prose', 'prose', 'Reading a.'], ['tool:a', 'tool', 'A'],
      ['2:thinking', 'reasoning', 'compare'], ['2:prose', 'prose', 'Reading b.'], ['tool:b', 'tool', 'missing'],
    ])
    expect((scene.activity_rows as Json[])[0]?.titles).toEqual(['Planning'])
    expect(((scene.activity_rows as Json[])[5]?.tool as Json).is_error).toBe(true)
    expect(scene).toMatchObject({ final_answer: 'Both checked.', terminal_state: 'completed', expanded_by_default: false, turn_duration: 4.5 })
  })

  it('reads Codex commentary from a turn persisted before the settle path kept it', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'assistant', content: '', reasoning: 'Plan.\n\nReading both files.', codex_message_items: [commentaryItem('Reading both files.'), { ...commentaryItem('scratch'), phase: 'analysis' }], tool_calls: [{ id: 'c', name: 'read_file' }] },
      { role: 'tool', tool_call_id: 'c', content: 'port = 8080' },
      { role: 'assistant', content: 'Port 8080.' },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [r.role, r.text ?? null])).toEqual([['reasoning', 'Plan.'], ['prose', 'Reading both files.'], ['tool', null]])
  })

  it('keeps content-array tool_use blocks in order with their text', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', id: 1, content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'w', name: 'weather', input: { city: 'Berlin' } }, { type: 'text', text: 'Then more.' }] },
      { role: 'tool', tool_use_id: 'w', content: '18C' },
      { role: 'assistant', id: 2, content: [{ type: 'tool_use', id: 'x', name: 'weather', input: {} }] },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [r.row_id, r.text ?? (r.tool as Json).result])).toEqual([
      ['1:prose', 'Checking.'], ['tool:w', '18C'], ['1:prose:2', 'Then more.'], ['tool:x', null],
    ])
    expect(((scene.activity_rows as Json[])[1]?.tool as Json)).toMatchObject({ name: 'weather', args: { city: 'Berlin' } })
    expect(scene).toMatchObject({ final_answer: '', terminal_state: 'no_response' })
  })

  it('reads structured reasoning blocks as reasoning, never as prose or the answer', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Where am I?' },
      { role: 'assistant', id: 1, content: [{ type: 'reasoning', text: 'Inspect the workspace.' }, { type: 'tool_use', id: 't', name: 'terminal', input: { command: 'pwd' } }] },
      { role: 'tool', tool_use_id: 't', content: '/work' },
      { role: 'assistant', id: 2, content: [{ type: 'thinking', thinking: 'It printed /work.' }, { type: 'text', text: 'You are in /work.' }] },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [r.role, r.text ?? (r.tool as Json).result])).toEqual([
      ['reasoning', 'Inspect the workspace.'], ['tool', '/work'], ['reasoning', 'It printed /work.'],
    ])
    expect(scene.final_answer).toBe('You are in /work.')
  })

  it('keeps reasoning blocks in place among text and tool_use blocks', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Go' },
      { role: 'assistant', id: 1, content: [{ type: 'text', text: 'Listing.' }, { type: 'tool_use', id: 'a', name: 'ls', input: {} }, { type: 'thinking', thinking: 'Now read it.' }, { type: 'tool_use', id: 'b', name: 'cat', input: {} }] },
      { role: 'assistant', id: 2, content: 'Read.' },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [r.role, r.text ?? (r.tool as Json).id])).toEqual([
      ['prose', 'Listing.'], ['tool', 'a'], ['reasoning', 'Now read it.'], ['tool', 'b'],
    ])
  })

  it('keeps reasoning blocks in place in structured content without tool calls', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Go' },
      { role: 'assistant', id: 1, content: [{ type: 'text', text: 'First look.' }, { type: 'thinking', thinking: 'Hmm.' }, { type: 'text', text: 'Then this.' }] },
      { role: 'assistant', id: 2, content: [{ type: 'thinking', thinking: 'Wrap up.' }, { type: 'text', text: 'Answer.' }] },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [r.role, r.text])).toEqual([
      ['prose', 'First look.'], ['reasoning', 'Hmm.'], ['prose', 'Then this.'], ['reasoning', 'Wrap up.'],
    ])
    expect(scene.final_answer).toBe('Answer.')
  })

  it('reads tool_result blocks from a user row as their calls\' results', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Search' },
      { role: 'assistant', id: 1, content: [{ type: 'tool_use', id: 'f', name: 'search_files', input: {} }, { type: 'tool_use', id: 'w', name: 'web_search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f', content: 'Timed out after 60s', is_error: true }, { type: 'tool_result', tool_use_id: 'w', content: [{ type: 'text', text: 'Live web result' }] }] },
      { role: 'assistant', id: 2, content: 'Search finished.' },
    ]))!
    expect((scene.activity_rows as Json[]).map((r) => [(r.tool as Json).id, (r.tool as Json).result, (r.tool as Json).is_error])).toEqual([
      ['f', 'Timed out after 60s', true], ['w', 'Live web result', false],
    ])
    expect(scene.final_answer).toBe('Search finished.')
  })

  it('reads a final answer stored as Responses-style output_text parts', () => {
    const scene = buildTurnScene(turnOf([
      { role: 'user', content: 'Done?' },
      { role: 'assistant', content: [{ type: 'output_text', output_text: 'Finished.' }] },
    ]))!
    expect(scene).toMatchObject({ final_answer: 'Finished.', terminal_state: 'completed' })
  })

  it.each([
    ['tool-only', [{ role: 'assistant', content: 'Working', tool_calls: [{ id: 't' }] }], 'no_response', true],
    ['interim', [{ role: 'assistant', content: 'Still going', _interim: true }], 'no_response', true],
    ['partial', [{ role: 'assistant', content: 'Half an ans', _partial: true }], 'no_response', true],
    ['error', [{ role: 'assistant', content: 'Working', tool_calls: [{ id: 't' }] }, { role: 'assistant', content: '**Error:** failed', _error: true }], 'error', true],
    ['cancelled', [{ role: 'assistant', content: 'Half', _partial: true }, { role: 'assistant', content: '', _error: true, _terminal_state: 'cancelled' }], 'cancelled', false],
    ['cancelled (pre-TAL-364 copy)', [{ role: 'assistant', content: 'Half', _partial: true }, { role: 'assistant', content: '**Task cancelled:** Task cancelled.', _error: true, provider_details_label: 'Cancellation details' }], 'cancelled', false],
    ['interrupted', [{ role: 'assistant', content: 'Half', _partial: true }, { role: 'assistant', content: '**Interrupted:** lost', _error: true, provider_details_label: 'Interruption details' }], 'interrupted', false],
  ])('reports %s turns without promoting work to an answer', (_name, rows, state, expanded) => {
    const scene = buildTurnScene(turnOf(rows))!
    expect(scene.terminal_state).toBe(state)
    expect(scene.expanded_by_default).toBe(expanded)
    // A Stop shows one status: an older row's "Task cancelled" copy is no answer either.
    if (state === 'no_response' || state === 'cancelled') expect(scene.final_answer).toBe('')
  })

  it('builds nothing for a turn without an assistant row', () => {
    expect(buildTurnScene(turnOf([{ role: 'user', content: 'Hi' }]))).toBeNull()
  })
})

describe('running turn scenes (TAL-374)', () => {
  const rows = (scene: unknown): unknown[][] => ((scene as Json).activity_rows as Json[]).map((r) => [r.role, r.text ?? (r.tool as Json).name])
  const transcript = withTurnIds<Json>([
    { role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Earlier answer.' },
    { role: 'user', content: 'Read it', _turn_id: 'run-1' },
    { role: 'assistant', content: 'Reading.', reasoning: 'Plan the read.', tool_calls: [{ id: 't1', name: 'read_file' }], _turn_id: 'run-1' },
    { role: 'tool', tool_call_id: 't1', content: 'A', _turn_id: 'run-1' },
    { role: 'assistant', content: 'Halfway there.', _turn_id: 'run-1' },
  ])

  it('keeps every persisted row of the running turn in order, with no answer and an open, outcome-free scene', () => {
    const scene = buildTurnScene(turnOf(transcript.slice(2)), { running: true })
    expect(rows(scene)).toEqual([['reasoning', 'Plan the read.'], ['prose', 'Reading.'], ['tool', 'read_file'], ['prose', 'Halfway there.']])
    expect(scene).toMatchObject({ final_answer: '', terminal_state: 'running', expanded_by_default: true })
  })

  it('gives the running turn a scene only when its run has no journal to replay it, and leaves settled turns alone', () => {
    const scenes = (opts: { runningScene?: boolean }) => (hydrateAnchorActivityScenes(transcript, {}, { activeTurnId: 'run-1', ...opts }) as Json[]).map((m) => m._anchor_activity_scene as Json | undefined)
    const unjournaled = scenes({ runningScene: true })
    expect(unjournaled[5]).toMatchObject({ terminal_state: 'running', final_answer: '', expanded_by_default: true, activity_rows_total: 4 })
    expect(rows(unjournaled[5])).toEqual([['reasoning', 'Plan the read.'], ['prose', 'Reading.'], ['tool', 'read_file'], ['prose', 'Halfway there.']])
    expect(unjournaled[3]).toBeUndefined()
    const journaled = scenes({})
    expect(journaled.slice(2).every((scene) => scene === undefined)).toBe(true)
    expect(unjournaled[1]).toEqual(journaled[1])
    expect(journaled[1]).toMatchObject({ final_answer: 'Earlier answer.', terminal_state: 'completed' })
  })
})

describe('anchor scenes over HTTP', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('serves the shared running-scene example exactly: a run with no journal ships its persisted rows open (TAL-374)', async () => {
    const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Json).running_scene_session as Json
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = fixture.stored as Json[]
    session.active_stream_id = String(fixture.active_stream_id)
    s.deps.sessionStore.save(session)
    s.deps.registry.liveIds.add(session.active_stream_id)
    try {
      const detail = (await json(await s.get(`/api/session?session_id=${sid}&messages=1&msg_limit=50`))).session as Json
      expect(detail).toMatchObject({ active_stream_id: fixture.active_stream_id, is_streaming: true, transcript_seq: null })
      expect(detail.messages).toEqual(fixture.messages)
    } finally {
      s.deps.registry.liveIds.delete(session.active_stream_id)
    }
  })

  it('serves the same normalized rows in the detail preview and the paged rows, and never rewrites the stored scene', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'Check' }, { role: 'assistant', content: 'Done.' }]
    s.deps.sessionStore.save(session)
    const rows = Array.from({ length: 90 }, (_, i) => ({ row_id: `r${String(i)}`, order_index: 89 - i, role: 'thinking', text: `step ${String(89 - i)}` }))
    expect((await post(s, '/api/session/anchor-scene', { session_id: sid, message_index: 1, scene: { version: 'activity_scene_v1', final_answer: 'Done.', activity_rows: [...rows, ...legacyRows] } })).status).toBe(200)
    const stored = readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')

    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const scene = (detail.messages as Json[])[1]?._anchor_activity_scene as Json
    // Both the preview and the paged rows carry each tool's server kind and target.
    const normalized = normalizeSceneRows([...rows, ...legacyRows])
    const all = withSceneToolDisplay(normalized, normalized, true)
    expect(scene).toMatchObject({ activity_rows_total: all.length, activity_rows_offset: all.length - 80, activity_rows_complete: false })
    expect(scene.activity_rows).toEqual(all.slice(-80))

    const page = await json(await s.get(`/api/session/anchor-scene?session_id=${sid}&message_index=1&before=${String(all.length - 80)}&limit=80`))
    expect(page).toMatchObject({ start: 0, end: all.length - 80, total: all.length, complete: true })
    expect(page.rows).toEqual(all.slice(0, all.length - 80))
    expect((page.rows as Json[])[0]).toMatchObject({ role: 'reasoning', text: 'step 0', order_index: 0 })
    expect(readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')).toBe(stored)
  })

  it('redacts credentials in paged rows like the preview', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    const secret = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const calls = Array.from({ length: 90 }, (_, i) => [
      { role: 'assistant', content: '', tool_calls: [{ id: `t${String(i)}`, name: 'terminal' }], _turn_id: 'run' },
      { role: 'tool', tool_call_id: `t${String(i)}`, content: i === 0 ? `export KEY=${secret}` : 'ok', _turn_id: 'run' },
    ]).flat()
    session.messages = [{ role: 'user', content: 'Go', _turn_id: 'run' }, ...calls, { role: 'assistant', content: 'Done.', _turn_id: 'run' }]
    s.deps.sessionStore.save(session)
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const scene = (detail.messages as Json[]).at(-1)?._anchor_activity_scene as Json
    const page = await json(await s.get(`/api/session/anchor-scene?session_id=${sid}&message_index=${String((detail.messages as Json[]).length - 1)}&before=${String(scene.activity_rows_offset)}&limit=80`))
    const first = (page.rows as Json[])[0]?.tool as Json
    expect(first.id).toBe('t0')
    expect(JSON.stringify(page)).not.toContain(secret)
  })

  it('gives legacy rows the same turn ids in every window', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = Array.from({ length: 6 }, (_, i) => [{ role: 'user', content: `Q${String(i)}` }, { role: 'assistant', content: `A${String(i)}`, finish_reason: 'stop' }, { role: 'assistant', content: `A${String(i)} again`, finish_reason: 'stop' }]).flat()
    s.deps.sessionStore.save(session)
    const ids = async (query: string) => Object.fromEntries((((await json(await s.get(`/api/session?session_id=${sid}${query}`))).session as Json).messages as Json[]).map((m) => [String(m.content), m._turn_id]))
    const full = await ids('')
    expect(full.A2).toBe('legacy:6')
    expect(full['A2 again']).toBe('legacy:6')
    expect(await ids('&msg_limit=4')).toMatchObject({ 'A5': full.A5, 'A5 again': full['A5 again'] })
    expect(await ids('&msg_limit=4&msg_before=9')).toMatchObject({ 'A2': 'legacy:6', 'A2 again': 'legacy:6' })
  })

  it('builds settled turns\' scenes identically in every window, and pages them', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    const work = Array.from({ length: 45 }, (_, i) => [
      { role: 'assistant', content: `step ${String(i)}`, tool_calls: [{ id: `c${String(i)}`, name: 'read_file' }], _turn_id: 'run-1' },
      { role: 'tool', tool_call_id: `c${String(i)}`, content: `r${String(i)}`, _turn_id: 'run-1' },
    ]).flat()
    session.messages = [
      { role: 'user', content: 'Old question' }, { role: 'assistant', content: 'Old answer' },
      { role: 'user', content: 'Long task', _turn_id: 'run-1' }, ...work, { role: 'assistant', content: 'All done.', _turn_id: 'run-1' },
      { role: 'user', content: 'Next', _turn_id: 'run-2' }, { role: 'assistant', content: 'Streaming…', _turn_id: 'run-2' },
    ]
    session.active_stream_id = 'run-2'
    session.pending_started_at = Date.now() / 1000
    session.pending_user_message = 'Next'
    s.deps.sessionStore.save(session)
    const stored = readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')
    const load = async (query: string) => ((await json(await s.get(`/api/session?session_id=${sid}${query}`))).session as Json).messages as Json[]
    const full = await load('')
    const doneIndex = full.findIndex((m) => m.content === 'All done.')
    const scene = full[doneIndex]?._anchor_activity_scene as Json
    expect(scene).toMatchObject({ final_answer: 'All done.', activity_rows_total: 90, activity_rows_offset: 10, activity_rows_complete: false })
    expect(full[1]?._anchor_activity_scene).toMatchObject({ final_answer: 'Old answer', activity_rows: [] })
    // The running turn has no journal to replay it, so its persisted rows ship as an open running scene (TAL-374).
    expect(full.at(-1)?._anchor_activity_scene).toMatchObject({ terminal_state: 'running', final_answer: '', expanded_by_default: true, activity_rows: [{ role: 'prose', text: 'Streaming…' }] })
    const windowed = await load('&msg_limit=3')
    expect(windowed.find((m) => m.content === 'All done.')?._anchor_activity_scene).toEqual(scene)
    const page = await json(await s.get(`/api/session/anchor-scene?session_id=${sid}&message_ref=${String(scene.activity_scene_ref)}&message_index=${String(doneIndex)}&before=10`))
    expect(page).toMatchObject({ start: 0, end: 10, total: 90, complete: true })
    expect((page.rows as Json[]).map((r) => r.row_id)).toEqual(['i3:prose', 'tool:c0', 'i5:prose', 'tool:c1', 'i7:prose', 'tool:c2', 'i9:prose', 'tool:c3', 'i11:prose', 'tool:c4'])
    expect(readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')).toBe(stored)
  })

  it('completes stored legacy scenes: the final answer leaves the rows, and a consumed steer is never promoted', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [
      { role: 'user', content: 'Check' }, { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Again' }, { role: 'assistant', content: 'Stopping as asked.' },
    ]
    s.deps.sessionStore.save(session)
    const save = (index: number, rows: Json[]) => post(s, '/api/session/anchor-scene', { session_id: sid, message_index: index, scene: { version: 'activity_scene_v1', activity_rows: rows } })
    expect((await save(1, [{ row_id: 'p', role: 'prose', text: 'Progress' }, { role: 'tool', tool_call_id: 't', status: 'completed', tool: { name: 'read_file' } }, { row_id: 'f', role: 'prose', text: ' Done. ' }])).status).toBe(200)
    expect((await save(3, [{ row_id: 'p2', role: 'prose', text: 'Working' }, { role: 'steering', status: 'consumed', text: 'Stop now', payload: { steer_id: 's' } }])).status).toBe(200)
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages[1]?._anchor_activity_scene).toMatchObject({ final_answer: 'Done.', terminal_state: 'completed', expanded_by_default: false, activity_rows_total: 2 })
    expect(((messages[1]?._anchor_activity_scene as Json).activity_rows as Json[]).map((r) => r.row_id)).toEqual(['p', 'tool:t'])
    expect(messages[3]?._anchor_activity_scene).toMatchObject({ terminal_state: 'no_response', expanded_by_default: true, activity_rows_total: 2 })
    // Present and empty, so every client reads the same "no answer" instead of an older server's fallback.
    expect((messages[3]?._anchor_activity_scene as Json).final_answer).toBe('')
  })

  it('ships each settled turn\'s file changes from its own calls, never from a stored scene', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [
      { role: 'user', content: 'Edit', _turn_id: 'run-edit' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'w', function: { name: 'write_file', arguments: '{"path": "./src/a.swift", "content": "x"}' } },
        { id: 'm', name: 'mcp_filesystem_move_file', args: { source: 'old.swift', destination: 'new.swift' } },
        { id: 'r', name: 'read_file', args: { path: 'src/b.swift' } },
      ], _turn_id: 'run-edit' },
      { role: 'assistant', content: 'Edited.', _turn_id: 'run-edit' },
      { role: 'user', content: 'Chat', _turn_id: 'run-chat' },
      { role: 'assistant', content: 'Hi.', _turn_id: 'run-chat' },
      { role: 'user', content: 'Delete', _turn_id: 'run-delete' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'd', name: 'delete_file', args: { path: 'c.swift' } }], _turn_id: 'run-delete' },
    ]
    s.deps.sessionStore.save(session)
    // A client-posted scene cannot claim changes its turn never made.
    expect((await post(s, '/api/session/anchor-scene', { session_id: sid, message_index: 4, scene: { version: 'activity_scene_v1', activity_rows: [], file_changes: [{ path: 'forged', action: 'added' }] } })).status).toBe(200)
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    const settled = messages.map((m) => (m._anchor_activity_scene as Json | undefined)?.file_changes)
    expect(settled[2]).toEqual([{ path: 'src/a.swift', action: 'edited' }, { path: 'new.swift', action: 'renamed' }])
    expect(settled[4]).toEqual([])
    expect(settled[6]).toEqual([{ path: 'c.swift', action: 'deleted' }])
  })

  it('keeps full tool results in scenes, clipping them only in a limited response like raw tool rows', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    const big = 'x'.repeat(6000)
    session.messages = [
      { role: 'user', content: 'Dump it', _turn_id: 'run-big' },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'big', name: 'read_file' }], _turn_id: 'run-big' },
      { role: 'tool', tool_call_id: 'big', content: big, _turn_id: 'run-big' },
      { role: 'assistant', content: 'Done.', _turn_id: 'run-big' },
    ]
    s.deps.sessionStore.save(session)
    const toolResult = async (query: string) => {
      const messages = ((await json(await s.get(`/api/session?session_id=${sid}${query}`))).session as Json).messages as Json[]
      const scene = messages.at(-1)?._anchor_activity_scene as Json
      return String(((scene.activity_rows as Json[]).find((r) => r.role === 'tool')?.tool as Json).result)
    }
    expect(await toolResult('')).toBe(big)
    const limited = await toolResult('&msg_limit=10')
    expect(limited.length).toBeLessThan(big.length)
    expect(limited).toContain('Tool output truncated')
    const page = await json(await s.get(`/api/session/anchor-scene?session_id=${sid}&message_index=3`))
    expect(((page.rows as Json[]).find((r) => r.role === 'tool')?.tool as Json).result).toBe(big)
  })

  it('flags a clipped tool row and serves its full, redacted result by call id (TAL-331)', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    const secret = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    // The credential sits past both caps, so only the full result can leak it.
    const full = `${'x'.repeat(5000)} KEY=${secret} ${'y'.repeat(6000 - 5006 - secret.length)}`
    session.messages = [
      { role: 'user', content: 'Dump it', _turn_id: 'run-big' },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'big', name: 'read_file' }, { id: 'small', name: 'read_file' }], _turn_id: 'run-big' },
      { role: 'tool', tool_call_id: 'big', content: full, _turn_id: 'run-big' },
      { role: 'tool', tool_call_id: 'small', content: 'ok', _turn_id: 'run-big' },
      { role: 'assistant', content: 'Done.', _turn_id: 'run-big' },
    ]
    s.deps.sessionStore.save(session)
    const tool = async (query: string, id: string) => {
      const messages = ((await json(await s.get(`/api/session?session_id=${sid}${query}`))).session as Json).messages as Json[]
      return ((messages.at(-1)?._anchor_activity_scene as Json).activity_rows as Json[]).find((r) => (r.tool as Json | undefined)?.id === id)?.tool as Json
    }
    expect(full.length).toBe(6000)
    const limited = await tool('&msg_limit=10', 'big')
    expect(limited).toMatchObject({ result_truncated: true, result_chars: 6000 })
    expect(String(limited.result).length).toBeLessThan(6000)
    // The full detail keeps the whole result; the view clients show is capped (TAL-315), so the row is flagged there too.
    const whole = await tool('', 'big')
    expect(String(whole.result).length).toBeGreaterThan(5000)
    expect(String(whole.result)).not.toContain(secret)
    expect(whole).toMatchObject({ result_truncated: true, result_chars: 6000 })
    expect(String((whole.result_view as Json).text).length).toBeLessThan(String(whole.result).length)
    expect((await tool('&msg_limit=10', 'small')).result_truncated).toBeUndefined()
    const res = await s.get(`/api/session/tool-result?session_id=${sid}&tool_call_id=big`)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ tool_call_id: 'big', result: whole.result, result_view: { text: whole.result } })
    expect(JSON.stringify(body)).not.toContain(secret)
    expect((await s.get(`/api/session/tool-result?session_id=${sid}&tool_call_id=missing`)).status).toBe(404)
  })

  it('flags a capped row of a scene stored before TAL-331 from its rebuilt turn, in the preview and the paged rows', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    const full = 'z'.repeat(6000)
    session.messages = [
      { role: 'user', content: 'Dump it' },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'big', name: 'read_file' }, { id: 'small', name: 'read_file' }] },
      { role: 'tool', tool_call_id: 'big', content: full },
      { role: 'tool', tool_call_id: 'small', content: 'ok' },
      { role: 'assistant', content: 'Done.' },
    ]
    s.deps.sessionStore.save(session)
    // An older client's stored scene: whole results, no flags.
    const old = (id: string, result: string, order_index: number) => ({ row_id: `tool:${id}`, order_index, role: 'tool', tool: { id, name: 'read_file', result, done: true } })
    const filler = Array.from({ length: 85 }, (_, i) => ({ row_id: `r${String(i)}`, order_index: 2 + i, role: 'reasoning', text: `step ${String(i)}` }))
    expect((await post(s, '/api/session/anchor-scene', { session_id: sid, message_index: 4, scene: { version: 'activity_scene_v1', final_answer: 'Done.', activity_rows: [old('big', full, 0), old('small', 'ok', 1), ...filler] } })).status).toBe(200)
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const scene = (detail.messages as Json[]).at(-1)?._anchor_activity_scene as Json
    expect(scene.activity_rows_offset).toBe(7)
    // The two tool rows are paged out of the 80-row preview; the paged rows carry the rebuilt turn's flag.
    const page = await json(await s.get(`/api/session/anchor-scene?session_id=${sid}&message_index=4&before=7`))
    const tool = (id: string) => (page.rows as Json[]).find((r) => r.row_id === `tool:${id}`)?.tool as Json
    expect(tool('big')).toMatchObject({ result_truncated: true, result_chars: 6000 })
    expect(tool('small').result_truncated).toBeUndefined()
    // The same rows in a short scene sit in the preview itself.
    expect((await post(s, '/api/session/anchor-scene', { session_id: sid, message_index: 4, scene: { version: 'activity_scene_v1', final_answer: 'Done.', activity_rows: [old('big', full, 0), old('small', 'ok', 1)] } })).status).toBe(200)
    const short = ((await json(await s.get(`/api/session?session_id=${sid}&msg_limit=10`))).session as Json).messages as Json[]
    const rows = (short.at(-1)?._anchor_activity_scene as Json).activity_rows as Json[]
    expect(rows.find((r) => r.row_id === 'tool:big')?.tool).toMatchObject({ result_truncated: true, result_chars: 6000 })
    expect((rows.find((r) => r.row_id === 'tool:small')?.tool as Json).result_truncated).toBeUndefined()
  })
})
