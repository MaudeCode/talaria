/**
 * TAL-259: `GET /api/session/recovery/audit` and `POST /api/session/recovery/repair-safe`, ported from the Python
 * recovery suites. Every case drives the HTTP routes over a disposable state directory.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const msgs = (n: number, prefix = ''): Json[] => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `${prefix}${String(i)}` }))
const msg = (role: string, content: string, ts: number, id: string): Json => ({ id, role, content, timestamp: ts })

let s: TestServer
const dir = (): string => join(s.state, 'sessions')
const dbPath = (): string => join(s.state, 'state.db')
const file = (name: string): string => join(dir(), name)
const read = (name: string): Json => JSON.parse(readFileSync(file(name), 'utf8')) as Json
function write(name: string, doc: unknown): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(file(name), typeof doc === 'string' ? doc : JSON.stringify(doc))
}
const sessionDoc = (sid: string, n: number): Json => ({ id: sid, session_id: sid, title: sid, messages: msgs(n) })
/** A live sidecar and its backup, as the store leaves them after a shrinking save. */
function pair(sid: string, live: unknown, bak: unknown): void {
  write(`${sid}.json`, live)
  write(`${sid}.json.bak`, bak)
}
/** An orphan backup: the sidecar is gone and only `<sid>.json.bak` remains. */
const orphan = (sid: string, n: number): void => { write(`${sid}.json.bak`, sessionDoc(sid, n)) }
const tombstone = (...ids: string[]): void => { write('_deleted_webui_sessions.json', { version: 1, ids }) }
const audit = async (): Promise<Json> => {
  const res = await s.get('/api/session/recovery/audit')
  expect(res.status).toBe(200)
  return json(res)
}
const repair = async (): Promise<[number, Json]> => {
  const res = await post(s, '/api/session/recovery/repair-safe', {})
  return [res.status, await json(res)]
}
const items = (report: Json): Json[] => report.items as Json[]
const kindsFor = (report: Json, sid: string): unknown[] => items(report).filter((i) => i.session_id === sid).map((i) => i.kind)
const marker = (): number => Number(readFileSync(join(s.state, 'recovery_stamping_since'), 'utf8'))
/** Backdate a backup to before the stamping marker: it may predate shrink provenance. */
function legacy(name: string): void {
  const past = marker() - 3600
  utimesSync(file(name), past, past)
}

/** `sessions` with only an id column (the Python audit fixtures). */
function idOnlyDb(...ids: string[]): void {
  const db = new DatabaseSync(dbPath())
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
  for (const id of ids) db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id)
  db.close()
}

interface Row { id: string; source?: string; messages?: number; worktree?: boolean }
/** Python `_make_state_db`: WebUI rows with a title, model, parent, and `messages` transcript rows. */
function stateDb(...rows: Row[]): void {
  const db = new DatabaseSync(dbPath())
  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, model TEXT, started_at REAL, message_count INTEGER, parent_session_id TEXT, workspace TEXT, worktree_path TEXT, worktree_branch TEXT, worktree_repo_root TEXT, worktree_created_at REAL)')
  db.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
  for (const row of rows) {
    const n = row.messages ?? 2
    const wt = row.worktree ? ['/srv/proj/.worktrees/t3', '/srv/proj/.worktrees/t3', 'hermes/t3', '/srv/proj', 1700000000] : [null, null, null, null, null]
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.source ?? 'webui', 'Recovered from DB', 'openai/gpt-5', 1234, n, 'parent-1', ...wt)
    for (let i = 0; i < n; i += 1) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(row.id, i % 2 ? 'assistant' : 'user', `message ${String(i + 1)}`, 1234 + i)
  }
  db.close()
}

beforeAll(async () => { s = await bootTestServer() })
afterAll(() => s.close())
beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true })
  rmSync(dbPath(), { force: true })
  s.deps.sessionStore.sessions.clear()
  s.deps.sessionStore.invalidatePersistedIds()
})

