import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import fixture from '../test/fixtures/local-reset.json' with { type: 'json' }
import { readImportableAgentSessionRows, stateDbCompressionLineage, stateDbLineageReport, stateDbLocalTarget, stateDbSessionMessages, stateDbSessionRead } from './state-db.js'
import { bootTestServer } from '../test/harness.js'
import { Session } from './session.js'
import { FakeSidecar } from '../sidecar/fake.js'

describe('Agent v0.22.1 receipt-backed local reset', () => {
  let dir: string
  let path: string
  let db: DatabaseSync
  const load = (stage: keyof typeof fixture.snapshots) => {
    db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS state_meta')
    const data = fixture.snapshots[stage]
    for (const [table, records] of Object.entries({ sessions: data.sessions, messages: data.messages, state_meta: data.meta })) {
      const columns = Object.keys(records[0]!)
      db.exec(`CREATE TABLE ${table} (${columns.map((c) => `${c} ${['id', 'message_count', 'timestamp', 'started_at', 'ended_at'].includes(c) && !(table === 'sessions' && c === 'id') ? 'NUMERIC' : 'TEXT'}`).join(', ')})`)
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => '?').join(', ')})`)
      for (const record of records) insert.run(...Object.values(record))
    }
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'local-reset-')); path = join(dir, 'state.db')
    db = new DatabaseSync(path)
    load('reset')
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it.each(['reset', 'empty', 'multiple'] as const)('lists the real candidate %s fixture once at its current target', (stage) => {
    load(stage)
    const rows = readImportableAgentSessionRows(path)
    expect(rows.map((r) => r.id)).toEqual(fixture.snapshots[stage].listedIds)
    expect(rows[0]).toMatchObject({ title: 'Reset conversation', source: 'cli', _lineage_root_id: fixture.owner, _lineage_tip_id: fixture.snapshots[stage].listedIds[0] })
    expect(rows[0]?.relationship_type).not.toBe('child_session')
  })

  it('resolves every physical segment to the complete deletion lineage', () => {
    load('multiple')
    const ids = fixture.snapshots.multiple.sessions.map((r) => r.id)
    for (const id of ids) expect(stateDbCompressionLineage(path, id)).toEqual(ids)
  })

  it('reads only the current reset context when reopening any segment', () => {
    load('multiple')
    for (const row of fixture.snapshots.multiple.sessions) {
      expect(stateDbSessionMessages(path, row.id).map((m) => m.content)).toEqual(['latest context'])
    }
    expect(stateDbSessionRead(path, fixture.owner, { stitch: false, lineage: fixture.snapshots.multiple.sessions.map((r) => r.id) }).rows.map((m) => m.content)).toEqual(['latest context'])
    expect(stateDbLineageReport(path, fixture.owner)).toMatchObject({ lineage_key: fixture.owner, tip_session_id: 'reset-empty', total_segments: 4, manual_review: false })
  })

  it.each(['missing', 'malformed', 'cycle', 'budget', 'foreign', 'fork'] as const)('fails conservatively with a %s receipt', (damage) => {
    const key = `gateway.local_policy.v1:${fixture.owner}`
    const receipt = JSON.parse(fixture.snapshots.reset.meta[0]!.value) as Record<string, unknown>
    if (damage === 'missing') db.prepare('DELETE FROM state_meta WHERE key = ?').run(key)
    else {
      if (damage === 'cycle') receipt.lineage = [fixture.owner, 'reset-one', fixture.owner]
      if (damage === 'budget') receipt.lineage = Array.from({ length: 1001 }, (_, i) => `segment-${i}`)
      if (damage === 'foreign') receipt.principal_id = 'someone-else'
      if (damage === 'fork') db.prepare('UPDATE sessions SET model_config = ? WHERE id = ?').run(JSON.stringify({ _branched_from: fixture.owner }), 'reset-one')
      db.prepare('UPDATE state_meta SET value = ? WHERE key = ?').run(damage === 'malformed' ? '{broken' : JSON.stringify(receipt), key)
    }
    expect(stateDbLocalTarget(path, fixture.owner)).toBe(fixture.owner)
    expect(stateDbCompressionLineage(path, fixture.owner)).toEqual([fixture.owner])
    expect(stateDbSessionMessages(path, fixture.owner).map((m) => m.content)).toEqual(['before reset'])
  })

  it.each(['_branched_from', '_delegate_from', '_reset_from'] as const)('keeps an explicit %s child outside the receipt', (marker) => {
    db.prepare("INSERT INTO sessions (id, source, started_at, message_count, parent_session_id, model_config) VALUES ('separate', 'cli', 1005, 1, ?, ?)").run(fixture.owner, JSON.stringify({ [marker]: fixture.owner }))
    db.exec("INSERT INTO messages VALUES (99, 'separate', 'user', 'separate child', 1005)")
    expect(readImportableAgentSessionRows(path).map((r) => r.id).sort()).toEqual(['reset-one', 'separate'])
    expect(stateDbSessionMessages(path, 'separate').map((m) => m.content)).toEqual(['separate child'])
  })

  it.each(['reset', 'empty', 'multiple'] as const)('serves %s once through list, count, search, detail and reopen', async (stage) => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load(stage)
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.cliSessions.invalidate()
    server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', messages: [{ role: 'user', content: 'stale sidecar context' }, { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'another old turn' }] }, server.deps.sessionStore.deps.defaults('default')))
    const list = await (await server.get('/api/sessions')).json() as { sessions: Record<string, unknown>[]; cli_session_count: number }
    expect(list.sessions.map((r) => r.session_id)).toEqual(fixture.snapshots[stage].listedIds)
    expect(list.cli_session_count).toBe(1)
    const search = await (await server.get('/api/sessions/search?q=Reset%20conversation&show_cli_sessions=1')).json() as { sessions: Record<string, unknown>[] }
    expect(search.sessions.map((r) => r.session_id)).toEqual(fixture.snapshots[stage].listedIds)
    // A saved pre-reset Talaria sidecar must not resurrect its old model context on reopen.
    const expected = stage === 'empty' ? [] : stage === 'reset' ? ['after reset'] : ['latest context']
    for (const row of fixture.snapshots[stage].sessions) {
      const response = await server.get(`/api/session?session_id=${row.id}`)
      const body = await response.json() as { session: { session_id: string; messages: { content: string }[] } }
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.session.session_id).toBe(fixture.snapshots[stage].listedIds[0])
      expect(body.session.messages.map((m) => m.content)).toEqual(expected)
    }
    const reopened = await (await server.get('/api/sessions')).json() as { sessions: Record<string, unknown>[] }
    expect(reopened.sessions.map((r) => r.session_id)).toEqual(fixture.snapshots[stage].listedIds)
  })

  it.each([false, true])('starts a turn at the current target from an old segment with persisted sidecar=%s', async (persisted) => {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    if (persisted) server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', messages: [{ role: 'user', content: 'stale sidecar context' }, { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'another old turn' }] }, server.deps.sessionStore.deps.defaults('default')))
    const response = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner, message: 'continue after reset' }) })
    const started = await response.json() as { session_id: string; stream_id: string }
    expect(response.status, JSON.stringify(started)).toBe(200)
    expect(started.session_id).toBe('reset-empty')
    await server.sse(`/api/chat/stream?stream_id=${started.stream_id}`, (frame) => frame.event === 'stream_end')
    const call = sidecar.calls.find((call) => call.method === 'chat.start')?.params as { session_id: string; conversation_history: { content: string }[] }
    expect(call.session_id).toBe('reset-empty')
    expect(call.conversation_history.map((m) => m.content)).toEqual(['latest context'])
  })

  it('collapses all persisted receipt members while keeping the current sidecar metadata', async () => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    await server.deps.settings.save({ show_cli_sessions: true })
    for (const row of [...fixture.snapshots.multiple.sessions].reverse()) {
      const current = row.id === 'reset-empty'
      server.deps.sessionStore.save(new Session({ session_id: row.id, profile: 'default', source_tag: 'cli', title: current ? 'Current saved title' : 'Old saved title', pinned: current,
        messages: current ? [{ role: 'user', content: 'latest context' }] : [{ role: 'user', content: 'old first' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'old second' }],
      }, server.deps.sessionStore.deps.defaults('default')))
    }
    server.deps.cliSessions.invalidate()
    const list = await (await server.get('/api/sessions')).json() as { sessions: Record<string, unknown>[]; cli_session_count: number }
    expect(list.cli_session_count).toBe(1)
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]).toMatchObject({ session_id: 'reset-empty', title: 'Current saved title', pinned: true, message_count: 1 })
    expect(list.sessions[0]).not.toHaveProperty('_lineage_ids')
  })
})
