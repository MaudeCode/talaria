import { sessionPath, useJsonStorage } from '../test/storage.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import fixture from '../test/fixtures/local-reset.json' with { type: 'json' }
import { readImportableAgentSessionRowBatches, readImportableAgentSessionRows, stateDbCompressionLineage, stateDbLineageReport, stateDbLocalTarget, stateDbSessionMessages, stateDbSessionRead } from './state-db.js'
import { bootTestServer, openStateDb } from '../test/harness.js'
import { Session } from './session.js'
import { FakeSidecar } from '../sidecar/fake.js'

useJsonStorage()

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
    db = openStateDb(path)
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

  it('shares one receipt scan and schema probe set across sidebar windows', () => {
    load('multiple')
    for (let i = 0; i < 3; i += 1) {
      const owner = `unrelated-${String(i)}`
      db.prepare('INSERT INTO state_meta VALUES (?, ?)').run(`gateway.local_policy.v1:${owner}`, JSON.stringify({ session_id: owner, entry: { session_id: owner }, lineage: [owner] }))
    }
    const queries = [
      { excludeSources: ['cron', 'webhook', 'kanban'], limit: 20 },
      ...['cron', 'webhook', 'kanban'].map((kind) => ({ excludeSources: null, includeSources: [kind], limit: 201 })),
    ]
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    try {
      const result = readImportableAgentSessionRowBatches(path, queries)
      expect(result.rows[0]).toHaveLength(1)
      expect(result.rows[0]).toMatchObject([{ id: 'reset-empty', _lineage_root_id: fixture.owner }])
      const sql = prepare.mock.calls.map(([sql]) => sql)
      expect(sql.filter((sql) => sql.includes('state_meta WHERE key GLOB'))).toHaveLength(1)
      for (const table of ['sessions', 'messages']) {
        expect(sql.filter((sql) => sql === `PRAGMA table_info(${table})`)).toHaveLength(1)
        expect(sql.filter((sql) => sql === `PRAGMA index_list(${table})`)).toHaveLength(1)
      }
      expect(sql.filter((sql) => sql === "SELECT name FROM sqlite_master WHERE type = 'table'")).toHaveLength(1)
      expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(1)
      expect(result).toEqual({ rows: queries.map((opts) => readImportableAgentSessionRows(path, opts)), storage: { state: 'ok', reason: null } })
    } finally { prepare.mockRestore(); exec.mockRestore() }
  })

  it('keeps each query projection independent when bounded and unbounded activity queries mix', () => {
    db.exec('CREATE INDEX idx_sessions_effective_activity ON sessions(COALESCE(last_activity_at, started_at))')
    const queries = [{ limit: 20 }, { limit: null }, { limit: 0 }, { sessionIds: [fixture.owner], compressionChains: true, keepEmpty: true, limit: null }]
    expect(readImportableAgentSessionRowBatches(path, queries).rows).toEqual(queries.map((opts) => readImportableAgentSessionRows(path, opts)))
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

  it('preserves candidate display and model histories while refusing independent execution', async () => {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('compressed')
    const stage = fixture.snapshots.compressed
    expect(stateDbSessionMessages(path, fixture.owner).map((m) => m.content)).toEqual(stage.displayContents)
    expect(stateDbSessionMessages(path, fixture.owner, { stitch: false }).map((m) => m.content)).toEqual(stage.modelContents)
    const detail = await (await server.get(`/api/session?session_id=${fixture.owner}`)).json() as { session: { messages: { content: string }[] } }
    expect(detail.session.messages.map((m) => m.content)).toEqual(stage.displayContents)
    const response = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner, message: 'continue compressed context' }) })
    expect(response.status, await response.text()).toBe(403)
    expect(sidecar.calls.filter((call) => call.method === 'chat.start')).toEqual([])
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

  it.each(['_branched_from', '_delegate_from', '_reset_from'] as const)('keeps a mismatched %s marker separate without a receipt', (marker) => {
    db.exec("DELETE FROM state_meta; UPDATE sessions SET end_reason = 'compression' WHERE parent_session_id IS NULL")
    db.prepare('UPDATE sessions SET model_config = ? WHERE id = ?').run(JSON.stringify({ [marker]: 'another-logical-owner' }), 'reset-one')
    expect(readImportableAgentSessionRows(path).map((row) => row.id).sort()).toEqual([fixture.owner, 'reset-one'].sort())
    expect(stateDbSessionMessages(path, 'reset-one').map((m) => m.content)).toEqual(['after reset'])
    expect(stateDbCompressionLineage(path, fixture.owner)).toEqual([fixture.owner])
  })

  it('keeps an explicit branch separate while naming its logical parent after multiple resets', () => {
    load('multiple')
    db.prepare("INSERT INTO sessions (id, source, started_at, message_count, parent_session_id, model_config) VALUES ('separate', 'cli', 1005, 1, ?, ?)").run('compressed', JSON.stringify({ _branched_from: 'compressed' }))
    db.exec("INSERT INTO messages VALUES (99, 'separate', 'user', 'branch context', 1005)")
    const rows = readImportableAgentSessionRows(path)
    expect(rows.map((row) => row.id).sort()).toEqual(['reset-empty', 'separate'])
    expect(rows.find((row) => row.id === 'separate')).toMatchObject({ relationship_type: 'child_session', _parent_lineage_root_id: fixture.owner, parent_title: 'Reset conversation', parent_source: 'cli' })
    expect(stateDbSessionMessages(path, 'separate').map((m) => m.content)).toEqual(['branch context'])
  })

  it.each(['reset', 'empty', 'multiple'] as const)('serves %s once through list, count, search, detail and reopen', async (stage) => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load(stage)
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.cliSessions.invalidate()
    await server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', messages: [{ role: 'user', content: 'stale sidecar context' }, { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'another old turn' }] }, (await server.deps.sessionStore.deps.defaults('default'))))
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

  it.each([false, true])('refuses canonical turns from every reset alias with persisted sidecar=%s', async (persisted) => {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    if (persisted) (await server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', messages: [{ role: 'user', content: 'stale sidecar context' }, { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'another old turn' }] }, (await server.deps.sessionStore.deps.defaults('default')))))
    const before = db.prepare('SELECT * FROM messages').all()
    for (const row of fixture.snapshots.multiple.sessions) {
      const response = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: row.id, message: 'continue after reset' }) })
      expect(response.status, await response.text()).toBe(403)
    }
    expect(sidecar.calls.filter((call) => call.method === 'chat.start')).toEqual([])
    expect(db.prepare('SELECT * FROM messages').all()).toEqual(before)
    expect(existsSync(sessionPath(server.deps.sessionStore, 'reset-empty'))).toBe(false)
  })

  it('collapses all persisted receipt members while keeping the current sidecar metadata', async () => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    await server.deps.settings.save({ show_cli_sessions: true })
    for (const row of [...fixture.snapshots.multiple.sessions].reverse()) {
      const current = row.id === 'reset-empty'
      ;(await server.deps.sessionStore.save(new Session({ session_id: row.id, profile: 'default', source_tag: 'cli', title: current ? 'Current saved title' : 'Old saved title', pinned: current,
        messages: current ? [{ role: 'user', content: 'latest context' }] : [{ role: 'user', content: 'old first' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'old second' }],
      }, (await server.deps.sessionStore.deps.defaults('default')))))
    }
    server.deps.cliSessions.invalidate()
    const list = await (await server.get('/api/sessions')).json() as { sessions: Record<string, unknown>[]; cli_session_count: number }
    expect(list.cli_session_count).toBe(1)
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]).toMatchObject({ session_id: 'reset-empty', title: 'Current saved title', pinned: true, message_count: 1 })
    expect(list.sessions[0]).not.toHaveProperty('_lineage_ids')
  })

  it.each(['root', 'all', 'late-tip'] as const)('preserves canonical persisted %s aliases when deletion is refused', async (persisted) => {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    const ids = fixture.snapshots.multiple.sessions.map((row) => row.id)
    const save = async (id: string) => { (await server.deps.sessionStore.save(new Session({ session_id: id, profile: 'default', source_tag: 'cli', messages: [{ role: 'user', content: 'first old turn' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'second old turn' }] }, (await server.deps.sessionStore.deps.defaults('default'))))) }
    for (const id of persisted === 'all' ? ids : [fixture.owner]) (await save(id))
    sidecar.respond('state_db.delete_cli_session', async () => {
      if (persisted === 'late-tip') (await save('late-tip'))
      db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM state_meta')
      return { ok: true, deleted_ids: persisted === 'late-tip' ? [...ids, 'late-tip'] : ids }
    })
    const response = await server.get('/api/session/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'reset-empty' }) })
    expect(response.status, await response.text()).toBe(403)
    expect(sidecar.calls.filter((call) => call.method === 'state_db.delete_cli_session')).toEqual([])
    for (const id of persisted === 'all' ? ids : [fixture.owner]) expect(existsSync(sessionPath(server.deps.sessionStore, id)), id).toBe(true)
    expect(db.prepare('SELECT id FROM sessions').all()).toHaveLength(ids.length)
  })

  it.each([false, true])('preserves saved UI metadata in the read-only tip outside sidebar=%s', async (outside) => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    if (outside) for (let i = 0; i < 25; i += 1) {
      const id = `recent-${i}`
      db.prepare('INSERT INTO sessions (id, source, title, started_at, message_count) VALUES (?, ?, ?, ?, ?)').run(id, 'cli', id, 3_000_000_000 + i, 1)
      db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(100 + i, id, 'user', 'recent prompt', 3_000_000_001 + i)
    }
    const saved = { title: 'User saved title', pinned: true, archived: true, project_id: 'saved-project' }
    await server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', ...saved, messages: [{ role: 'user', content: 'old prompt' }] }, (await server.deps.sessionStore.deps.defaults('default'))))
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.cliSessions.invalidate()
    const response = await server.get(`/api/session?session_id=${fixture.owner}`)
    const result = await response.json() as { session: Record<string, unknown> }
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.session).toMatchObject({ session_id: 'reset-empty', ...saved, read_only: true })
    expect(existsSync(sessionPath(server.deps.sessionStore, 'reset-empty'))).toBe(false)
    if (!outside) {
      const listed = await (await server.get('/api/sessions?include_archived=1')).json() as { sessions: Record<string, unknown>[] }
      expect(listed.sessions).toHaveLength(1)
      expect(listed.sessions[0]).toMatchObject({ session_id: 'reset-empty', ...saved })
    }
    const reopened = await (await server.get(`/api/session?session_id=${fixture.owner}`)).json() as { session: Record<string, unknown> }
    expect(reopened.session).toMatchObject({ session_id: 'reset-empty', ...saved })
  })

  it('refuses a canonical alias mutation before waiting on its lock or evicting its runtime', async () => {
    const server = await bootTestServer({ sidecar: new FakeSidecar() })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    const workspace = join(server.state, 'workspace', 'updated-workspace'); mkdirSync(workspace)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const held = server.deps.sessionStore.withLock('reset-empty', () => gate)
    const lock = vi.spyOn(server.deps.sessionStore, 'withLock')
    const evict = vi.spyOn(server.deps.sessions.deps.runtime, 'evictAgent')
    const terminal = vi.spyOn(server.deps.sessions.deps.runtime, 'closeTerminal')
    const response = server.get('/api/session/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner, workspace, model: 'test-model' }) })
    try {
      const result = await response
      expect(result.status, await result.text()).toBe(403)
      expect(lock).not.toHaveBeenCalled()
      expect(evict).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()
    } finally { release(); await held; await response }
  })

  it('keeps the profile guard when an alias resolves to a sidecar owned by another profile', async () => {
    const server = await bootTestServer({ sidecar: new FakeSidecar() })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    for (const [id, profile] of [[fixture.owner, 'default'], ['reset-empty', 'other']] as const) {
      await server.deps.sessionStore.save(new Session({ session_id: id, profile, source_tag: 'cli', title: profile, messages: [{ role: 'user', content: 'synthetic profile history' }] }, (await server.deps.sessionStore.deps.defaults(profile))))
    }
    const response = await server.get('/api/session/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner }) })
    expect(response.status, await response.text()).toBe(404)
    expect((await server.deps.sessionStore.get('reset-empty')).profile).toBe('other')
    expect((await server.get(`/api/session?session_id=${fixture.owner}`)).status).toBe(409)
  })

  it('reconciles saved aliases outside the CLI window before list and search', async () => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = openStateDb(path); load('multiple')
    for (let i = 0; i < 25; i += 1) {
      const id = `recent-${i}`
      db.prepare('INSERT INTO sessions (id, source, title, started_at, message_count) VALUES (?, ?, ?, ?, ?)').run(id, 'cli', id, 5000 + i, 1)
      db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(100 + i, id, 'user', 'recent prompt', 5001 + i)
    }
    await server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', title: 'Saved outside conversation', messages: [{ role: 'user', content: 'old first' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'old second' }] }, (await server.deps.sessionStore.deps.defaults('default'))))
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.cliSessions.invalidate()
    const list = await (await server.get('/api/sessions')).json() as { sessions: Record<string, unknown>[] }
    expect(list.sessions.map((row) => row.session_id)).not.toContain(fixture.owner)
    const search = await (await server.get('/api/sessions/search?q=Saved%20outside&show_cli_sessions=1')).json() as { sessions: Record<string, unknown>[] }
    expect(search.sessions.map((row) => row.session_id)).not.toContain(fixture.owner)
    const global = await (await server.get('/api/sessions/search?q=Saved%20outside')).json() as { sessions: Record<string, unknown>[] }
    expect(global.sessions).toHaveLength(1)
    expect(global.sessions[0]).toMatchObject({ session_id: 'reset-empty', title: 'Saved outside conversation' })
  })
})