describe('session recovery routes', () => {
  it('records the stamping marker on first start', () => {
    expect(marker()).toBeGreaterThan(0)
    expect(marker()).toBeLessThanOrEqual(Date.now() / 1000)
  })

  it('repair-safe restores an orphan backup, rebuilds the index from disk, and answers 200 when clean', async () => {
    orphan('abc123', 4)
    write('_index.json', [])
    // A resident shell without a sidecar never reaches the rebuilt index (it would audit as drift).
    const shell = s.deps.sessionStore.newSession()
    const [status, body] = await repair()
    expect(status).toBe(200)
    expect(body).toMatchObject({ clean: true, ok: true, repaired: 1, backup_repair: { restored: 1, orphaned_backups: 1 }, after: { status: 'ok' } })
    expect(read('abc123.json').messages).toEqual(msgs(4))
    expect((JSON.parse(readFileSync(file('_index.json'), 'utf8')) as Json[]).map((e) => e.session_id)).toEqual(['abc123'])
    expect(shell.session_id).not.toBe('abc123')
    expect((await audit()).status).toBe('ok')
  })

  it('repair-safe leaves an orphan backup without a state.db row for review and answers 409 with the same body', async () => {
    orphan('abc123', 1)
    idOnlyDb('other')
    const [status, body] = await repair()
    expect(status).toBe(409)
    expect(body).toMatchObject({ clean: false, ok: false, repaired: 0, after: { status: 'needs_manual_review' } })
    expect(Object.keys(body).sort()).toEqual(['after', 'backup_repair', 'before', 'clean', 'ok', 'repaired', 'sidecar_repair'])
    expect(existsSync(file('abc123.json'))).toBe(false)
  })

  it('reports a repairable orphan backup when state.db still has the session', async () => {
    orphan('abc123', 3)
    idOnlyDb('abc123')
    expect(await audit()).toEqual({
      status: 'warn',
      summary: { ok: 0, repairable: 1, unsafe_to_repair: 0 },
      items: [{ session_id: 'abc123', kind: 'orphan_backup', category: 'repairable', recommendation: 'restore_from_bak', live_messages: -1, bak_messages: 3 }],
    })
  })

  it('marks an orphan backup without a state.db row unsafe', async () => {
    orphan('abc123', 2)
    idOnlyDb('different')
    const report = await audit()
    expect(report).toMatchObject({ status: 'needs_manual_review', summary: { unsafe_to_repair: 1 } })
    expect(items(report)[0]).toMatchObject({ kind: 'orphan_backup_without_state_row', recommendation: 'manual_review' })
  })

  it('reports index drift both ways, and repair rebuilds the index', async () => {
    write('abc123.json', sessionDoc('abc123', 1))
    write('_index.json', [{ session_id: 'missing', message_count: 1 }])
    const report = await audit()
    expect(new Set(items(report).map((i) => i.kind))).toEqual(new Set(['index_missing_file', 'index_missing_entry']))
    expect(report.summary).toMatchObject({ ok: 1, repairable: 2 })
    const [status, body] = await repair()
    expect([status, body.after]).toEqual([200, { status: 'ok', summary: { ok: 1, repairable: 0, unsafe_to_repair: 0 }, items: [] }])
  })

  it('is owner-only', async () => {
    const t = await bootTestServer({ env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
    try {
      const headers = { 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops' }
      for (const res of [await t.get('/api/session/recovery/audit', { headers }), await post(t, '/api/session/recovery/repair-safe', {}, headers)]) {
        expect([res.status, await json(res)]).toEqual([403, { error: 'Owner session required' }])
      }
    } finally {
      await t.close()
    }
  })
})

describe('deliberate shrinks', () => {
  it('truncate, retry, and undo stamp the shrink, and a stamped shrink is never repaired', async () => {
    const turns = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'one' }, { role: 'user', content: 'second' }, { role: 'assistant', content: 'two' }]
    for (const [path, body] of [['/api/session/truncate', { keep_count: 1 }], ['/api/session/retry', {}], ['/api/session/undo', {}]] as const) {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      const session = s.deps.sessionStore.get(sid)
      session.messages = structuredClone(turns)
      s.deps.sessionStore.save(session)
      const res = await post(s, path, { session_id: sid, ...body })
      expect(res.status, path).toBe(200)
      expect(read(`${sid}.json.bak`).messages, path).toHaveLength(4)
      expect(read(`${sid}.json`).intentional_shrink_generation, path).toMatch(/^[0-9a-f]{32}$/)
      const shrunk = read(`${sid}.json`).messages
      expect(kindsFor(await audit(), sid), path).toEqual([])
      await repair()
      expect(read(`${sid}.json`).messages, path).toEqual(shrunk)
    }
  })

  it('restores an unstamped shrink written after the marker, and the session reads the restored transcript', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = msgs(3)
    s.deps.sessionStore.save(session)
    session.messages = msgs(1)
    s.deps.sessionStore.save(session)
    expect(kindsFor(await audit(), sid)).toEqual(['shrunken_live'])
    const [status, body] = await repair()
    expect([status, body.repaired]).toEqual([200, 1])
    const got = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect((got.messages as Json[]).map((m) => m.content)).toEqual(['0', '1', '2'])
  })

  it('sends a pre-marker backup next to a valid live transcript to manual review and never restores it', async () => {
    pair('legacy1', sessionDoc('legacy1', 1), sessionDoc('legacy1', 3))
    legacy('legacy1.json.bak')
    const report = await audit()
    expect(items(report)).toEqual([{ session_id: 'legacy1', kind: 'unstamped_legacy_backup', category: 'unsafe_to_repair', recommendation: 'manual_review', live_messages: 1, bak_messages: 3 }])
    const [status, body] = await repair()
    expect([status, body.repaired]).toEqual([409, 0])
    expect(read('legacy1.json').messages).toHaveLength(1)
  })

  it('still restores a pre-marker backup when the live file is corrupt or missing', async () => {
    pair('corrupt1', '{not json', sessionDoc('corrupt1', 2))
    legacy('corrupt1.json.bak')
    orphan('gone1', 2)
    legacy('gone1.json.bak')
    const [status, body] = await repair()
    expect([status, body.repaired]).toEqual([200, 2])
    expect(read('corrupt1.json').messages).toHaveLength(2)
    expect(read('gone1.json').messages).toHaveLength(2)
    expect(readdirSync(dir()).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('skips a session with a live turn', async () => {
    pair('busy1', sessionDoc('busy1', 1), sessionDoc('busy1', 3))
    const resident = s.deps.sessionStore.get('busy1')
    resident.active_stream_id = 'stream-1'
    const [status, body] = await repair()
    expect(status).toBe(409)
    expect((body.backup_repair as Json).details).toEqual([{ session_id: 'busy1', restored: false, live_messages: 1, bak_messages: 3, skipped: 'session_active' }])
    expect(read('busy1.json').messages).toHaveLength(1)
  })
})

describe('clear provenance (#5570)', () => {
  const sentinel = (sid: string): Json => ({
    session_id: sid, messages: [], context_messages: [], truncation_watermark: 0.0, truncation_boundary: 0.0, active_stream_id: null,
    pending_user_message: null, pending_attachments: [], pending_started_at: null, pending_user_source: null, clear_generation: `clear-${sid}`,
  })
  const preClear = (sid: string): Json => ({
    session_id: sid, messages: [msg('user', 'pre-clear prompt', 1, 'u1'), msg('assistant', 'pre-clear reply', 2, 'a1')],
    context_messages: [msg('user', 'pre-clear prompt', 1, 'cu1'), msg('assistant', 'pre-clear reply', 2, 'ca1')], truncation_watermark: null, truncation_boundary: null,
  })
  const postClear = (sid: string): Json => {
    const messages = [msg('user', 'post-clear prompt', 10, 'u10'), msg('assistant', 'post-clear reply', 11, 'a11')]
    return { ...sentinel(sid), messages, context_messages: messages }
  }
  const omit = (doc: Json, ...keys: string[]): Json => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)))

  it('keeps a cleared sidecar over its pre-clear backup, with or without new messages', async () => {
    pair('clear_sentinel', sentinel('clear_sentinel'), preClear('clear_sentinel'))
    const newMessage = [msg('user', 'brand new post-clear question', 20, 'u20')]
    pair('clear_then_message', { ...sentinel('clear_then_message'), messages: newMessage, context_messages: newMessage }, preClear('clear_then_message'))
    expect(items(await audit())).toEqual([])
    await repair()
    expect(read('clear_sentinel.json')).toMatchObject({ messages: [], truncation_watermark: 0 })
    expect((read('clear_then_message.json').messages as Json[]).map((m) => m.content)).toEqual(['brand new post-clear question'])
  })

  it('restores a backup the clear does not cover', async () => {
    const cases: [string, Json, Json][] = [
      ['same_generation', sentinel('same_generation'), postClear('same_generation')],
      ['no_generation', omit(sentinel('no_generation'), 'clear_generation'), preClear('no_generation')],
      ['no_watermark', { ...sentinel('no_watermark'), truncation_watermark: null, truncation_boundary: null }, preClear('no_watermark')],
      ['active_stream', { ...sentinel('active_stream'), active_stream_id: 'stream-1' }, preClear('active_stream')],
      ['pending_message', { ...sentinel('pending_message'), pending_user_message: 'pending prompt' }, preClear('pending_message')],
      ['incomplete', omit(sentinel('incomplete'), 'active_stream_id', 'pending_user_message'), preClear('incomplete')],
      ['compacted_after_clear', { ...sentinel('compacted_after_clear'), messages: [msg('user', 'q', 20, 'u20')], context_messages: [msg('user', 'q', 20, 'cu20')], truncation_watermark: 30, truncation_boundary: 30 }, preClear('compacted_after_clear')],
      ['normal_loss', { session_id: 'normal_loss', messages: [msg('user', 'live prompt', 1, 'u1')] }, { session_id: 'normal_loss', messages: [msg('user', 'live prompt', 1, 'u1'), msg('assistant', 'live reply', 2, 'a1'), msg('user', 'extra', 3, 'u2')] }],
    ]
    for (const [sid, live, bak] of cases) pair(sid, live, bak)
    const report = await audit()
    for (const [sid] of cases) expect(kindsFor(report, sid), sid).toEqual(['shrunken_live'])
    await repair()
    for (const [sid, , bak] of cases) expect(read(`${sid}.json`).messages, sid).toEqual(bak.messages)
  })
})

