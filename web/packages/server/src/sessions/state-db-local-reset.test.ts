import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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

  it('matches the candidate display and model histories after a reset then compression', async () => {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('compressed')
    const stage = fixture.snapshots.compressed
    expect(stateDbSessionMessages(path, fixture.owner).map((m) => m.content)).toEqual(stage.displayContents)
    expect(stateDbSessionMessages(path, fixture.owner, { stitch: false }).map((m) => m.content)).toEqual(stage.modelContents)
    const detail = await (await server.get(`/api/session?session_id=${fixture.owner}`)).json() as { session: { messages: { content: string }[] } }
    expect(detail.session.messages.map((m) => m.content)).toEqual(stage.displayContents)
    const response = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner, message: 'continue compressed context' }) })
    const started = await response.json() as { session_id: string; stream_id: string }
    expect(response.status, JSON.stringify(started)).toBe(200)
    expect(started.session_id).toBe('compressed')
    await server.sse(`/api/chat/stream?stream_id=${started.stream_id}`, (frame) => frame.event === 'stream_end')
    const call = sidecar.calls.find((call) => call.method === 'chat.start')?.params as { conversation_history: { content: string }[] }
    expect(call.conversation_history.map((m) => m.content)).toEqual(stage.modelContents)
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

  it.each(['root', 'all', 'late-tip'] as const)('deletes persisted %s aliases with the projected conversation', async (persisted) => {
    const sidecar = new FakeSidecar()
    const server = await bootTestServer({ sidecar })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    const ids = fixture.snapshots.multiple.sessions.map((row) => row.id)
    const save = (id: string) => { server.deps.sessionStore.save(new Session({ session_id: id, profile: 'default', source_tag: 'cli', messages: [{ role: 'user', content: 'first old turn' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'second old turn' }] }, server.deps.sessionStore.deps.defaults('default'))) }
    for (const id of persisted === 'all' ? ids : [fixture.owner]) save(id)
    sidecar.respond('state_db.delete_cli_session', () => {
      if (persisted === 'late-tip') save('late-tip')
      db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM state_meta')
      return { ok: true, deleted_ids: persisted === 'late-tip' ? [...ids, 'late-tip'] : ids }
    })
    const response = await server.get('/api/session/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'reset-empty' }) })
    expect(response.status, await response.text()).toBe(200)
    for (const id of [...ids, 'late-tip']) expect(existsSync(server.deps.sessionStore.pathFor(id)), id).toBe(false)
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.cliSessions.invalidate()
    const list = await (await server.get('/api/sessions')).json() as { sessions: Record<string, unknown>[] }
    expect(list.sessions).toEqual([])
  })

  it.each([false, true])('preserves saved UI metadata when materializing the tip outside sidebar=%s', async (outside) => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    if (outside) for (let i = 0; i < 25; i += 1) {
      const id = `recent-${i}`
      db.prepare('INSERT INTO sessions (id, source, title, started_at, message_count) VALUES (?, ?, ?, ?, ?)').run(id, 'cli', id, 3_000_000_000 + i, 1)
      db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(100 + i, id, 'user', 'recent prompt', 3_000_000_001 + i)
    }
    const saved = { title: 'User saved title', pinned: true, archived: true, project_id: 'saved-project' }
    server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', ...saved, messages: [{ role: 'user', content: 'old prompt' }] }, server.deps.sessionStore.deps.defaults('default')))
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.cliSessions.invalidate()
    const response = await server.get('/api/session/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner }) })
    const result = await response.json() as { session: Record<string, unknown> }
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.session).toMatchObject({ session_id: 'reset-empty', ...saved })
    expect(server.deps.sessionStore.get('reset-empty').compact()).toMatchObject(saved)
    if (!outside) {
      const listed = await (await server.get('/api/sessions?include_archived=1')).json() as { sessions: Record<string, unknown>[] }
      expect(listed.sessions).toHaveLength(1)
      expect(listed.sessions[0]).toMatchObject({ session_id: 'reset-empty', ...saved })
    }
    const reopened = await (await server.get(`/api/session?session_id=${fixture.owner}`)).json() as { session: Record<string, unknown> }
    expect(reopened.session).toMatchObject({ session_id: 'reset-empty', ...saved })
  })

  it('locks and evicts the current target when a mutation names an old member', async () => {
    const server = await bootTestServer({ sidecar: new FakeSidecar() })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    const workspace = join(server.state, 'workspace', 'updated-workspace'); mkdirSync(workspace)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const held = server.deps.sessionStore.withLock('reset-empty', () => gate)
    const lock = vi.spyOn(server.deps.sessionStore, 'withLock')
    const evict = vi.spyOn(server.deps.sessions.deps.runtime, 'evictAgent')
    const terminal = vi.spyOn(server.deps.sessions.deps.runtime, 'closeTerminal')
    const response = server.get('/api/session/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner, workspace, model: 'test-model' }) })
    try {
      await vi.waitFor(() => { expect(lock).toHaveBeenCalled() })
      expect(lock.mock.calls[0]?.[0]).toBe('reset-empty')
      expect(evict).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()
    } finally { release(); await held; await response }
    const result = await response
    expect(result.status, await result.text()).toBe(200)
    expect(evict).toHaveBeenCalledWith('reset-empty')
    expect(terminal).toHaveBeenCalledWith('reset-empty')
  })

  it('keeps the profile guard when an alias resolves to a sidecar owned by another profile', async () => {
    const server = await bootTestServer({ sidecar: new FakeSidecar() })
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    for (const [id, profile] of [[fixture.owner, 'default'], ['reset-empty', 'other']] as const) {
      server.deps.sessionStore.save(new Session({ session_id: id, profile, source_tag: 'cli', title: profile, messages: [{ role: 'user', content: 'synthetic profile history' }] }, server.deps.sessionStore.deps.defaults(profile)))
    }
    const response = await server.get('/api/session/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: fixture.owner }) })
    expect(response.status, await response.text()).toBe(404)
    expect(server.deps.sessionStore.get('reset-empty').profile).toBe('other')
    expect((await server.get(`/api/session?session_id=${fixture.owner}`)).status).toBe(409)
  })

  it('reconciles saved aliases outside the CLI window before list and search', async () => {
    const server = await bootTestServer()
    onTestFinished(async () => { await server.close() })
    db.close(); path = join(server.state, 'state.db'); db = new DatabaseSync(path); load('multiple')
    for (let i = 0; i < 25; i += 1) {
      const id = `recent-${i}`
      db.prepare('INSERT INTO sessions (id, source, title, started_at, message_count) VALUES (?, ?, ?, ?, ?)').run(id, 'cli', id, 5000 + i, 1)
      db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(100 + i, id, 'user', 'recent prompt', 5001 + i)
    }
    server.deps.sessionStore.save(new Session({ session_id: fixture.owner, profile: 'default', source_tag: 'cli', title: 'Saved outside conversation', messages: [{ role: 'user', content: 'old first' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'old second' }] }, server.deps.sessionStore.deps.defaults('default')))
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
