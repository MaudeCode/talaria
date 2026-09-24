/** Anchor activity scenes: one normalized row shape for both clients, identical in the detail preview and the paged rows. */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { normalizeSceneRows, withTurnIds } from './anchor.js'

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
    expect(rows[4]?.steering).toEqual({ steer_id: 's1', consumed: false, submitted_at: 3, consumed_at: null })
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

  it('returns no rows for a malformed list', () => {
    expect(normalizeSceneRows(null)).toEqual([])
    expect(normalizeSceneRows({ rows: [] })).toEqual([])
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
    expect(full['A2']).toBe('legacy:6')
    expect(full['A2 again']).toBe('legacy:6')
    expect(await ids('&msg_limit=4')).toMatchObject({ 'A5': full['A5'], 'A5 again': full['A5 again'] })
    expect(await ids('&msg_limit=4&msg_before=9')).toMatchObject({ 'A2': 'legacy:6', 'A2 again': 'legacy:6' })
  })
})