describe('compression provenance (#4836)', () => {
  const live = (sid: string, messages: Json[], context: Json[]): Json => ({
    session_id: sid, title: 'Untitled', messages, context_messages: context, compression_anchor_summary: 'Compressed earlier',
    compression_anchor_message_key: { role: 'assistant', ts: 2.0, text: 'two', attachments: 0 }, compression_anchor_mode: 'manual', truncation_watermark: 1.0, truncation_boundary: 1.0,
  })
  const m = (role: string, content: string, ts: number): Json => ({ role, content, timestamp: ts })

  it('keeps a manual compression over its pre-compression backup', async () => {
    const kept = [m('user', 'one', 1), m('assistant', 'two', 2)]
    const before = [...kept, ...Array.from({ length: 300 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `t${String(i)}`, 3 + i))]
    pair('compressed', live('compressed', kept, [m('user', 'one', 1)]), { ...live('compressed', before, before) })
    expect(items(await audit())).toEqual([])
    await repair()
    expect(read('compressed.json').messages).toEqual(kept)
  })

  it('restores a later loss from a backup written after the compression', async () => {
    const full = [m('user', 'one', 1), m('assistant', 'two', 2), m('user', 'three', 3), m('assistant', 'four', 4)]
    pair('post_compress_loss', live('post_compress_loss', [m('user', 'one', 1)], [m('user', 'one', 1)]), live('post_compress_loss', full, [m('user', 'one', 1)]))
    const marker = { role: 'user', content: '[context compaction] summary of earlier turns', timestamp: 1.0 }
    const healthy = Array.from({ length: 130 }, (_, i) => m('user', `m${String(i)}`, i))
    pair('both_shrunk', live('both_shrunk', full.slice(0, 2), [marker]), live('both_shrunk', healthy, [marker, ...Array.from({ length: 49 }, (_, i) => m('assistant', `c${String(i)}`, i))]))
    const report = await audit()
    expect([kindsFor(report, 'post_compress_loss'), kindsFor(report, 'both_shrunk')]).toEqual([['shrunken_live'], ['shrunken_live']])
    await repair()
    expect(read('post_compress_loss.json')).toMatchObject({ messages: full, context_messages: [m('user', 'one', 1)] })
    expect(read('both_shrunk.json').messages).toHaveLength(130)
  })
})

