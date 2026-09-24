/** Anchor activity scenes: one normalized row shape for both clients, identical in the detail preview and the paged rows. */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { anchorActivitySceneTransportPreview, buildTurnScene, normalizeSceneRows, withTurnIds } from './anchor.js'

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
    expect(rows[1]?.tool).toEqual({ id: 'c1', name: 'terminal', args: { command: 'false' }, preview: 'exit 1', result: 'exit 1', done: true, is_error: true, duration: null, cost_usd: null })
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
    ['cancelled', [{ role: 'assistant', content: 'Half', _partial: true }, { role: 'assistant', content: '**Task cancelled:** Task cancelled.', _error: true, provider_details_label: 'Cancellation details' }], 'cancelled', false],
    ['interrupted', [{ role: 'assistant', content: 'Half', _partial: true }, { role: 'assistant', content: '**Interrupted:** lost', _error: true, provider_details_label: 'Interruption details' }], 'interrupted', false],
  ])('reports %s turns without promoting work to an answer', (_name, rows, state, expanded) => {
    const scene = buildTurnScene(turnOf(rows))!
    expect(scene.terminal_state).toBe(state)
    expect(scene.expanded_by_default).toBe(expanded)
    if (state === 'no_response') expect(scene.final_answer).toBe('')
  })

  it('builds nothing for a turn without an assistant row', () => {
    expect(buildTurnScene(turnOf([{ role: 'user', content: 'Hi' }]))).toBeNull()
  })
})

describe('anchor scenes over HTTP', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

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
    const all = normalizeSceneRows([...rows, ...legacyRows])
    expect(scene).toMatchObject({ activity_rows_total: all.length, activity_rows_offset: all.length - 80, activity_rows_complete: false })
    expect(scene.activity_rows).toEqual(all.slice(-80))

    const page = await json(await s.get(`/api/session/anchor-scene?session_id=${sid}&message_index=1&before=${String(all.length - 80)}&limit=80`))
    expect(page).toMatchObject({ start: 0, end: all.length - 80, total: all.length, complete: true })
    expect(page.rows).toEqual(all.slice(0, all.length - 80))
    expect((page.rows as Json[])[0]).toMatchObject({ role: 'reasoning', text: 'step 0', order_index: 0 })
    expect(readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')).toBe(stored)
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

  it('builds scenes for completed turns only, identically in every window, and pages them', async () => {
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
    expect(full.at(-1)?._anchor_activity_scene).toBeUndefined()
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
    expect((messages[3]?._anchor_activity_scene as Json).final_answer ?? '').toBe('')
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
})
