import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SessionSchema } from '@maudecode/talaria-web-contracts'
import { SidecarError } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, openStateDb, type TestServer } from '../test/harness.js'
import agentSchema from '../test/fixtures/canonical-ownership.json' with { type: 'json' }
import { useJsonStorage } from '../test/storage.js'

useJsonStorage()

type Json = Record<string, unknown>

describe('a delegated child\'s transcript follows its run (TAL-1760)', () => {
  let s: TestServer
  let db: DatabaseSync
  let parent: string
  let sidecar: FakeSidecar
  let nextId = 0
  const fresh = (): string => `child-${String(nextId += 1)}`

  const row = (id: string, source: string, extra: { parent?: string; ended_at?: number; end_reason?: string } = {}): void => {
    db.prepare('INSERT INTO sessions (id, source, started_at, title, model, message_count, parent_session_id, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, source, 1000, `${id} title`, 'fixture-model', 6, extra.parent ?? null, extra.ended_at ?? null, extra.end_reason ?? null)
  }
  /** An answered turn, then a long unfinished one whose latest interim reply is not its answer and whose last call has no result. */
  const transcript = (sid: string): void => {
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, tool_calls, tool_call_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const call = (id: string): string => JSON.stringify([{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }])
    insert.run(sid, 'user', 'Survey the repo', 1001, null, null, null)
    insert.run(sid, 'assistant', 'Surveyed.', 1002, null, null, null)
    insert.run(sid, 'user', 'Now fix the bug', 1003, null, null, null)
    insert.run(sid, 'assistant', '', 1004, call(`${sid}-a`), null, null)
    insert.run(sid, 'tool', 'file body', 1005, null, `${sid}-a`, 'read_file')
    insert.run(sid, 'assistant', 'Reading the next file.', 1006, call(`${sid}-b`), null, null)
  }
  const child = (source: string, extra: { ended_at?: number; end_reason?: string } = {}): string => {
    const sid = fresh()
    row(sid, source, { parent, ...extra })
    transcript(sid)
    return sid
  }
  /** The parent's ledger, as the Agent reports it through `process.background_list`. */
  const delegation = (children: string[], state: 'running' | 'completed' = 'running'): void => {
    sidecar.respond('process.background_list', (params) => ({
      delegations: params.session_ids.includes(parent) ? [{
        delegation_id: `call-${children.join('-')}`, origin_ui_session_id: parent, state, dispatched_at: 900, completed_at: state === 'running' ? null : 2000, updated_at: 950,
        goals: children.map((c) => `Goal of ${c}`), child_statuses: state === 'running' ? [] : children.map(() => 'completed'), has_result: state !== 'running', live_status: state === 'running' ? 'running' : null,
        children: children.map((c) => ({ goal: `Goal of ${c}`, session_id: c })),
      }] : [],
      processes: [],
    }))
  }
  const detail = async (sid: string, query = '&messages=1&msg_limit=120'): Promise<Json> => {
    const res = await s.get(`/api/session?session_id=${sid}${query}`)
    expect(res.status).toBe(200)
    return SessionSchema.parse(((await res.json()) as Json).session)
  }
  const scenes = (session: Json): Json[] => (session.messages as Json[]).flatMap((m) => (m._anchor_activity_scene ? [m._anchor_activity_scene as Json] : []))

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = openStateDb(join(s.state, 'state.db'))
    db.exec(agentSchema.schema.join('\n'))
    for (const sql of agentSchema.inserts) db.exec(sql)
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    parent = String((((await res.json()) as Json).session as Json).session_id)
    row(parent, 'webui')
    row('no-web-document', 'cli')
  })
  afterAll(async () => { db.close(); await s.close() })
  beforeEach(() => { delegation([]) })

  it.each(['subagent', 'tool'])('ships a %s child whose delegation is live as running, with its last turn open', async (source) => {
    const sid = child(source)
    delegation([sid])
    const session = await detail(sid)
    expect(session.activity_phase).toBe('running')
    expect(session.refresh_after).toBeGreaterThan(0)
    const [earlier, last] = scenes(session)
    expect(earlier).toMatchObject({ terminal_state: 'completed', final_answer: 'Surveyed.' })
    expect(last).toMatchObject({ terminal_state: 'running', final_answer: '', expanded_by_default: true })
    // The interim reply stays in the work, and the call nothing answered yet is still running.
    const rows = last!.activity_rows as Json[]
    expect(rows).toContainEqual(expect.objectContaining({ role: 'prose', text: 'Reading the next file.' }))
    expect(rows.flatMap((r) => (r.tool ? [(r.tool as Json).done] : []))).toEqual([true, false])
  })

  it('decides from a metadata read too, which still says the child runs', async () => {
    const sid = child('subagent')
    delegation([sid])
    expect(await detail(sid, '&messages=0')).toMatchObject({ activity_phase: 'running', refresh_after: expect.any(Number) as number })
  })

  it('settles the moment the child\'s own row ends, however its delegation reads', async () => {
    for (const ended of [{ ended_at: 1500 }, { end_reason: 'completed' }]) {
      const sid = child('subagent', ended)
      delegation([sid])
      const session = await detail(sid)
      expect(session.refresh_after).toBeNull()
      expect(session.activity_phase).toBe('failed')
      expect(scenes(session).at(-1)?.terminal_state).not.toBe('running')
    }
  })

  it('settles a child that never wrote ended_at once its delegation ends', async () => {
    const sid = child('subagent')
    delegation([sid], 'completed')
    const session = await detail(sid)
    expect(session.refresh_after).toBeNull()
    expect(session.activity_phase).toBe('failed')
    expect(scenes(session).at(-1)?.terminal_state).not.toBe('running')
  })

  it('reports the settled answer as completed, the same running read then settled', async () => {
    const sid = child('subagent')
    delegation([sid])
    expect((await detail(sid)).activity_phase).toBe('running')
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'tool', 'next body', 1007)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'assistant', 'Fixed the bug.', 1008)
    db.prepare('UPDATE sessions SET ended_at = 1009, end_reason = ? WHERE id = ?').run('completed', sid)
    delegation([sid], 'completed')
    const settled = await detail(sid)
    expect(settled).toMatchObject({ activity_phase: 'completed', refresh_after: null })
    expect(scenes(settled).at(-1)).toMatchObject({ terminal_state: 'completed', final_answer: 'Fixed the bug.' })
  })

  it('needs a live receipt that lists this child: an unlisted child and a lost delegation stay settled', async () => {
    const sid = child('subagent')
    delegation(['someone-else'])
    expect((await detail(sid)).refresh_after).toBeNull()
    // A delegation the Agent no longer has is unknown, not live; a parent with no Web document has no receipt at all.
    delegation([sid])
    expect((await detail(sid)).refresh_after).toBeGreaterThan(0)
    sidecar.respond('process.background_list', () => { throw new SidecarError('offline', { condition: 'sidecar_unavailable' }) })
    expect((await detail(sid)).refresh_after).toBeNull()
    const orphan = fresh()
    row(orphan, 'subagent', { parent: 'no-web-document' })
    transcript(orphan)
    delegation([orphan])
    expect((await detail(orphan)).refresh_after).toBeNull()
  })

  it('runs a compressed child from its tip: the root holds the parent link, and the delegation may list either segment', async () => {
    const root = child('subagent', { ended_at: 1100, end_reason: 'compression' })
    const tip = `${root}-tip`
    db.prepare('INSERT INTO sessions (id, source, started_at, title, model, message_count, parent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tip, 'subagent', 1101, `${tip} title`, 'fixture-model', 1, root)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(tip, 'assistant', 'Still working.', 1102)
    for (const listed of [root, tip]) {
      delegation([listed])
      expect(await detail(tip), listed).toMatchObject({ activity_phase: 'running', refresh_after: expect.any(Number) as number })
    }
    delegation(['someone-else'])
    expect((await detail(tip)).refresh_after).toBeNull()
  })

  it('never offers a refresh to an ordinary Web session or a CLI, messaging or Kanban import', async () => {
    const res = await s.get(`/api/session?session_id=${parent}&messages=1&msg_limit=120`)
    expect(((await res.json()) as { session: Json }).session.refresh_after).toBeNull()
    for (const source of ['cli', 'telegram', 'kanban']) {
      const sid = child(source)
      delegation([sid])
      const session = await detail(sid)
      expect(session.refresh_after, source).toBeNull()
      expect(session.activity_phase, source).toBeUndefined()
      expect(scenes(session).at(-1)?.terminal_state, source).not.toBe('running')
    }
    // A tool session nothing delegated: no parent link, so no receipt could ever settle it.
    const unlinked = fresh()
    row(unlinked, 'tool')
    transcript(unlinked)
    expect(await detail(unlinked)).not.toHaveProperty('activity_phase')
  })
})