describe('state.db sidecar reconciliation', () => {
  it('materializes a WebUI row whose sidecar is missing, and the session loads', async () => {
    stateDb({ id: 'state_only_001', messages: 3 })
    expect(items(await audit())).toEqual([{ session_id: 'state_only_001', kind: 'state_db_missing_sidecar', category: 'repairable', recommendation: 'materialize_from_state_db', live_messages: -1, bak_messages: -1 }])
    const [status, body] = await repair()
    expect([status, body.sidecar_repair]).toEqual([200, { scanned: 1, materialized: 1, details: [{ session_id: 'state_only_001', materialized: true, messages: 3 }] }])
    expect(read('state_only_001.json')).toMatchObject({ session_id: 'state_only_001', title: 'Recovered from DB', model: 'openai/gpt-5', parent_session_id: 'parent-1', source_tag: 'webui', session_source: 'webui', profile: 'default', message_count: 3 })
    expect(readdirSync(dir()).filter((n) => n.includes('.tmp'))).toEqual([])
    const got = (await json(await s.get('/api/session?session_id=state_only_001'))).session as Json
    expect((got.messages as Json[]).map((x) => x.content)).toEqual(['message 1', 'message 2', 'message 3'])
    expect(got).toMatchObject({ model: 'openai/gpt-5', parent_session_id: 'parent-1' })
  })

  it('keeps the worktree fields of a worktree-backed session', async () => {
    stateDb({ id: 'wt_001', worktree: true })
    await repair()
    expect(read('wt_001.json')).toMatchObject({ workspace: '/srv/proj/.worktrees/t3', worktree_path: '/srv/proj/.worktrees/t3', worktree_branch: 'hermes/t3', worktree_repo_root: '/srv/proj', worktree_created_at: 1700000000 })
  })

  it('never resurrects a session the user deleted', async () => {
    stateDb({ id: 'deleted_001' }, { id: 'deleted_both_001' })
    write('_index.json', [{ session_id: 'deleted_001', source_tag: 'webui', raw_source: 'webui', session_source: 'webui' }, { session_id: 'deleted_index_only', source_tag: 'webui' }])
    write('deleted_both_001.json.bak', { session_id: 'deleted_both_001', messages: [{ role: 'user', content: 'x' }] })
    tombstone('deleted_001', 'deleted_both_001', 'deleted_index_only')
    const report = await audit()
    for (const sid of ['deleted_001', 'deleted_both_001']) {
      expect(items(report).filter((i) => i.session_id === sid), sid).toEqual([expect.objectContaining({ kind: 'state_db_deleted_webui_tombstone', category: 'unsafe_to_repair', recommendation: 'deleted_session_skipped' })])
    }
    expect(kindsFor(report, 'deleted_index_only')).toEqual([])
    const [, body] = await repair()
    expect(body.repaired).toBe(0)
    for (const sid of ['deleted_001', 'deleted_both_001']) expect(existsSync(file(`${sid}.json`)), sid).toBe(false)
  })

  it('treats an index row without a tombstone as a crash and materializes it', async () => {
    stateDb({ id: 'crashed_001' }, { id: 'read_only_001' })
    write('_index.json', [{ session_id: 'crashed_001', source_tag: 'webui' }, { session_id: 'read_only_001', source_tag: '', read_only: true }])
    const [status, body] = await repair()
    expect([status, body.repaired]).toEqual([200, 2])
    expect(read('read_only_001.json')).toMatchObject({ source_tag: 'webui', session_source: 'webui' })
  })

  it('leaves an existing sidecar, an empty row, and a non-WebUI row alone', async () => {
    stateDb({ id: 'existing_001' }, { id: 'empty_row', messages: 0 }, { id: 'subagent_001', source: 'subagent' })
    write('existing_001.json', { session_id: 'existing_001', messages: [{ role: 'user', content: 'keep' }] })
    const report = await audit()
    expect(items(report).filter((i) => i.session_id !== 'existing_001')).toEqual([{ session_id: 'empty_row', kind: 'state_db_orphan_webui_row', category: 'unsafe_to_repair', recommendation: 'manual_review', live_messages: -1, bak_messages: -1 }])
    const [, body] = await repair()
    expect(body.sidecar_repair).toMatchObject({ materialized: 0 })
    expect(read('existing_001.json').messages).toEqual([{ role: 'user', content: 'keep' }])
    expect(existsSync(file('empty_row.json')) || existsSync(file('subagent_001.json'))).toBe(false)
  })

  it('does not report clean while state.db is write-locked, and waits the lock out', async () => {
    stateDb({ id: 'webui-orphan', messages: 1 })
    const holder = spawn(process.execPath, ['-e', "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close() }, 700)", dbPath()])
    try {
      await once(holder.stdout, 'data')
      const probe = new DatabaseSync(dbPath(), { readOnly: true, timeout: 0 })
      expect(() => probe.prepare('SELECT count(*) FROM sessions').get(), 'the fixture must hold the lock').toThrow()
      probe.close()
      expect(kindsFor(await audit(), 'webui-orphan')).toEqual(['state_db_missing_sidecar'])
    } finally {
      holder.kill()
    }
  })

  it('reports an unreadable state.db instead of a clean scan', async () => {
    writeFileSync(dbPath(), 'not a database')
    const report = await audit()
    expect(report).toMatchObject({ status: 'needs_manual_review', items: [{ session_id: '', kind: 'state_db_unreadable', category: 'unsafe_to_repair' }] })
  })
})

describe('turn journal (read-only)', () => {
  const journal = (name: string, ...events: Json[]): void => {
    mkdirSync(join(dir(), '_turn_journal'), { recursive: true })
    writeFileSync(join(dir(), '_turn_journal', name), events.map((e) => JSON.stringify(e)).join('\n') + '\n{torn')
  }

  it('reports a pending turn whose user message is absent', async () => {
    write('sid-1.json', { session_id: 'sid-1', title: 'Turn journal test', messages: [] })
    journal('sid-1~1001.jsonl', { event: 'submitted', turn_id: 'turn-1', stream_id: 'stream-1', role: 'user', content: 'recover me', attachments: [], created_at: 1 })
    expect(await audit()).toEqual({
      status: 'warn',
      summary: { ok: 1, repairable: 1, unsafe_to_repair: 0 },
      items: [{ session_id: 'sid-1', kind: 'turn_journal_pending_turn', category: 'repairable', recommendation: 'audit_only_pending_turn_journal', live_messages: 0, bak_messages: -1, turn_id: 'turn-1', event: 'submitted' }],
    })
    await repair()
    expect(readdirSync(join(dir(), '_turn_journal'))).toEqual(['sid-1~1001.jsonl'])
  })

  it('ignores completed turns across pid shards and turns already in the sidecar', async () => {
    write('sid-1.json', { session_id: 'sid-1', title: 'Turn journal test', messages: [{ role: 'user', content: 'already there' }] })
    journal('sid-1~1001.jsonl', { event: 'submitted', turn_id: 'turn-1', role: 'user', content: 'already there', created_at: 1 }, { event: 'submitted', turn_id: 'turn-2', content: 'finished', created_at: 2 })
    journal('sid-1~1002.jsonl', { event: 'completed', turn_id: 'turn-2', created_at: 3 })
    expect(await audit()).toMatchObject({ status: 'ok', items: [] })
  })
})
