import { sessionPath } from '../test/storage.js'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { SessionSchema } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { buildInsights } from '../tools/insights.js'
import { Session } from './session.js'
import { recordBackgroundUpdate } from './background-updates.js'
import { agentSessionRowsExisting, cheapChangeFingerprint, insightsSessionRows, latestCronSessionInfo, isCliSessionRowVisible, normalizeAgentSessionSource, projectAgentSessionRows, readImportableAgentSessionRows, stateDbCompressionLineage, stateDbHasSession, stateDbLineageReport, stateDbSessionRead, stateDbSessionSources, type ReadRowsOptions } from './state-db.js'
import agentSchema from '../test/fixtures/canonical-ownership.json' with { type: 'json' }
import cronSchema from '../test/fixtures/cron-sessions.json' with { type: 'json' }
import { MESSAGING_SOURCES } from './source-kind.js'
import { CLI_VISIBLE_SESSION_LIMIT, type CliSessionRead } from './cli-sessions.js'
import { GatewayWatcher, snapshotHash } from './gateway-watcher.js'
import { capRecentCliSessions, keepLatestMessagingSessionPerSource, mergeCliSidebarMetadata, withOwnerLocks, type GatewayIdentity } from './list.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

/** The Agent's `state.db` columns the projection reads. */
function createStateDb(path: string): DatabaseSync {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = openStateDb(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, title TEXT,
    chat_id TEXT, chat_type TEXT, thread_id TEXT, session_key TEXT, origin_chat_id TEXT, origin_user_id TEXT, platform TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`)
  return db
}

function insertSession(db: DatabaseSync, row: { id: string; source: string; started_at: number; title?: string | null; model?: string | null; parent?: string | null; ended_at?: number | null; end_reason?: string | null; messages?: [string, number][]; chat_id?: string | null }): void {
  const messages = row.messages ?? []
  db.prepare('INSERT INTO sessions (id, source, started_at, title, model, message_count, parent_session_id, ended_at, end_reason, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.source, row.started_at, row.title ?? null, row.model ?? null, messages.length, row.parent ?? null, row.ended_at ?? null, row.end_reason ?? null, row.chat_id ?? null)
  for (const [role, ts] of messages) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(row.id, role, `${role} says`, ts)
}

describe('absorbed durable identity (TAL-1019)', () => {
  it.each([false, true])('keeps absorbed UID provenance on a reconstructed database carrier with edit=%s', async (edited) => {
    const s = await bootTestServer()
    const path = join(s.state, 'state.db')
    const db = createStateDb(path)
    const sid = 'database-carrier'
    try {
      db.exec('ALTER TABLE messages ADD COLUMN message_uid TEXT; ALTER TABLE messages ADD COLUMN absorbed_message_uids TEXT; ALTER TABLE messages ADD COLUMN active INTEGER DEFAULT 1; ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0')
      insertSession(db, { id: sid, source: 'webui', started_at: 100 })
      const insert = db.prepare('INSERT INTO messages(session_id, role, content, timestamp, message_uid, absorbed_message_uids, active, compacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      if (edited) insert.run(sid, 'user', 'older prefix', 100, 'carrier', null, 0, 1)
      insert.run(sid, 'user', 'Merged prefix\ncontinue', 100, 'carrier', JSON.stringify(['absorbed']), 1, 0)
      const carrier = stateDbSessionRead(path, sid).rows[0]!
      const session = new Session({ session_id: sid, messages: [carrier], context_messages: [carrier] }, { workspace: s.state, model: null })
      // The recovered carrier precedes the later durable copies it already represents.
      insert.run(sid, 'user', 'continue', 200, 'absorbed', null, 1, 0)
      insert.run(sid, 'assistant', 'Verified the result.', 201, 'reply', null, 1, 0)
      insert.run(sid, 'user', 'continue', 202, 'independent', null, 1, 0)
      const expected = [carrier.content, 'Verified the result.', 'continue']
      expect(s.deps.sessions.mergedTranscript(session, session.messages, await s.deps.sessions.stateDbRows(session)).map((m) => m.content)).toEqual(expected)
      expect((await s.deps.sessions.readModelContext(session)).map((m) => m.content)).toEqual(expected)
      expect(carrier._absorbed_message_uids).toEqual(['absorbed'])
      if (edited) expect(carrier._state_db_authored_change).toBe(true)
      await s.deps.sessionStore.save(session)
      for (let reopen = 0; reopen < 2; reopen += 1) {
        s.deps.sessionStore.sessions.delete(sid)
        const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
        expect((detail.messages as Json[]).map((m) => m.content)).toEqual(expected)
        expect((detail.messages as Json[]).every((m) => !('_absorbed_message_uids' in m))).toBe(true)
      }
    } finally { db.close(); await s.close() }
  })

  it.each((['numeric', 'uid', 'legacy-uid'] as const).flatMap((identity) => [false, true].map((background) => [identity, background] as const)))('settles and reopens by %s with background=%s', async (identity, background) => {
    const s = await bootTestServer()
    const path = join(s.state, 'state.db')
    const db = createStateDb(path)
    try {
      db.exec('ALTER TABLE messages ADD COLUMN message_uid TEXT')
      if (identity === 'legacy-uid') db.exec('DROP TABLE messages; CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL, message_uid TEXT)')
      const sid = `absorbed-${identity}-${String(background)}`
      insertSession(db, { id: sid, source: 'webui', started_at: 100 })
      const startRead = stateDbSessionRead(path, sid)
      const text = background ? 'Background task completed' : 'continue'
      const insert = (uid: string, content: string, timestamp: number) => db.prepare('INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES (?, ?, ?, ?, ?)').run(sid, 'user', content, timestamp, uid)
      const absorbedId = Number(insert('absorbed', text, 200).lastInsertRowid)
      const prompt = { role: 'user', content: `Earlier merged prefix\n${text}`, timestamp: 100, _turn_id: 'turn',
        ...(identity === 'numeric' ? { _absorbed_row_ids: [absorbedId] } : { _absorbed_message_uids: ['absorbed'] }),
        ...(background ? { _source: 'process_wakeup' } : {}) }
      const reply = { role: 'assistant', content: 'Verified the result.', timestamp: 101, _turn_id: 'turn' }
      const session = new Session({ session_id: sid, messages: [prompt, reply], context_messages: [prompt, reply] }, { workspace: s.state, model: null })
      if (background) recordBackgroundUpdate(session, 'turn', { kind: 'delegation', attention: false, count: 1, summary: text, lines: [{ kind: 'agent', status: 'completed', label: 'Synthetic delegated task' }] })
      // A genuine concurrent submission can equal the merged model prompt exactly.
      insert('independent', prompt.content, 202)
      insert('cli', 'Unrelated CLI work', 203)
      const expected = [prompt.content, reply.content, prompt.content, 'Unrelated CLI work']
      s.deps.sessions.settleStateDb(session, { turnId: 'turn', previousContext: [], agentRows: [prompt, reply], startId: identity === 'legacy-uid' ? null : 0, startGeneration: startRead.generation, read: await s.deps.sessions.settlementRead(session) })
      expect(session.messages.map((m) => m.content)).toEqual(expected)
      expect(session.context_messages.map((m) => m.content)).toEqual(expected)
      expect(s.deps.sessions.mergedTranscript(session, session.messages, await s.deps.sessions.stateDbRows(session)).map((m) => m.content)).toEqual(expected)
      expect((await s.deps.sessions.readModelContext(session)).map((m) => m.content)).toEqual(expected)
      await s.deps.sessionStore.save(session)
      s.deps.sessionStore.sessions.delete(sid)
      for (let reopen = 0; reopen < 2; reopen += 1) {
        const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
        const rows = detail.messages as Json[]
        expect(rows.map((m) => m.content)).toEqual(expected)
        expect(rows.filter((m) => m._source === 'process_wakeup')).toHaveLength(background ? 1 : 0)
        expect(rows.filter((m) => m._background_update)).toHaveLength(background ? 1 : 0)
        if (background) {
          expect(rows[0]?._background_update).toMatchObject({ kind: 'delegation', count: 1, lines: [{ kind: 'agent', status: 'completed', label: 'Synthetic delegated task' }] })
          expect(rows[1]).toMatchObject({ content: reply.content, _background_reply: true })
          expect(rows[1]).not.toHaveProperty('_background_silent')
        }
        expect(rows.slice(2).every((m) => !m._background_update && !m._background_reply)).toBe(true)
        expect(rows.every((m) => !('_state_db_message_uid' in m))).toBe(true)
        const tail = (await json(await s.get(`/api/session?session_id=${sid}&msg_limit=2`))).session as Json
        const head = (await json(await s.get(`/api/session?session_id=${sid}&msg_limit=2&msg_before=${String(tail._messages_offset)}`))).session as Json
        expect([...(head.messages as Json[]), ...(tail.messages as Json[])].map((m) => m.content)).toEqual(expected)
      }
    } finally { db.close(); await s.close() }
  })

  it.each([false, true])('preserves reused numeric IDs after replacement with failed boundary read=%s', async (failedBoundary) => {
    const s = await bootTestServer()
    const path = join(s.state, 'state.db')
    const sid = 'absorbed-generation'
    const create = (content: string | null, timestamp: number, target = path): void => {
      const db = createStateDb(target)
      try {
        insertSession(db, { id: sid, source: 'webui', started_at: 100 })
        if (content !== null) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'user', content, timestamp)
      } finally { db.close() }
    }
    try {
      create('absorbed old prompt', 100)
      const prompt = { role: 'user', content: 'Merged old prompt', timestamp: 90, _absorbed_row_ids: [1] }
      const reply = { role: 'assistant', content: 'Old answer', timestamp: 101 }
      const session = new Session({ session_id: sid, messages: [prompt, reply], context_messages: [prompt, reply] }, { workspace: s.state, model: null })
      s.deps.sessions.markStateDbSeen(session, await s.deps.sessions.stateDbRead(session))
      s.deps.sessions.markStateDbSeen(session, await s.deps.sessions.stateDbRead(session))
      await s.deps.sessionStore.save(session)
      if (failedBoundary) s.deps.sessions.markStateDbSeen(session, { rows: [], ok: false, idCapable: false, reason: 'synthetic failed read', generation: null }, { boundary: true })
      create(null, 0, `${path}.new`)
      renameSync(`${path}.new`, path)
      const startRead = stateDbSessionRead(path, sid)
      const previousContext = structuredClone(session.context_messages)
      const rawHistory = previousContext.map((m) => { const raw = { ...m }; delete raw._state_db_generation; return raw })
      session.context_messages = rawHistory
      const concurrent = openStateDb(path)
      try { concurrent.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'user', 'New CLI request', 200) } finally { concurrent.close() }
      const expected = [prompt.content, reply.content, 'New CLI request']
      expect(s.deps.sessions.mergedTranscript(session, session.messages, await s.deps.sessions.stateDbRows(session)).map((m) => m.content)).toEqual(expected)
      expect((await s.deps.sessions.readModelContext(session)).map((m) => m.content)).toEqual(expected)
      // Settlement must not rebind the persisted carrier to the replacement's generation.
      s.deps.sessions.settleStateDb(session, { turnId: 'later', previousContext, agentRows: rawHistory, startId: 0, startGeneration: startRead.generation, read: await s.deps.sessions.settlementRead(session) })
      expect(session.messages.map((m) => m.content)).toEqual(expected)
      expect((await s.deps.sessions.readModelContext(session)).map((m) => m.content)).toEqual(expected)
      await s.deps.sessionStore.save(session)
      s.deps.sessionStore.sessions.delete(sid)
      for (let reopen = 0; reopen < 2; reopen += 1) {
        const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
        expect((detail.messages as Json[]).map((m) => m.content)).toEqual(expected)
      }
    } finally { await s.close() }
  })
})

describe('latestCronSessionInfo', () => {
  let dir: string
  beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'cron-sessions-'))) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('merges v0.22.3 scheduler admissions with legacy runs by start time', () => {
    const path = join(dir, 'admissions.db')
    const db = openStateDb(path)
    db.exec(cronSchema.schema.join('\n'))
    for (const [id, started_at] of [['cron_daily_20261020_120000', 100], ['local-daily', 200], ['cron_daily_digest_20261020_120000', 400], ['local-digest', 300]] as const) insertSession(db, { id, source: 'cron', started_at, messages: [['user', started_at]] })
    const admit = db.prepare("INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status) VALUES (?, ?, ?, ?, '[]', '{}', 'synthetic', 'queue', 'terminal')")
    admit.run('daily', 'cron:daily:exec1', 'cron-owner', 'local-daily')
    admit.run('digest', 'cron:daily_digest:exec1', 'cron-owner', 'local-digest')
    // Neither malformed keys nor another principal can claim a cron run.
    admit.run('malformed', 'cron:daily:exec:bad', 'cron-owner', 'local-digest')
    admit.run('empty', 'cron:daily:', 'cron-owner', 'local-digest')
    admit.run('foreign', 'cron:daily:foreign', 'human', 'local-digest')
    db.close()
    expect(latestCronSessionInfo(path, ['daily'], ['daily'])).toEqual(new Map([['daily', { session_id: 'local-daily', message_count: 1 }]]))
    expect(latestCronSessionInfo(path, ['daily', 'daily_digest'], ['daily', 'daily_digest'])).toEqual(new Map([
      ['daily_digest', { session_id: 'cron_daily_digest_20261020_120000', message_count: 1 }],
      ['daily', { session_id: 'local-daily', message_count: 1 }],
    ]))
  })

  it.each([['completion', null], ['listing', null], ['completion', 'queued'], ['completion', 'started'], ['completion', 'unknown']] as const)('links a v0.22.3 local cron run in its %s with next admission %s', async (surface, nextStatus) => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const db = openStateDb(join(s.state, 'state.db'))
      db.exec(cronSchema.schema.join('\n'))
      insertSession(db, { id: 'local-cron-job1', source: 'cron', started_at: 100, messages: [['user', 100], ['assistant', 101]] })
      db.exec("INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status) VALUES ('fire1', 'cron:job1:exec1', 'cron-owner', 'local-cron-job1', '[]', '{}', 'synthetic', 'queue', 'terminal')")
      if (nextStatus) {
        insertSession(db, { id: 'local-next-run', source: 'cron', started_at: 200 })
        db.prepare("INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status, owner_epoch, generation) VALUES ('fire2', 'cron:job1:exec2', 'cron-owner', 'local-next-run', '[]', '{}', 'synthetic', 'queue', ?, 1, 1)").run(nextStatus)
      }
      db.close()
      const jobs = [{ id: 'job1', name: 'Morning digest', profile: null, monitor: '', continuity: false, last_run_at: 102, last_status: 'ok', toast_notifications: true }]
      mkdirSync(join(s.state, 'cron'), { recursive: true })
      writeFileSync(join(s.state, 'cron', 'jobs.json'), JSON.stringify({ jobs }))
      sidecar.respond('cron.list', () => ({ jobs }))
      if (surface === 'completion') {
        expect(await s.deps.crons.recent(s.state, '0')).toMatchObject({ completions: [{ job_id: 'job1', session_id: 'local-cron-job1', message_count: 2 }] })
      } else {
        const listed = await json(await s.get('/api/sessions?show_cron_sessions=1'))
        expect((listed.sessions as Json[]).find((row) => row.session_id === 'local-cron-job1')).toMatchObject({ title: 'Morning digest', source_tag: 'cron' })
      }
      if (nextStatus) {
        const listed = await s.deps.cliSessions.load('default', { sessionIds: ['local-next-run'], keepEmpty: true })
        expect(listed.find((row) => row.session_id === 'local-next-run')).toMatchObject({ title: 'Morning digest', source_tag: 'cron' })
      }
    } finally { await s.close() }
  })

  it('falls back to id order without started_at and leaves jobs without a session out', () => {
    const path = join(dir, 'no-started-at.db')
    const db = openStateDb(path)
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT); INSERT INTO sessions VALUES ('cron_x_1', 'cron'), ('cron_x_2', 'cron'), ('cron_y_1', 'telegram')")
    db.close()
    expect(latestCronSessionInfo(path, ['x', 'y', 'z'], ['x', 'y', 'z'])).toEqual(new Map([['x', { session_id: 'cron_x_2', message_count: null }]]))
  })

  it('answers no enrichment for a missing or unrecognized state.db', () => {
    expect(latestCronSessionInfo(join(dir, 'missing.db'), ['x'], ['x']).size).toBe(0)
    const path = join(dir, 'no-source.db')
    const db = openStateDb(path)
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('cron_x_1')")
    db.close()
    expect(latestCronSessionInfo(path, ['x'], ['x']).size).toBe(0)
  })
})

describe('reads during another process\'s DELETE-journal commit (TAL-890)', () => {
  let dir: string
  beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-db-commit-'))) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Whether another connection holds a lock that keeps readers out of `path` right now. */
  function readersLockedOut(path: string): boolean {
    const probe = new DatabaseSync(path, { readOnly: true, timeout: 0 })
    try { probe.prepare('SELECT 1 FROM sessions').get(); return false } catch (error) { if (String(error).includes('database is locked')) return true; throw error } finally { probe.close() }
  }

  /** Hold an exclusive write transaction on `path` from a second process for `ms`; resolves once readers are locked out, with the commit still pending. */
  async function holdExclusiveCommit(path: string, ms: number): Promise<{ committed: Promise<void> }> {
    const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
      db.exec('BEGIN EXCLUSIVE'); db.exec("UPDATE sessions SET title = 'held'");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2])); db.exec('COMMIT'); db.close()`
    const holder = spawn(process.execPath, ['-e', script, path, String(ms)], { stdio: 'inherit' })
    const exited = new Promise<void>((resolve, reject) => { holder.on('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`holder exited ${String(code)}`)) }) })
    await vi.waitFor(() => { expect(readersLockedOut(path)).toBe(true) }, { timeout: 10_000, interval: 5 })
    return { committed: exited }
  }

  it.each([
    ['readImportableAgentSessionRows', (path: string): unknown => readImportableAgentSessionRows(path).map((r) => r.id), ['cli-1']],
    ['stateDbHasSession', (path: string): unknown => stateDbHasSession(path, 'cli-1'), true],
  ] as const)('%s waits out a 1.5 s exclusive commit', async (name, read, expected) => {
    const path = join(dir, `${name}.db`)
    const db = createStateDb(path)
    db.exec('PRAGMA journal_mode=DELETE')
    insertSession(db, { id: 'cli-1', source: 'cli', started_at: 1000, messages: [['user', 1000.1], ['assistant', 1000.2]] })
    db.close()
    const { committed } = await holdExclusiveCommit(path, 1500)
    try { expect(read(path)).toEqual(expected) } finally { await committed }
  }, 15_000)
})

describe('state.db projection', () => {
  let s: TestServer
  let db: DatabaseSync
  let dbPath: string
  beforeAll(async () => {
    s = await bootTestServer({ gatewayPollMs: 100 })
    dbPath = join(s.state, 'state.db')
    db = createStateDb(dbPath)
  })
  afterAll(async () => { db.close(); s.deps.gatewayWatchers.stopAll(); await s.close() })
  beforeEach(() => {
    // Existing rows are settled; writes made by a case still exercise fresh signatures.
    for (const file of [dbPath, `${dbPath}-wal`]) if (existsSync(file)) utimesSync(file, 1, 1)
  })

  it('keeps decoded scalar and object content within the public session contract', async ({ onTestFinished }) => {
    onTestFinished(() => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run('encoded-content')
      db.prepare('DELETE FROM sessions WHERE id = ?').run('encoded-content')
    })
    insertSession(db, { id: 'encoded-content', source: 'cli', started_at: 100, title: 'Encoded content' })
    const contents = ['{"text":"hello","password":"synthetic-secret"}', '42', 'false', '9007199254740993', '{"id":9007199254740993}']
    for (const [i, content] of contents.entries()) {
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('encoded-content', 'user', '\0json:' + content, 101 + i)
    }
    const response = await s.get('/api/session?session_id=encoded-content')
    const payload = await json(response)
    expect(response.status, JSON.stringify(payload)).toBe(200)
    const session = SessionSchema.parse(payload.session)
    expect(session.messages?.map((m) => m.content)).toEqual([
      '{"text":"hello","password":"***"}', '42', 'false', '9007199254740993', '{"id":9007199254740993}',
    ])
  })

  it('normalizes the agent source contract', () => {
    expect(normalizeAgentSessionSource('telegram')).toEqual({ raw_source: 'telegram', session_source: 'messaging', source_label: 'Telegram' })
    expect(normalizeAgentSessionSource('acp')).toEqual({ raw_source: 'acp', session_source: 'cli', source_label: 'ACP' })
    expect(normalizeAgentSessionSource('api_server')).toMatchObject({ session_source: 'api', source_label: 'API' })
    expect(normalizeAgentSessionSource(null)).toEqual({ raw_source: null, session_source: 'other', source_label: 'Agent' })
    expect(normalizeAgentSessionSource('my_bridge')).toMatchObject({ session_source: 'other', source_label: 'My Bridge' })
  })

  it('normalizes every messaging source into the messaging family (TAL-939)', () => {
    for (const source of MESSAGING_SOURCES) expect(normalizeAgentSessionSource(source).session_source, source).toBe('messaging')
  })

  it.each([
    ['feishu', 'Feishu'], ['dingtalk', 'DingTalk'], ['bluebubbles', 'BlueBubbles'],
    ['qqbot', 'QQBot'], ['yuanbao', 'Yuanbao'], ['whatsapp_cloud', 'WhatsApp Cloud'],
    ['imsg', 'iMessage (imsg)'], ['photon', 'iMessage via Photon'], ['google_chat', 'Google Chat'], ['simplex', 'SimpleX Chat'],
    ['buzz', 'Buzz'], ['raft', 'Raft'], ['ntfy', 'ntfy'], ['a2a', 'A2A'], ['homeassistant', 'Home Assistant'],
  ])('projects, deduplicates and protects %s sessions (TAL-939, TAL-945)', async (source, label) => {
    const sid = `platform-${source}`
    onTestFinished(() => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    })
    expect(normalizeAgentSessionSource(` ${source.toUpperCase()} `)).toEqual({ raw_source: source, session_source: 'messaging', source_label: label })
    insertSession(db, { id: sid, source, title: label, started_at: 3000, chat_id: 'platform-chat', messages: [['user', 3001], ['assistant', 3002]] })
    const post = (path: string, body: unknown) => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect(detail).toMatchObject({ source_kind: 'messaging', source_label: label, is_messaging_session: true, is_cli_session: false, read_only: true, can_delete: false })
    expect((await post('/api/chat/start', { session_id: sid, message: 'Do not send' })).status).toBe(403)
    expect((await post('/api/session/delete', { session_id: sid })).status).toBe(400)
    expect(stateDbHasSession(dbPath, sid)).toBe(true)
    expect(await s.deps.sessionStore.loadMetadataOnly(sid)).toBeNull()
    const rows = [
      { session_id: 'old', raw_source: source, chat_id: 'same', updated_at: 1 },
      { session_id: 'new', raw_source: source, chat_id: 'same', updated_at: 2 },
      { session_id: 'other', raw_source: source, chat_id: 'different', updated_at: 1 },
    ]
    expect(keepLatestMessagingSessionPerSource(rows, { showPrevious: false, identity: new Map(), isPreCompressionSnapshotId: () => false }).map((r) => r.session_id)).toEqual(['new', 'other'])
    expect(keepLatestMessagingSessionPerSource(rows, { showPrevious: true, identity: new Map(), isPreCompressionSnapshotId: () => false })).toHaveLength(3)
  })

  it('projects messageful gateway rows, hides empty ones, and keeps cron out of the default window', () => {
    insertSession(db, { id: 'tg-1', source: 'telegram', started_at: 100, title: 'Telegram chat', messages: [['user', 101], ['assistant', 102]], chat_id: 'c1' })
    insertSession(db, { id: 'tg-empty', source: 'telegram', started_at: 90 })
    insertSession(db, { id: 'cron_job1_1', source: 'cron', started_at: 95, messages: [['user', 96]] })
    insertSession(db, { id: 'web-1', source: 'webui', started_at: 80, messages: [['user', 81]] })
    const rows = readImportableAgentSessionRows(dbPath)
    expect(rows.map((r) => r.id)).toEqual(['tg-1'])
    expect(rows[0]).toMatchObject({ actual_message_count: 2, last_activity: 102, raw_source: 'telegram', session_source: 'messaging', source_label: 'Telegram' })
    expect(readImportableAgentSessionRows(dbPath, { excludeSources: null, includeSources: ['cron'] }).map((r) => r.id)).toEqual(['cron_job1_1'])
    expect(agentSessionRowsExisting(dbPath, ['tg-1', 'nope'])).toEqual(new Set(['tg-1']))
  })

  it('applies the CLI visibility rules: untitled needs two user turns, TUI stays, ACP needs a user turn', () => {
    insertSession(db, { id: 'cli-untitled', source: 'cli', started_at: 200, messages: [['user', 201], ['assistant', 202]], ended_at: 203, end_reason: 'cli_close' })
    insertSession(db, { id: 'cli-titled', source: 'cli', started_at: 210, title: 'Fix the build', messages: [['user', 211]], ended_at: 212, end_reason: 'cli_close' })
    insertSession(db, { id: 'tui-1', source: 'tui', started_at: 220, messages: [['assistant', 221]], ended_at: 222, end_reason: 'cli_close' })
    insertSession(db, { id: 'acp-1', source: 'acp', started_at: 230, messages: [['assistant', 231]], ended_at: 232, end_reason: 'cli_close' })
    insertSession(db, { id: 'cli-live', source: 'cli', started_at: 240, messages: [['user', 241]] })
    const ids = readImportableAgentSessionRows(dbPath).map((r) => r.id)
    expect(ids).toContain('cli-titled')
    expect(ids).toContain('tui-1')
    expect(ids).toContain('cli-live')
    expect(ids).not.toContain('cli-untitled')
    expect(ids).not.toContain('acp-1')
    expect(isCliSessionRowVisible({ source: 'cli', session_source: 'cli', title: 'CLI Session', actual_message_count: 4, actual_user_message_count: 2, ended_at: 1, end_reason: 'cli_close' })).toBe(true)
  })

  it('collapses compression chains to the freshest importable tip and keeps the head identity', () => {
    insertSession(db, { id: 'root', source: 'cli', started_at: 300, title: 'Long chat', messages: [['user', 301], ['assistant', 302]], ended_at: 310, end_reason: 'compression' })
    insertSession(db, { id: 'seg2', source: 'cli', started_at: 310.2, parent: 'root', messages: [['user', 311]], ended_at: 320, end_reason: 'compression' })
    insertSession(db, { id: 'seg3', source: 'cli', started_at: 320.3, parent: 'seg2', messages: [['user', 321], ['assistant', 330]] })
    insertSession(db, { id: 'child', source: 'cli', started_at: 305, parent: 'root', title: 'Spawned', messages: [['user', 306]] })
    const rows = readImportableAgentSessionRows(dbPath)
    const collapsed = rows.find((r) => r._lineage_root_id === 'root')
    expect(collapsed).toMatchObject({ id: 'seg3', title: 'Long chat', _lineage_tip_id: 'seg3', _compression_segment_count: 3, last_activity: 330 })
    expect(rows.map((r) => r.id)).not.toContain('seg2')
    const childRow = rows.find((r) => r.id === 'child')
    expect(childRow).toMatchObject({ relationship_type: 'child_session', parent_title: 'Long chat', _parent_lineage_root_id: 'root' })
    expect(projectAgentSessionRows([{ id: 'a', source: 'cli', started_at: 1, end_reason: 'compression', ended_at: 2, actual_message_count: 0 }, { id: 'b', source: 'cli', started_at: 2, parent_session_id: 'a', actual_message_count: 0 }])).toEqual([])
  })

  it('exposes state.db rows through /api/sessions when non-WebUI sessions are shown, deduped against WebUI sidecars', async () => {
    await s.deps.settings.save({ show_cli_sessions: true })
    s.deps.cliSessions.invalidate()
    let body = await json(await s.get('/api/sessions'))
    const rows = body.sessions as Json[]
    const tg = rows.find((r) => r.session_id === 'tg-1')
    expect(tg).toMatchObject({ title: 'Telegram chat', source_tag: 'telegram', session_source: 'messaging', is_cli_session: false, workspace: expect.stringMatching(/workspace$/) as unknown, profile: 'default' })
    const cli = rows.find((r) => r.session_id === 'cli-titled')
    expect(cli).toMatchObject({ is_cli_session: true, source_label: 'CLI' })
    // TAL-312: the row says whether Web may continue it, as the detail and the mutation gate do.
    expect(tg?.read_only).toBe(true)
    expect(cli?.read_only).toBe(false)
    // Duplicate copies a WebUI sidecar, which neither state.db-only row has.
    expect([tg?.can_duplicate, cli?.can_duplicate]).toEqual([false, false])
    expect(rows.map((r) => r.session_id)).not.toContain('cron_job1_1')
    expect(body.cli_session_count).toBeGreaterThan(0)
    await s.deps.settings.save({ show_cli_sessions: false })
    body = await json(await s.get('/api/sessions'))
    expect((body.sessions as Json[]).map((r) => r.session_id)).not.toContain('tg-1')
    // Cron rows surface only when requested.
    body = await json(await s.get('/api/sessions?show_cron_sessions=1'))
    expect((body.sessions as Json[]).map((r) => r.session_id)).toContain('cron_job1_1')
    expect(((body.sessions as Json[]).find((r) => r.session_id === 'cron_job1_1'))).toMatchObject({ source_tag: 'cron', title: 'Cron Session' })
  })

  it('fingerprints state.db changes cheaply and the watcher notifies subscribers once per change', async () => {
    const before = cheapChangeFingerprint(dbPath)
    expect(before).not.toBeNull()
    expect(cheapChangeFingerprint(dbPath)).toBe(before)
    const watcher = new GatewayWatcher('default', s.state, { rows: (profile) => s.deps.cliSessions.read(profile), now: () => Date.now() / 1000, log: () => undefined, pollIntervalMs: 50 })
    const sub = watcher.subscribe()
    expect(await watcher.pollOnce()).toBe(true)
    const first = await sub.next(AbortSignal.timeout(500))
    expect(first?.type).toBe('sessions_changed')
    expect(first?.sessions.map((r) => r.session_id)).toContain('tg-1')
    expect(await watcher.pollOnce()).toBe(false)
    insertSession(db, { id: 'tg-2', source: 'telegram', started_at: 400, title: 'Newer', messages: [['user', 401]], chat_id: 'c2' })
    expect(cheapChangeFingerprint(dbPath)).not.toBe(before)
    expect(await watcher.pollOnce()).toBe(true)
    const second = await sub.next(AbortSignal.timeout(500))
    expect(second?.sessions.map((r) => r.session_id)).toContain('tg-2')
    // A wait that times out is not the end; the stop sentinel is.
    expect(await sub.next(AbortSignal.timeout(20))).toBeNull()
    expect(sub.ended).toBe(false)
    watcher.stop()
    expect(await sub.next()).toBeNull()
    expect(sub.ended).toBe(true)
    expect(await watcher.subscribe().next()).toBeNull()
    expect(snapshotHash([{ session_id: 'b', updated_at: 1 }, { session_id: 'a', updated_at: 2 }])).toBe(snapshotHash([{ session_id: 'a', updated_at: 2 }, { session_id: 'b', updated_at: 1 }]))
  })

  it('keeps parity reads, failed-read retries and slow-consumer drops with shared rows', async () => {
    let now = 100
    const read: CliSessionRead = { rows: [{ session_id: 'shared', title: 'Shared', source_tag: 'cli', message_count: 1, created_at: 1, updated_at: 2 }], truncated: new Set(), buildSucceeded: true, storage: { state: 'ok', reason: null } }
    const rows = vi.fn(() => Promise.resolve(read))
    const watcher = new GatewayWatcher('default', s.state, { rows, now: () => now, log: () => undefined })
    const sub = watcher.subscribe()
    try {
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next())?.sessions).toEqual([{ session_id: 'shared', title: 'Shared', model: null, message_count: 1, created_at: 1, updated_at: 2, source: 'cli', raw_source: null, session_source: null, source_label: null }])
      now += 299
      expect(await watcher.pollOnce()).toBe(false)
      expect(rows).toHaveBeenCalledTimes(1)
      now += 1
      expect(await watcher.pollOnce()).toBe(true)
      expect(rows).toHaveBeenCalledTimes(2)
      expect(await sub.next(AbortSignal.timeout(20))).toBeNull()
      expect(sub.ended).toBe(false)
      now += 300
      rows.mockRejectedValueOnce(new Error('synthetic read failure'))
      expect(await watcher.pollOnce()).toBe(false)
      rows.mockResolvedValueOnce({ ...read, rows: [], storage: { state: 'unavailable', reason: 'read_failed' } })
      expect(await watcher.pollOnce()).toBe(false)
      expect(await watcher.pollOnce()).toBe(true)
      expect(rows).toHaveBeenCalledTimes(5)
      now += 300
      rows.mockResolvedValueOnce({ ...read, rows: [], storage: { state: 'outdated', reason: 'missing_source_column' } })
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next())?.sessions).toEqual([])
      for (let count = 2; count <= 12; count++) {
        now += 300
        rows.mockResolvedValueOnce({ ...read, rows: [{ ...read.rows[0], message_count: count }] })
        expect(await watcher.pollOnce()).toBe(true)
      }
      expect(watcher.hasSubscribers()).toBe(false)
      expect(await sub.next()).toBeNull()
      expect(sub.ended).toBe(true)
    } finally { sub.close(); watcher.stop() }
  })

  it('compares every public gateway row field in a bounded large list, ignoring order and private metadata', async () => {
    let now = 100
    const read: CliSessionRead = { rows: Array.from({ length: 620 }, (_, i) => ({ session_id: `shared-${String(i)}`, title: 'Shared', model: 'model-a', source_tag: 'cli', raw_source: 'cli', session_source: 'cli', source_label: 'CLI', message_count: 1, created_at: 1, updated_at: 2 })), truncated: new Set(), buildSucceeded: true, storage: { state: 'ok', reason: null } }
    // Distinct IDs can collate equally; their input order must not affect comparison.
    read.rows[0]!.session_id = 'shared-\u00e9'
    read.rows[1]!.session_id = 'shared-e\u0301'
    const watcher = new GatewayWatcher('default', s.state, { rows: () => Promise.resolve(read), now: () => now, log: () => undefined })
    const sub = watcher.subscribe()
    try {
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next())?.sessions).toHaveLength(620)
      read.rows.reverse()
      read.rows[0]!._private_cache_revision = 1
      now += 300
      expect(await watcher.pollOnce()).toBe(true)
      expect(await sub.next(AbortSignal.abort())).toBeNull()
      for (const [field, value, publicField = field] of [
        ['title', 'Renamed'], ['model', 'model-b'], ['source_tag', 'telegram', 'source'],
        ['raw_source', 'telegram'], ['session_source', 'messaging'], ['source_label', 'Telegram'],
        ['created_at', 3], ['updated_at', 4], ['message_count', 2], ['session_id', 'changed-id'],
      ] as const) {
        read.rows[0]![field] = value
        now += 300
        expect(await watcher.pollOnce()).toBe(true)
        const event = await sub.next(AbortSignal.abort())
        expect(event?.sessions[0], field).toMatchObject({ [publicField]: value })
        expect(event?.sessions).toHaveLength(620)
        expect(event?.sessions[0]).not.toHaveProperty('_private_cache_revision')
        expect(await sub.next(AbortSignal.abort())).toBeNull()
      }
      // The existing public shaper makes missing and null metadata equivalent.
      read.rows[0]!.model = undefined
      now += 300
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next(AbortSignal.abort()))?.sessions[0]?.model).toBeNull()
      read.rows[0]!.model = null
      now += 300
      expect(await watcher.pollOnce()).toBe(true)
      expect(await sub.next(AbortSignal.abort())).toBeNull()
      watcher.stop()
      expect(await sub.next()).toBeNull()
      expect(sub.ended).toBe(true)
    } finally { sub.close(); watcher.stop() }
  })

  it('publishes no shared rows after stopping an in-flight poll', async () => {
    let release!: (read: CliSessionRead) => void
    const rows = vi.fn(() => new Promise<CliSessionRead>((resolve) => { release = resolve }))
    const watcher = new GatewayWatcher('default', s.state, { rows, now: () => 100, log: () => undefined })
    const sub = watcher.subscribe()
    const poll = watcher.pollOnce()
    try {
      await vi.waitFor(() => { expect(rows).toHaveBeenCalledTimes(1) })
      expect(await watcher.pollOnce()).toBe(false)
      watcher.stop()
      expect(await sub.next()).toBeNull()
      release({ rows: [{ session_id: 'late', message_count: 1 }], truncated: new Set(), buildSucceeded: true, storage: { state: 'ok', reason: null } })
      expect(await poll).toBe(false)
      expect(await sub.next(AbortSignal.timeout(20))).toBeNull()
      expect(await watcher.subscribe().next()).toBeNull()
    } finally { sub.close(); watcher.stop() }
  })

  it('serves the standalone gateway stream and its probe, never with Connection: close', async () => {
    await s.deps.settings.save({ show_cli_sessions: true })
    const probe = await s.get('/api/sessions/gateway/stream?probe=1')
    expect(probe.status).toBe(200)
    expect(await json(probe)).toEqual({ enabled: true, fallback_poll_ms: 30000, ok: true, watcher_running: true, scope: 'gateway_sessions', session_stream_available: true, session_stream_path: '/api/session/stream' })
    // #3103: a close header makes browsers end the EventSource and reconnect in a tight loop.
    const controller = new AbortController()
    const head = await s.get('/api/sessions/gateway/stream', { signal: controller.signal })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(head.headers.get('connection')).not.toBe('close')
    controller.abort()
    const first = await s.sse('/api/sessions/gateway/stream', (f) => f.event === 'sessions_changed', { timeoutMs: 3000 })
    expect(first[0]?.event).toBe('sessions_changed')
    expect(((first[0]?.data as Json).sessions as Json[]).map((r) => r.session_id)).toContain('tg-1')
    // A live insert reaches the stream through the watcher poll.
    const live = s.sse('/api/sessions/gateway/stream', (f) => f.event === 'sessions_changed' && ((f.data as Json).sessions as Json[]).some((r) => r.session_id === 'tg-gw'), { timeoutMs: 4000 })
    await new Promise((r) => setTimeout(r, 150))
    insertSession(db, { id: 'tg-gw', source: 'telegram', started_at: 600, title: 'Gateway live', messages: [['user', 601]], chat_id: 'c-gw' })
    expect((await live).some((f) => ((f.data as Json).sessions as Json[]).some((r) => r.session_id === 'tg-gw'))).toBe(true)
    // A watcher that is not running answers 503 on both modes.
    const stopped = vi.spyOn(s.deps.gatewayWatchers, 'get').mockReturnValue({ isAlive: () => false } as never)
    try {
      const down = await s.get('/api/sessions/gateway/stream?probe=1')
      expect(down.status).toBe(503)
      expect(await json(down)).toMatchObject({ ok: false, watcher_running: false, error: 'watcher not started' })
      const stream = await s.get('/api/sessions/gateway/stream')
      expect(stream.status).toBe(503)
      expect(await json(stream)).toEqual({ error: 'watcher not started' })
    } finally { stopped.mockRestore() }
    // A subscriber the watcher dropped as a slow consumer ends both responses so EventSource reconnects, while the
    // watcher itself keeps running.
    const dropped = vi.spyOn(s.deps.gatewayWatchers, 'get').mockReturnValue({ isAlive: () => true, subscribe: () => ({ next: () => Promise.resolve(null), ended: true, close: () => undefined }) } as never)
    try {
      for (const path of ['/api/sessions/gateway/stream', '/api/sessions/events?gateway=1']) {
        const res = await s.get(path)
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('event: sessions_changed')
      }
    } finally { dropped.mockRestore() }
    await s.deps.settings.save({ show_cli_sessions: false })
    const off = await s.get('/api/sessions/gateway/stream?probe=1')
    expect(off.status).toBe(404)
    expect(await json(off)).toMatchObject({ enabled: false, ok: false, error: 'agent sessions not enabled' })
    const offStream = await s.get('/api/sessions/gateway/stream')
    expect(offStream.status).toBe(404)
    expect(await json(offStream)).toEqual({ error: 'agent sessions not enabled' })
  })

  it('serves the merged sidebar feed with state.db snapshots', async () => {
    await s.deps.settings.save({ show_cli_sessions: true })
    const merged = await s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'gateway', { timeoutMs: 3000 })
    expect(merged[0]).toMatchObject({ event: 'initial', data: { stream: 'sessions' } })
    expect(merged[1]).toMatchObject({ event: 'gateway_status', data: { ok: true, watcher_running: true } })
    expect(merged.some((f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'gateway')).toBe(true)
    // A live insert reaches the merged feed through the 100 ms poll.
    const live = s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'gateway' && ((f.data as Json).sessions as Json[]).some((r) => r.session_id === 'tg-3'), { timeoutMs: 4000 })
    await new Promise((r) => setTimeout(r, 150))
    insertSession(db, { id: 'tg-3', source: 'telegram', started_at: 500, title: 'Live', messages: [['user', 501]], chat_id: 'c3' })
    const liveFrames = await live
    expect(liveFrames.some((f) => (f.data as Json).stream === 'gateway' && ((f.data as Json).sessions as Json[]).some((r) => r.session_id === 'tg-3'))).toBe(true)
    await s.deps.settings.save({ show_cli_sessions: false })
    const status = await s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'gateway_status', { timeoutMs: 2000 })
    expect(status[1]?.data).toMatchObject({ ok: false, enabled: false, error: 'agent sessions not enabled' })
  })

  it('keeps the newest messaging row per identity and caps CLI rows', () => {
    const identity = new Map<string, GatewayIdentity>()
    const rows = [
      { session_id: 'a', raw_source: 'telegram', chat_id: 'c1', updated_at: 10, message_count: 2 },
      { session_id: 'b', raw_source: 'telegram', chat_id: 'c1', updated_at: 20, message_count: 2 },
      { session_id: 'c', raw_source: 'telegram', chat_id: 'c2', updated_at: 5, message_count: 2 },
      { session_id: 'w', source_tag: 'webui', updated_at: 30 },
    ]
    expect(keepLatestMessagingSessionPerSource(rows, { showPrevious: false, identity, isPreCompressionSnapshotId: () => false }).map((r) => r.session_id)).toEqual(['w', 'b', 'c'])
    expect(keepLatestMessagingSessionPerSource(rows, { showPrevious: true, identity, isPreCompressionSnapshotId: () => false })).toHaveLength(4)
    const cli = Array.from({ length: 25 }, (_, i) => ({ session_id: `cli-${String(i)}`, session_source: 'cli', updated_at: i }))
    expect(capRecentCliSessions([{ session_id: 'w' }, ...cli]).length).toBe(21)
    expect(mergeCliSidebarMetadata({ session_id: 'x', title: 'Untitled', message_count: 1, archived: true }, { session_id: 'x', title: 'From state', raw_source: 'slack', message_count: 3, model: 'm' })).toMatchObject({ title: 'From state', message_count: 3, raw_source: 'slack', model: 'm', archived: true, is_cli_session: false })
  })

  it('degrades on an older schema without a source column', () => {
    const legacy = join(s.state, 'profiles', 'legacy', 'state.db')
    mkdirSync(join(s.state, 'profiles', 'legacy'), { recursive: true })
    const old = openStateDb(legacy)
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL NOT NULL, message_count INTEGER)')
    old.close()
    const logs: string[] = []
    expect(readImportableAgentSessionRows(legacy, { log: (l) => logs.push(l) })).toEqual([])
    expect(logs[0]).toContain("no 'source' column")
    writeFileSync(join(s.state, 'profiles', 'legacy', 'note.txt'), 'x')
  })

  it('file operations resolve an Agent-owned state.db session without a sidecar file to the active workspace', async () => {
    expect(stateDbHasSession(join(s.state, 'no-such.db'), 'tg-external-files')).toBe(false)
    insertSession(db, { id: 'tg-external-files', source: 'telegram', started_at: 300, title: 'From Telegram', messages: [['user', 301]] })
    const ws = realpathSync(join(s.state, 'workspace'))
    writeFileSync(join(ws, 'from-agent.txt'), 'hello')
    const res = await s.get('/api/list?session_id=tg-external-files&path=.')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries?: { name: string }[]; files?: { name: string }[] }
    expect(JSON.stringify(body)).toContain('from-agent.txt')
    expect((await s.get('/api/file?session_id=tg-external-files&path=from-agent.txt')).status).toBe(200)
    expect(stateDbHasSession(dbPath, 'tg-external-files')).toBe(true)
    expect(stateDbHasSession(dbPath, 'no-such-session')).toBe(false)
    expect((await s.get('/api/list?session_id=no-such-session&path=.')).status).toBe(404)
  })

  it('pages a long state.db-only scene like a WebUI one', async () => {
    insertSession(db, { id: 'tui-long', source: 'tui', started_at: 2000, title: 'Long', messages: [['user', 2001], ...Array.from({ length: 90 }, (_, i): [string, number] => ['assistant', 2002 + i])] })
    const detail = ((await (await s.get('/api/session?session_id=tui-long')).json()) as { session: { messages: Record<string, unknown>[] } }).session
    const index = detail.messages.length - 1
    const scene = detail.messages[index]?._anchor_activity_scene as Record<string, unknown>
    const offset = Number(scene.activity_rows_offset)
    expect(offset).toBeGreaterThan(0)
    const res = await s.get(`/api/session/anchor-scene?session_id=tui-long&message_index=${String(index)}&before=${String(offset)}&limit=80`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { rows: unknown[] }).rows).toHaveLength(offset)
  })

  it('GET /api/session synthesizes a state.db-only transcript, mutations materialize a claimable CLI session, and foreign owners stay read-only', async () => {
    const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    // A TUI conversation continued across a compression rotation: the tip stitches its parent segment.
    insertSession(db, { id: 'tui-root', source: 'tui', started_at: 1000, title: 'Root', model: 'm1', ended_at: 1100, end_reason: 'compression', messages: [['user', 1001], ['assistant', 1002]] })
    insertSession(db, { id: 'tui-tip', source: 'tui', started_at: 1100.5, title: 'Tip', model: 'm1', parent: 'tui-root', messages: [['user', 1101], ['assistant', 1102]] })
    let res = await s.get('/api/session?session_id=tui-tip')
    expect(res.status).toBe(200)
    let body = (await res.json()) as { session: Record<string, unknown> }
    expect(body.session).toMatchObject({ session_id: 'tui-tip', is_cli_session: true, read_only: false, message_count: 4, tool_calls: [], confirms_deep_truncate: true })
    expect((body.session.messages as { content: string }[]).map((m) => m.content)).toEqual(['user says', 'assistant says', 'user says', 'assistant says'])
    // State.db-only transcripts get the same server turn projection as WebUI sessions: turn ids and each turn's scene.
    const stateMessages = body.session.messages as Record<string, unknown>[]
    expect(stateMessages.map((m) => m._turn_id)).toEqual(['legacy:0', 'legacy:0', 'legacy:2', 'legacy:2'])
    expect(stateMessages[3]?._anchor_activity_scene).toMatchObject({ version: 'activity_scene_v1', final_answer: 'assistant says', terminal_state: 'completed', activity_rows: [] })
    // Archiving materializes a WebUI sidecar for the claimable CLI session (Python `_get_or_materialize_session`).
    res = await post('/api/session/archive', { session_id: 'tui-tip', archived: true })
    expect(res.status).toBe(200)
    expect((await s.deps.sessionStore.loadMetadataOnly('tui-tip'))?.archived).toBe(true)
    expect((await s.deps.sessionStore.get('tui-tip')).messages).toHaveLength(4)
    // The tip's transcript already stitches its compression parent in, so the claim must not record that parent as lineage.
    expect((await s.deps.sessionStore.get('tui-tip')).parent_session_id).toBeNull()
    // A messaging-owned session renders read-only and refuses mutation with 403 rather than 404.
    insertSession(db, { id: 'tg-owned', source: 'telegram', started_at: 2000, title: 'From TG', chat_id: '77', messages: [['user', 2001], ['assistant', 2002]] })
    res = await s.get('/api/session?session_id=tg-owned')
    expect(res.status).toBe(200)
    body = (await res.json()) as { session: Record<string, unknown> }
    // Python `_merge_cli_sidebar_metadata` re-derives `is_cli_session` from the row: a messaging row is not CLI.
    expect(body.session).toMatchObject({ read_only: true, is_cli_session: false, source_tag: 'telegram' })
    expect(await (await s.get('/api/session/status?session_id=tg-owned')).json()).toMatchObject({ read_only: true, is_streaming: false, agent_running: false })
    expect(body.session.can_duplicate).toBe(false)
    expect((await post('/api/session/duplicate', { session_id: 'tg-owned' })).status).toBe(404)
    res = await post('/api/session/rename', { session_id: 'tg-owned', title: 'nope' })
    expect(res.status).toBe(403)
    expect((await s.deps.sessionStore.loadMetadataOnly('tg-owned'))).toBeNull()
    // Deleting a foreign owner's transcript is refused as well (a Claude Code import is the same case): the state.db
    // rows must survive a direct delete request.
    insertSession(db, { id: 'cc-owned', source: 'claude_code', started_at: 2100, title: 'From Claude Code', messages: [['user', 2101], ['assistant', 2102]] })
    for (const foreign of ['tg-owned', 'cc-owned']) {
      res = await post('/api/session/delete', { session_id: foreign })
      expect(res.status, foreign).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('Read-only imported sessions cannot be deleted from WebUI')
      expect((await s.get(`/api/session?session_id=${foreign}`)).status).toBe(200)
    }
    // An id with no sidecar and no state.db rows stays a 404.
    expect((await s.get('/api/session?session_id=ghost-no-rows')).status).toBe(404)
    // A WebUI session continued from the CLI: state.db rows past the sidecar tail are appended to the transcript.
    const created = (await (await post('/api/session/new', {})).json()) as { session: { session_id: string } }
    const webSid = created.session.session_id
    const web = (await s.deps.sessionStore.get(webSid))
    web.messages = [{ role: 'user', content: 'from web', timestamp: 5000 }, { role: 'assistant', content: 'web reply', timestamp: 5001 }]
    await s.deps.sessionStore.save(web)
    insertSession(db, { id: webSid, source: 'webui', started_at: 5000, messages: [['user', 5000], ['assistant', 5001], ['user', 5100], ['assistant', 5101]] })
    body = (await (await s.get(`/api/session?session_id=${webSid}`)).json()) as { session: Record<string, unknown> }
    expect((body.session.messages as { content: string; timestamp: number }[]).map((m) => m.content)).toEqual(['from web', 'web reply', 'user says', 'assistant says'])
    expect(body.session.message_count).toBe(4)
    // Branching indexes that same merged transcript (Python `_merged_session_messages_for_display`): a keep_count past
    // the sidecar tail keeps the CLI turns instead of silently dropping them.
    const branched = (await (await post('/api/session/branch', { session_id: webSid, keep_count: 3 })).json()) as { session_id: string }
    expect((await s.deps.sessionStore.get(branched.session_id)).messages.map((m) => m.content)).toEqual(['from web', 'web reply', 'user says'])
    // ...and the branch's model context carries the retained CLI row as well (the branch id has no state.db rows).
    expect((await s.deps.sessionStore.get(branched.session_id)).context_messages.map((m) => m.content)).toEqual(['from web', 'web reply', 'user says'])
  })

  it('applies the state.db owner to an existing sidecar: messaging and Claude Code owners lock it, WebUI-born and claimable CLI sidecars stay writable (TAL-358)', async () => {
    const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    // A WebUI sidecar with no persisted `read_only`, whose id also has a state.db row owned by `source`.
    const sidecar = async (source: string, persisted: Json = {}): Promise<string> => {
      const sid = String(((await json(await post('/api/session/new', {}))).session as Json).session_id)
      const stored = (await s.deps.sessionStore.get(sid))
      stored.title = `Ownerprobe ${source}`
      stored.messages = [{ role: 'user', content: 'ownerprobe', timestamp: 7000 }, { role: 'assistant', content: 'ok', timestamp: 7001 }]
      Object.assign(stored, persisted)
      await s.deps.sessionStore.save(stored)
      insertSession(db, { id: sid, source, started_at: 7000, chat_id: `owner-${sid}`, messages: [['user', 7000], ['assistant', 7001]] })
      return sid
    }
    const locked = [await sidecar('telegram'), await sidecar('claude_code')]
    const writable = [await sidecar('telegram', { source_tag: 'webui' }), await sidecar('cli')]
    const payloads = async (sid: string): Promise<[string, Json | undefined][]> => {
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      const row = ((await json(await s.get('/api/sessions'))).sessions as Json[]).find((r) => r.session_id === sid)
      const hit = ((await json(await s.get('/api/sessions/search?q=ownerprobe'))).sessions as Json[]).find((r) => r.session_id === sid)
      const status = await json(await s.get(`/api/session/status?session_id=${sid}`))
      return [['detail', detail], ['list', row], ['search', hit], ['status', status]]
    }
    // With and without the state.db sidebar rows loaded: the lock does not depend on which rows the sidebar shows.
    for (const show of [false, true]) {
      await s.deps.settings.save({ show_cli_sessions: show })
      s.deps.cliSessions.invalidate()
      for (const sid of [...locked, ...writable]) {
        for (const [name, payload] of await payloads(sid)) expect(payload?.read_only, `${sid} ${name} show_cli=${String(show)}`).toBe(locked.includes(sid))
      }
    }
    await s.deps.settings.save({ show_cli_sessions: false })
    for (const sid of locked) {
      expect((await post('/api/chat/start', { session_id: sid, message: 'hi' })).status, sid).toBe(403)
      expect((await post('/api/session/rename', { session_id: sid, title: 'nope' })).status, sid).toBe(403)
      // The branch gate follows the lock, as the detail's `can_branch` says.
      expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).can_branch, sid).toBe(false)
      expect((await post('/api/session/branch', { session_id: sid })).status, sid).toBe(403)
      // Every other sidecar mutation takes the same gate.
      for (const [path, extra] of [['/api/session/toolsets', { toolsets: ['web'] }], ['/api/session/truncate', { keep_count: 0 }], ['/api/session/clear', {}], ['/api/session/retry', {}], ['/api/session/undo', {}]] as const) {
        expect((await post(path, { session_id: sid, ...extra })).status, `${sid} ${path}`).toBe(403)
      }
      expect((await s.deps.sessionStore.get(sid)).messages, sid).toHaveLength(2)
      expect((await post('/api/session/delete', { session_id: sid })).status, sid).toBe(400)
      expect((await s.deps.sessionStore.loadMetadataOnly(sid))?.title, sid).toMatch(/^Ownerprobe /)
    }
    for (const sid of writable) expect((await post('/api/session/rename', { session_id: sid, title: 'Ownerprobe renamed' })).status, sid).toBe(200)
  })

  it('prunes a read-only CLI or API-server import whose state.db row is gone, and deletes one a stale list still shows (TAL-590)', async () => {
    const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const imported = async (sid: string, source: string, extra: Json = {}): Promise<string> => {
      ;(await s.deps.sessionStore.save(new Session({
        session_id: sid, title: `Orphanprobe ${source}`, source_tag: source, raw_source: source, is_cli_session: source === 'cli', read_only: true,
        messages: [{ role: 'user', content: 'orphanprobe', timestamp: 8000 }, { role: 'assistant', content: 'ok', timestamp: 8001 }], ...extra,
      }, { workspace: s.state, model: null })))
      return sid
    }
    // A stream id a crash left behind is no run.
    const gone = [(await imported('tal590-cli-gone', 'cli')), (await imported('tal590-api-gone', 'api_server')), (await imported('tal590-dead-stream', 'cli', { active_stream_id: 'tal590-dead-run' }))]
    // Its source still exists, it is not a CLI or API-server import, it belongs to another profile's state.db, or a run holds it.
    const live = (await imported('tal590-cli-live', 'cli'))
    insertSession(db, { id: live, source: 'cli', started_at: 8000, title: 'Orphanprobe cli', messages: [['user', 8000], ['assistant', 8001]] })
    s.deps.registry.liveIds.add('tal590-live-run')
    const kept = [live, (await imported('tal590-tg-gone', 'telegram')), (await imported('tal590-other-profile', 'cli', { profile: 'work' })), (await imported('tal590-running', 'cli', { active_stream_id: 'tal590-live-run' }))]
    await s.deps.settings.save({ show_cli_sessions: true })
    s.deps.cliSessions.invalidate()
    const listed = ((await json(await s.get('/api/sessions'))).sessions as Json[]).map((r) => str(r.session_id))
    for (const sid of gone) expect(listed, sid).not.toContain(sid)
    for (const sid of gone) expect(existsSync(sessionPath(s.deps.sessionStore, sid)), sid).toBe(false)
    for (const sid of kept) expect(existsSync(sessionPath(s.deps.sessionStore, sid)), sid).toBe(true)
    // A client that still shows an orphan may delete it; there is no state.db row left to clean up.
    const stale = (await imported('tal590-cli-stale', 'cli'))
    const res = await post('/api/session/delete', { session_id: stale })
    expect(await json(res)).toEqual({ ok: true, state_db_cleanup_failed: false })
    expect(existsSync(sessionPath(s.deps.sessionStore, stale))).toBe(false)
    expect((await post('/api/session/delete', { session_id: live })).status).toBe(400)
    s.deps.registry.liveIds.delete('tal590-live-run')
    await s.deps.settings.save({ show_cli_sessions: false })
  })

  it('prunes a legacy Desktop sidecar only when its owning profile\'s state.db proves the row gone (TAL-1562)', async () => {
    const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    // The cached shape older materialization left: Desktop markers, read-only, and no `is_cli_session`.
    const desktop = async (sid: string, extra: Json = {}): Promise<string> => {
      ;(await s.deps.sessionStore.save(new Session({
        session_id: sid, title: 'Desktopprobe', source_tag: 'desktop', raw_source: 'desktop', read_only: true,
        messages: [{ role: 'user', content: 'desktopprobe', timestamp: 8100 }, { role: 'assistant', content: 'ok', timestamp: 8101 }], ...extra,
      }, { workspace: s.state, model: null })))
      return sid
    }
    const gone = await desktop('tal1562-desktop-gone')
    const live = await desktop('tal1562-desktop-live')
    insertSession(db, { id: live, source: 'desktop', started_at: 8100, title: 'Desktopprobe', messages: [['user', 8100], ['assistant', 8101]] })
    s.deps.registry.liveIds.add('tal1562-live-run')
    // Another profile's row is never checked against the active profile's state.db, and a held run is never an orphan.
    const kept = [live, (await desktop('tal1562-other-profile', { profile: 'work' })), (await desktop('tal1562-running', { active_stream_id: 'tal1562-live-run' }))]
    for (const path of ['/api/sessions', '/api/sessions?all_profiles=1']) {
      const rows = (await json(await s.get(path))).sessions as Json[]
      expect(rows.map((r) => str(r.session_id)), path).not.toContain(gone)
      // Pruning leaves the Desktop display classification alone.
      for (const r of rows.filter((r) => kept.includes(str(r.session_id)))) expect(r.source_kind, str(r.session_id)).toBe('other')
    }
    expect(existsSync(sessionPath(s.deps.sessionStore, gone))).toBe(false)
    for (const sid of kept) expect(existsSync(sessionPath(s.deps.sessionStore, sid)), sid).toBe(true)
    // Delete shares the eligibility: a stale client may delete an orphan, never a live Desktop session.
    const stale = await desktop('tal1562-desktop-stale')
    expect(await json(await post('/api/session/delete', { session_id: stale }))).toEqual({ ok: true, state_db_cleanup_failed: false })
    expect(existsSync(sessionPath(s.deps.sessionStore, stale))).toBe(false)
    expect((await post('/api/session/delete', { session_id: live })).status).toBe(400)
    s.deps.registry.liveIds.delete('tal1562-live-run')
  })

  it('locks a sidecar whose state.db owner cannot be read, and only a missing state.db means no owner (TAL-358)', () => {
    expect(stateDbSessionSources(join(s.state, 'no-such-state.db'), ['a'])).toEqual(new Map())
    // A path that exists but does not open as a database: the owner is unknown, not absent.
    const unreadable = join(s.state, 'unreadable-state.db')
    mkdirSync(unreadable, { recursive: true })
    expect(stateDbSessionSources(unreadable, ['a'])).toBeNull()
    const rows = withOwnerLocks([{ session_id: 'a' }, { session_id: 'b', source_tag: 'webui' }], () => null)
    expect(rows.map((r) => r.read_only)).toEqual([true, true])
  })
})

describe('legacy Desktop sidecars without a provable owner row (TAL-1562)', () => {
  const desktop = async (s: TestServer, sid: string, extra: Json = {}): Promise<string> => {
    ;(await s.deps.sessionStore.save(new Session({
      session_id: sid, title: 'Desktopprobe', source_tag: 'desktop', raw_source: 'desktop', read_only: true,
      messages: [{ role: 'user', content: 'desktopprobe', timestamp: 8200 }, { role: 'assistant', content: 'ok', timestamp: 8201 }], ...extra,
    }, { workspace: s.state, model: null })))
    return sid
  }
  const listed = async (s: TestServer, path = '/api/sessions'): Promise<string[]> => {
    const res = await s.get(path)
    expect(res.status, path).toBe(200)
    return ((await json(res)).sessions as Json[]).map((r) => str(r.session_id))
  }

  it('keeps the cache while the owning state.db is missing or corrupt, and the list stays healthy', async () => {
    const s = await bootTestServer()
    try {
      const sid = await desktop(s, 'tal1562-unproven')
      expect(await listed(s)).toContain(sid)
      writeFileSync(join(s.state, 'state.db'), 'not a database')
      expect(await listed(s)).toContain(sid)
      expect(existsSync(sessionPath(s.deps.sessionStore, sid))).toBe(true)
    } finally { await s.close() }
  })

  it('never proves a foreign profile\'s row gone from the pinned state.db in isolated mode', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-isolated-desktop-')))
    const home = join(base, 'profiles', 'alice')
    createStateDb(join(home, 'state.db')).close()
    const s = await bootTestServer({ env: { HERMES_WEBUI_ISOLATED_PROFILE: '1', HERMES_HOME: home } })
    try {
      const own = await desktop(s, 'tal1562-isolated-own', { profile: 'alice' })
      const foreign = await desktop(s, 'tal1562-isolated-foreign', { profile: 'bob' })
      await listed(s, '/api/sessions?all_profiles=1')
      expect(existsSync(sessionPath(s.deps.sessionStore, own))).toBe(false)
      expect(existsSync(sessionPath(s.deps.sessionStore, foreign))).toBe(true)
    } finally { await s.close(); rmSync(base, { recursive: true, force: true }) }
  })
})

describe('claiming a CLI session for WebUI (TAL-256)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = createStateDb(join(s.state, 'state.db'))
  })
  afterAll(async () => { db.close(); await s.close() })

  const finished = (params: Record<string, unknown>, sid: string): SidecarResult<'chat.start'> => ({
    status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'continued' }], final_response: 'continued', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 1000 }, model: 'm', provider: 'p', compressed: false,
    agent_session_id: sid, token_sent: true, pending_steer: '', live_tool_calls: [],
  })
  const send = async (sid: string): Promise<void> => {
    const res = await post('/api/chat/start', { session_id: sid, message: 'carry on' })
    expect(res.status).toBe(200)
    await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}`, (f) => f.event === 'stream_end')
  }

  it('keeps the CLI row\'s lineage and channel identity when its first WebUI send claims it', async () => {
    insertSession(db, { id: 'cli-parent', source: 'cli', started_at: 1000, title: 'Earlier work', ended_at: 1050, end_reason: 'user_exit', messages: [['user', 1001], ['assistant', 1002]] })
    insertSession(db, { id: 'cli-child', source: 'cli', started_at: 1100, title: 'Child work', parent: 'cli-parent', chat_id: '42', messages: [['user', 1101], ['assistant', 1102]] })
    sidecar.respond('chat.start', (params) => finished(params, 'cli-child'))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Unused"', usage: null }))

    expect((await json(await s.get('/api/session?session_id=cli-child&messages=0'))).session).toMatchObject({ read_only: false, is_cli_session: true })
    await send('cli-child')

    const claimed = (await s.deps.sessionStore.get('cli-child'))
    expect(claimed.parent_session_id).toBe('cli-parent')
    expect(claimed.extra.chat_id).toBe('42')
    // A real CLI title is not a placeholder, so title generation leaves it alone.
    expect(claimed.title).toBe('Child work')
  })

  it('titles a claimed CLI session that still carries its default "<Source> Session" title', async () => {
    insertSession(db, { id: 'cli-untitled', source: 'cli', started_at: 1150, messages: [['user', 1151], ['assistant', 1152]] })
    sidecar.respond('chat.start', (params) => finished(params, 'cli-untitled'))
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Resumed CLI work"', usage: null }))

    await send('cli-untitled')

    expect((await s.deps.sessionStore.get('cli-untitled')).title).toBe('Resumed CLI work')
  })

  it('titles an untitled CLI session when a mutation other than a send claims it (TAL-591)', async () => {
    insertSession(db, { id: 'cli-pinned', source: 'cli', started_at: 1160, messages: [['user', 1161], ['assistant', 1162]] })
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Title: "Imported CLI work"', usage: null }))

    const pinResponse = await post('/api/session/pin', { session_id: 'cli-pinned', pinned: true })
    expect(pinResponse.status, await pinResponse.clone().text() + s.logs.join('\n')).toBe(200)

    await vi.waitFor(async () => { expect((await s.deps.sessionStore.get('cli-pinned')).title).toBe('Imported CLI work') })
  })

  it('does not recreate a claimed CLI session deleted while its title prompt ran (TAL-591)', async () => {
    insertSession(db, { id: 'cli-gone', source: 'cli', started_at: 1170, messages: [['user', 1171], ['assistant', 1172]] })
    let titled = false
    sidecar.respond('aux.complete', async () => {
      expect((await post('/api/session/delete', { session_id: 'cli-gone' })).status).toBe(200)
      titled = true
      return { model: 'aux', text: 'Title: "Too late"', usage: null }
    })

    expect((await post('/api/session/pin', { session_id: 'cli-gone', pinned: true })).status).toBe(200)
    await vi.waitFor(() => { expect(titled).toBe(true) })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(existsSync(sessionPath(s.deps.sessionStore, 'cli-gone'))).toBe(false)
  })

  it('counts a claimed CLI session\'s title job as profile activity until it settles (TAL-591)', async () => {
    insertSession(db, { id: 'cli-busy', source: 'cli', started_at: 1180, messages: [['user', 1181], ['assistant', 1182]] })
    let finish: () => void = () => undefined
    sidecar.respond('aux.complete', () => new Promise((resolve) => { finish = () => { resolve({ model: 'aux', text: 'Title: "Busy CLI work"', usage: null }) } }))
    const runsActive = (): boolean => (s.deps.profiles as unknown as { deps: { profileRunsActive: (name: string) => boolean } }).deps.profileRunsActive('default')

    expect((await post('/api/session/pin', { session_id: 'cli-busy', pinned: true })).status).toBe(200)
    await vi.waitFor(() => { expect(sidecar.calls.some((c) => c.method === 'aux.complete' && JSON.stringify(c.params).includes('user says'))).toBe(true) })
    expect(runsActive()).toBe(true)

    finish()
    await vi.waitFor(async () => { expect((await s.deps.sessionStore.get('cli-busy')).title).toBe('Busy CLI work') })
    await vi.waitFor(() => { expect(runsActive()).toBe(false) })
  })

  it('files a claimed webhook session in the Webhooks project its sidebar row already shows', async () => {
    insertSession(db, { id: 'hook-run', source: 'webhook', started_at: 1200, title: 'Hook run', messages: [['user', 1201], ['assistant', 1202]] })

    expect((await post('/api/session/pin', { session_id: 'hook-run', pinned: true })).status).toBe(200)

    const webhooks = (await s.deps.projects.ensureSystemProject('webhook', 'default', { create: false }))
    expect(webhooks).toBeTruthy()
    expect((await s.deps.sessionStore.get('hook-run')).project_id).toBe(webhooks)
  })
})

describe('Kanban worker sessions (TAL-793)', () => {
  let s: TestServer
  let db: DatabaseSync
  const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  beforeAll(async () => {
    s = await bootTestServer({ sidecar: new FakeSidecar() })
    db = createStateDb(join(s.state, 'state.db'))
    // Agent schema v31's immutable `created_source`.
    db.exec('ALTER TABLE sessions ADD COLUMN created_source TEXT; ALTER TABLE sessions ADD COLUMN model_config TEXT')
    const insert = (row: Parameters<typeof insertSession>[1], createdSource: string, modelConfig: Json | null = null): void => {
      insertSession(db, row)
      db.prepare('UPDATE sessions SET created_source = ?, model_config = ? WHERE id = ?').run(createdSource, modelConfig ? JSON.stringify(modelConfig) : null, row.id)
    }
    const turns = (t: number): [string, number][] => [['user', t + 1], ['assistant', t + 2], ['user', t + 3], ['assistant', t + 4]]
    insert({ id: 'kanban-w1', source: 'kanban', started_at: 1000, title: 'Worker run', messages: turns(1000) }, 'kanban')
    // A worker transcript whose live `source` a later surface flipped to `cli`.
    insert({ id: 'kanban-retagged', source: 'cli', started_at: 1100, title: 'Retagged worker run', messages: turns(1100) }, 'kanban')
    // A worker transcript compressed into a continuation the Agent created as `cli`: the lineage stays Kanban-owned.
    insert({ id: 'kanban-root', source: 'cli', started_at: 1200, title: 'Rotated worker run', ended_at: 1300, end_reason: 'compression', messages: turns(1200) }, 'kanban')
    insert({ id: 'kanban-tip', source: 'cli', started_at: 1300.5, title: 'Rotated worker run', parent: 'kanban-root', messages: turns(1300) }, 'cli')
    /** A `length`-segment compression chain `<prefix>-0` (root, created by Kanban) .. tip, one segment every `step` s from `start`. */
    const chain = (prefix: string, length: number, start: number, step: number, rootSource: string): void => {
      for (let i = 0; i < length; i += 1) {
        const t = start + i * step
        insert({ id: `${prefix}-${String(i)}`, source: i ? 'cli' : rootSource, started_at: t, title: 'Long worker run', parent: i ? `${prefix}-${String(i - 1)}` : null, ...(i < length - 1 ? { ended_at: t + step / 2, end_reason: 'compression' } : {}), messages: turns(t) }, i ? 'cli' : 'kanban')
      }
    }
    // A long-running worker rotated past the transcript stitch's 20 hops: only its root still says Kanban.
    chain('kanban-long', 31, 2000, 10, 'cli')
    // TAL-995: the Agent's `_resume_lineage_ids` reads at most 100 ids, so a Kanban root 100 segments back is out of reach.
    // Older than every other row, so the sidebar's CLI cap drops these segments rather than the rows the list checks read.
    chain('kanban-100', 100, 0, 4, 'kanban')
    chain('kanban-101', 101, 400, 4, 'kanban')
    // The Agent's compression edge needs neither a matching source nor a prompt start: a later CLI continuation is owned,
    // while a branch or reset fork of the same worker is its own conversation.
    insert({ id: 'kanban-gap-root', source: 'kanban', started_at: 3000, title: 'Worker run', ended_at: 3005, end_reason: 'compression', messages: turns(3000) }, 'kanban')
    insert({ id: 'kanban-gap-tip', source: 'cli', started_at: 3500, title: 'Worker run', parent: 'kanban-gap-root', messages: turns(3500) }, 'cli')
    insert({ id: 'kanban-branch', source: 'cli', started_at: 3600, title: 'Branched from a worker', parent: 'kanban-gap-root', messages: turns(3600) }, 'cli', { _branched_from: 'kanban-gap-root' })
    insert({ id: 'kanban-reset', source: 'cli', started_at: 3700, title: 'Reset from a worker', parent: 'kanban-gap-root', messages: turns(3700) }, 'cli', { _reset_from: 'kanban-gap-root' })
    insert({ id: 'cli-plain', source: 'cli', started_at: 1400, title: 'Plain CLI work', messages: turns(1400) }, 'cli')
    insert({ id: 'cli-unknown-owner', source: 'cli', started_at: 1500, title: 'Owner read fails', messages: turns(1500) }, 'cli')
    await s.deps.settings.save({ show_cli_sessions: true, show_kanban_sessions: true })
  })
  afterAll(async () => { db.close(); await s.close() })

  const owned = ['kanban-w1', 'kanban-retagged', 'kanban-tip', 'kanban-long-30', 'kanban-gap-tip']

  it('opens a Kanban-owned transcript read-only, by source, created_source or lineage, and refuses messaging and claiming it', async () => {
    const rows = (await json(await s.get('/api/sessions'))).sessions as Json[]
    for (const sid of owned) {
      expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).read_only, `${sid} detail`).toBe(true)
      expect(rows.find((r) => r.session_id === sid)?.read_only, `${sid} list`).toBe(true)
      expect((await post('/api/chat/start', { session_id: sid, message: 'carry on' })).status, `${sid} chat`).toBe(403)
      expect((await post('/api/session/rename', { session_id: sid, title: 'claimed' })).status, `${sid} claim`).toBe(403)
      expect((await s.deps.sessionStore.loadMetadataOnly(sid)), sid).toBeNull()
    }
  })

  it('locks a sidecar an earlier claim left on a Kanban-owned transcript', async () => {
    await s.deps.sessionStore.save(new Session({ session_id: 'kanban-retagged', title: 'Retagged worker run', source_tag: 'cli', raw_source: 'cli', is_cli_session: true, messages: [{ role: 'user', content: 'hi', timestamp: 1101 }] }, { workspace: s.state, model: null }))
    expect(((await json(await s.get('/api/session?session_id=kanban-retagged'))).session as Json).read_only).toBe(true)
    expect((await post('/api/chat/start', { session_id: 'kanban-retagged', message: 'carry on' })).status).toBe(403)
  })

  it('keeps a lineage whose Kanban root is past the Agent\'s 100 resume ids claimable (TAL-995)', async () => {
    expect(((await json(await s.get('/api/session?session_id=kanban-100-99'))).session as Json).read_only).toBe(true)
    expect((await post('/api/session/rename', { session_id: 'kanban-100-99', title: 'Claimed' })).status).toBe(403)
    expect(((await json(await s.get('/api/session?session_id=kanban-101-100'))).session as Json).read_only).toBe(false)
    expect((await post('/api/session/rename', { session_id: 'kanban-101-100', title: 'Claimed' })).status).toBe(200)
  })

  it('keeps a branch or reset fork of a Kanban worker claimable', async () => {
    for (const sid of ['kanban-branch', 'kanban-reset']) {
      expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).read_only, sid).toBe(false)
      expect((await post('/api/session/rename', { session_id: sid, title: 'Forked' })).status, sid).toBe(200)
    }
  })

  it('refuses a claim when the owner read fails', async ({ onTestFinished }) => {
    const sessions = s.deps.sessions as unknown as { stateDbSources: (ids: string[]) => Map<string, string> | null }
    const read = sessions.stateDbSources
    sessions.stateDbSources = () => null
    onTestFinished(() => { sessions.stateDbSources = read })
    expect(((await json(await s.get('/api/session?session_id=cli-unknown-owner'))).session as Json).read_only).toBe(true)
    expect((await post('/api/session/rename', { session_id: 'cli-unknown-owner', title: 'claimed' })).status).toBe(403)
    expect((await s.deps.sessionStore.loadMetadataOnly('cli-unknown-owner'))).toBeNull()
  })

  it('keeps an ordinary CLI transcript claimable', async () => {
    expect(((await json(await s.get('/api/session?session_id=cli-plain'))).session as Json).read_only).toBe(false)
    expect(((await json(await s.get('/api/sessions'))).sessions as Json[]).find((r) => r.session_id === 'cli-plain')?.read_only).toBe(false)
    expect((await post('/api/session/pin', { session_id: 'cli-plain', pinned: true })).status).toBe(200)
    expect((await s.deps.sessionStore.loadMetadataOnly('cli-plain'))?.read_only).toBeFalsy()
  })

  it('reads the owner from `source` alone on a state.db without created_source', () => {
    const path = join(s.state, 'pre-v31', 'state.db')
    const old = createStateDb(path)
    insertSession(old, { id: 'old-kanban', source: 'kanban', started_at: 1, messages: [['user', 2]] })
    insertSession(old, { id: 'old-cli', source: 'cli', started_at: 1, messages: [['user', 2]] })
    old.close()
    expect(stateDbSessionSources(path, ['old-kanban', 'old-cli'])).toEqual(new Map([['old-kanban', 'kanban'], ['old-cli', 'cli']]))
  })
})

describe('indexed sidebar window (TAL-1163)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tal-1163-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  const interactive: ReadRowsOptions = { limit: 5, excludeSources: ['cron', 'webhook', 'kanban'] }
  const cron: ReadRowsOptions = { limit: 5, excludeSources: null, includeSources: ['cron'] }
  /** Every fourth session is cron; each heartbeat lags its latest message by up to 60 s, so heartbeat order differs from message order. */
  const agentDb = (name: string, ddl = ''): string => {
    mkdirSync(join(dir, name))
    const path = join(dir, name, 'state.db')
    const db = openStateDb(path)
    db.exec(agentSchema.schema.join('\n'))
    const session = db.prepare('INSERT INTO sessions (id, source, title, started_at, last_activity_at, message_count) VALUES (?, ?, ?, ?, ?, 2)')
    const message = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 64; i += 1) {
      const id = `s-${i}`, latest = 10_000 + i * 10
      session.run(id, i % 4 === 0 ? 'cron' : 'cli', `Session ${i}`, latest - 1000, latest - (i * 37) % 61)
      message.run(id, 'user', 'hi', latest - 999)
      message.run(id, 'assistant', 'hello', latest)
    }
    db.exec(ddl)
    db.close()
    return path
  }
  const read = (path: string, opts: ReadRowsOptions): { ids: unknown[]; rows: Json[]; sql: string } => {
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      const rows = readImportableAgentSessionRows(path, opts)
      return { ids: rows.map((r) => r.id), rows, sql: prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('candidates AS'))! }
    } finally { prepare.mockRestore() }
  }
  /** The `EXPLAIN QUERY PLAN` details nested under the `candidates` CTE. */
  const candidatePlan = (path: string, sql: string): string[] => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array<null>(sql.split('?').length - 1).fill(null)) as { id: number; parent: number; detail: string }[]
      const inside = new Set([plan.find((r) => r.detail.includes('candidates'))!.id])
      for (const r of plan) if (inside.has(r.parent)) inside.add(r.id)
      return plan.filter((r) => inside.has(r.parent)).map((r) => r.detail)
    } finally { db.close() }
  }
  const indexed = agentDb('indexed')
  const expected = { interactive: ['s-63', 's-62', 's-61', 's-59', 's-58'], cron: ['s-60', 's-56', 's-52', 's-48', 's-44'] }

  it.each([['interactive', interactive], ['cron', cron]] as const)('walks idx_sessions_effective_activity for the %s pass', (pass, opts) => {
    const { ids, sql } = read(indexed, opts)
    expect(ids).toEqual(expected[pass])
    const plan = candidatePlan(indexed, sql)
    expect(plan).toContain('SCAN s USING INDEX idx_sessions_effective_activity')
    expect(plan).not.toContain('SCAN s')
    expect(plan.filter((detail) => detail.includes('TEMP B-TREE FOR ORDER BY'))).toEqual([])
  })

  it('ranks the indexed window exactly without idx_messages_session', () => {
    const path = agentDb('no-messages-index', 'DROP INDEX idx_messages_session')
    for (const opts of [interactive, cron]) expect(read(path, opts).rows).toEqual(read(indexed, opts).rows)
  })

  it.each([
    ['without the activity index', 'DROP INDEX idx_sessions_effective_activity'],
    ['without last_activity_at', 'DROP INDEX idx_sessions_effective_activity; ALTER TABLE sessions DROP COLUMN last_activity_at'],
  ])('keeps the exact message-recency window and its rows %s', (name, ddl) => {
    const legacy = agentDb(name.replaceAll(' ', '-'), ddl)
    for (const [pass, opts] of [['interactive', interactive], ['cron', cron]] as const) {
      const before = read(legacy, opts)
      expect(before.sql).toContain('ORDER BY COALESCE((SELECT MAX(mx.timestamp) FROM messages mx INDEXED BY idx_messages_session WHERE mx.session_id = s.id), s.started_at) DESC')
      expect(before.ids).toEqual(expected[pass])
      expect(read(indexed, opts).rows).toEqual(before.rows)
    }
  })
})

describe('remaining indexed readers (TAL-1188)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tal-1188-plans-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('bounds cron result batches, uses the source index, and retains infrequent jobs', () => {
    const path = join(dir, 'cron.db')
    const db = openStateDb(path)
    db.exec(agentSchema.schema.join('\n'))
    insertSession(db, { id: 'cron_rare_1', source: 'cron', started_at: 1 })
    for (let i = 0; i < 100; i += 1) insertSession(db, { id: `cron_hot_${i}`, source: 'cron', started_at: i + 2 })
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    let sql: string
    try {
      expect(latestCronSessionInfo(path, ['hot', 'rare'], ['hot', 'rare'])).toEqual(new Map([
        ['hot', { session_id: 'cron_hot_99', message_count: 0 }], ['rare', { session_id: 'cron_rare_1', message_count: 0 }],
      ]))
      sql = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('AS message_count FROM sessions s'))!
    } finally { prepare.mockRestore() }
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array<null>(sql.split('?').length - 1).fill(null)) as { detail: string }[]
      expect(plan.map((r) => r.detail).join('\n')).toMatch(/USING INDEX idx_sessions_source(_id)?/)
      expect(sql).toContain('LIMIT')
    } finally { db.close() }
  })

  it('counts the whole prompt as insights input so the cache hit rate divides reads by it (TAL-1173)', async () => {
    const path = join(dir, 'insights-cache.db')
    const db = openStateDb(path)
    db.exec(agentSchema.schema.join('\n'))
    insertSession(db, { id: 'cached', source: 'cli', started_at: 1_760_000_000, model: 'm' })
    db.exec("UPDATE sessions SET input_tokens = 100, cache_read_tokens = 900, cache_write_tokens = 0 WHERE id = 'cached'")
    db.close()
    const insights = await buildInsights([], '1', 1_760_000_050, (cutoff) => insightsSessionRows(path, cutoff))
    expect(insights).toMatchObject({ total_input_tokens: 1000, total_cache_read_tokens: 900, total_cache_hit_percent: 90 })
    expect((insights.models as Record<string, unknown>[])[0]).toMatchObject({ model: 'm', cache_hit_percent: 90 })
  })

  it.each(['indexed', 'no-message-index', 'legacy'])('keeps activity beyond a stale heartbeat on %s schemas', (schema) => {
    const path = join(dir, `insights-stale-${schema}.db`)
    const db = openStateDb(path)
    db.exec(agentSchema.schema.join('\n'))
    for (const [id, source, started_at, messageAt, heartbeat, endedAt] of [
      ['heartbeat', 'cli', 1, 950, 1000, null],
      ['message', 'telegram', 1, 1000, 800, null],
      ['end', 'cron', 1, 2, 800, 1100],
      ['null-heartbeat', 'cli', 1, 1000, null, null],
      ['start', 'cli', 1000, 1001, 800, null],
      ['old', 'cli', 1, 2, 800, 850],
      ['webui', 'webui', 1, 1000, 1000, null],
    ] as const) {
      insertSession(db, { id, source, started_at, messages: [['user', messageAt]] })
      db.prepare('UPDATE sessions SET last_activity_at = ?, ended_at = ? WHERE id = ?').run(heartbeat, endedAt, id)
    }
    if (schema === 'no-message-index') db.exec('DROP INDEX idx_messages_session')
    if (schema === 'legacy') db.exec('DROP INDEX idx_sessions_effective_activity; ALTER TABLE sessions DROP COLUMN last_activity_at')
    db.close()
    const rows = insightsSessionRows(path, 900)
    expect(new Map(rows.map((row) => [row.session_id, row.updated_at]))).toEqual(new Map([
      ['heartbeat', schema === 'legacy' ? 950 : 1000], ['message', 1000], ['end', 1100], ['null-heartbeat', 1000], ['start', 1001],
    ]))
    expect(rows).toHaveLength(5)
  })

  it('range-scans the activity index before checking message freshness', () => {
    const path = join(dir, 'insights.db')
    const db = openStateDb(path)
    db.exec(agentSchema.schema.join('\n'))
    insertSession(db, { id: 'recent', source: 'cli', started_at: 1, messages: [['user', 1050]] })
    insertSession(db, { id: 'old', source: 'cli', started_at: 1, messages: [['user', 2]] })
    db.exec("UPDATE sessions SET last_activity_at = 1000 WHERE id = 'recent'")
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    let sql: string
    try {
      expect(insightsSessionRows(path, 900)).toMatchObject([{ session_id: 'recent', updated_at: 1050 }])
      sql = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('AS last_activity') && sql.includes('AS estimated_cost_usd'))!
    } finally { prepare.mockRestore() }
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array<number>(sql.split('?').length - 1).fill(900)) as { detail: string }[]
      expect(plan.map((r) => r.detail).join('\n')).toContain('SEARCH s USING INDEX idx_sessions_effective_activity')
      expect(plan.some((r) => /^SCAN s(?: |$)/.test(r.detail))).toBe(false)
    } finally { db.close() }
  })
})

describe('session lineage report', () => {
  let dir: string
  let n = 0
  beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'lineage-report-'))) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  /** The Agent's `sessions` columns, including `session_source` for forks; rows are inserted in the order given. */
  function lineageDb(path: string, rows: { id: string; parent?: string; started_at: number; ended_at?: number; end_reason?: string; source?: string; session_source?: string }[]): string {
    mkdirSync(join(path, '..'), { recursive: true })
    const db = openStateDb(path)
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, session_source TEXT, title TEXT, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0,
      parent_session_id TEXT, ended_at REAL, end_reason TEXT);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)`)
    for (const r of rows) {
      db.prepare("INSERT INTO sessions (id, source, session_source, title, model, started_at, message_count, parent_session_id, ended_at, end_reason) VALUES (?, ?, ?, ?, 'openai/gpt-5', ?, 2, ?, ?, ?)")
        .run(r.id, r.source ?? 'webui', r.session_source ?? null, r.id.replace(/_/g, ' '), r.started_at, r.parent ?? null, r.ended_at ?? null, r.end_reason ?? null)
    }
    db.close()
    return path
  }
  const fresh = (rows: Parameters<typeof lineageDb>[1]): string => { n += 1; return lineageDb(join(dir, String(n), 'state.db'), rows) }
  const t0 = 1_000_000
  const ids = (rows: unknown): string[] => (rows as Json[]).map((r) => String(r.session_id))

  it('walks continuation parents tip first without mutating', () => {
    const db = fresh([
      { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_mid', parent: 'lineage_report_root', started_at: t0 + 6, ended_at: t0 + 12, end_reason: 'cli_close' },
      { id: 'lineage_report_tip', parent: 'lineage_report_mid', started_at: t0 + 13 },
    ])
    const report = stateDbLineageReport(db, 'lineage_report_tip')
    expect(report).toMatchObject({ mutation: false, found: true, session_id: 'lineage_report_tip', lineage_key: 'lineage_report_root', tip_session_id: 'lineage_report_tip', total_segments: 3, materialized_segments: 3, children: [], manual_review: false })
    expect(ids(report.segments)).toEqual(['lineage_report_tip', 'lineage_report_mid', 'lineage_report_root'])
    expect((report.segments as Json[]).map((s) => s.role)).toEqual(['tip', 'hidden_segment', 'hidden_segment'])
    expect(report).not.toHaveProperty('archive_candidates')
    expect(report).not.toHaveProperty('delete_candidates')
  })

  it('stops at a parent from another source', () => {
    const db = fresh([
      { id: 'lineage_report_telegram_parent', source: 'telegram', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_webui_tip', parent: 'lineage_report_telegram_parent', started_at: t0 + 6 },
    ])
    const report = stateDbLineageReport(db, 'lineage_report_webui_tip')
    expect(report).toMatchObject({ lineage_key: 'lineage_report_webui_tip', total_segments: 1, children: [] })
    expect((report.segments as Json[]).map((s) => [s.session_id, s.role])).toEqual([['lineage_report_webui_tip', 'tip']])
  })

  it('treats an explicit fork as its own lineage', () => {
    const db = fresh([
      { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_fork', parent: 'lineage_report_root', started_at: t0 + 6, session_source: 'fork' },
    ])
    const report = stateDbLineageReport(db, 'lineage_report_fork')
    expect(report).toMatchObject({ lineage_key: 'lineage_report_fork', tip_session_id: 'lineage_report_fork', total_segments: 1, children: [], manual_review: false })
    expect((report.segments as Json[]).map((s) => [s.session_id, s.role])).toEqual([['lineage_report_fork', 'tip']])
  })

  it('projects a fork as a child, not a segment', () => {
    const path = fresh([
      { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_fork', parent: 'lineage_report_root', started_at: t0 + 6, session_source: 'fork' },
    ])
    const db = openStateDb(path)
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('lineage_report_fork', 'user', 'hello', ?)").run(t0 + 7)
    db.close()
    const rows = readImportableAgentSessionRows(path, { excludeSources: [] })
    expect(rows.map((r) => r.id)).toEqual(['lineage_report_fork'])
    expect(rows[0]).toMatchObject({ relationship_type: 'child_session', parent_session_id: 'lineage_report_root', _parent_lineage_root_id: 'lineage_report_root' })
    expect(rows[0]).not.toHaveProperty('_lineage_root_id')
    expect(rows[0]).not.toHaveProperty('_compression_segment_count')
  })

  it('lists a non-continuation child', () => {
    const db = fresh([
      { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_tip', parent: 'lineage_report_root', started_at: t0 + 6, ended_at: t0 + 15, end_reason: 'user_stop' },
      { id: 'lineage_report_child', parent: 'lineage_report_tip', started_at: t0 + 8 },
    ])
    const report = stateDbLineageReport(db, 'lineage_report_tip')
    expect(report).toMatchObject({ lineage_key: 'lineage_report_root', mutation: false })
    expect(ids(report.segments)).toEqual(['lineage_report_tip', 'lineage_report_root'])
    expect(report.children).toEqual([{ session_id: 'lineage_report_child', role: 'child_session', title: 'lineage report child', source: 'webui', started_at: t0 + 8, updated_at: t0 + 8, end_reason: null, active: true, archived: false }])
  })

  it('flags a walk that hits the hop limit', () => {
    const db = fresh([
      { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_mid', parent: 'lineage_report_root', started_at: t0 + 6, ended_at: t0 + 12, end_reason: 'compression' },
      { id: 'lineage_report_tip', parent: 'lineage_report_mid', started_at: t0 + 13 },
    ])
    const report = stateDbLineageReport(db, 'lineage_report_tip', 1)
    expect(report).toMatchObject({ mutation: false, manual_review: true, total_segments: 2 })
    expect(ids(report.segments)).toEqual(['lineage_report_tip', 'lineage_report_mid'])
  })

  it('orders each parent\'s children newest first', () => {
    const db = fresh([
      { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'lineage_report_tip', parent: 'lineage_report_root', started_at: t0 + 6, ended_at: t0 + 15, end_reason: 'user_stop' },
      { id: 'lineage_report_child_old', parent: 'lineage_report_tip', started_at: t0 + 8 },
      { id: 'lineage_report_child_new', parent: 'lineage_report_tip', started_at: t0 + 20 },
    ])
    expect(ids(stateDbLineageReport(db, 'lineage_report_tip').children)).toEqual(['lineage_report_child_new', 'lineage_report_child_old'])
  })

  it('reads a database it cannot write', () => {
    const db = fresh([
      { id: 'parent-1', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
      { id: 'child-1', parent: 'parent-1', started_at: t0 + 6 },
    ])
    chmodSync(db, 0o444)
    chmodSync(join(db, '..'), 0o555)
    try {
      expect(stateDbLineageReport(db, 'child-1')).toMatchObject({ found: true, lineage_key: 'parent-1', total_segments: 2 })
    } finally {
      chmodSync(join(db, '..'), 0o755)
    }
  })

  /** TAL-893: a `length`-segment compression chain `seg-000` (root) .. tip, one message per segment; `cyclic` makes the root the tip's continuation. */
  function chain(length: number, cyclic = false): { path: string; segments: string[] } {
    const segments = Array.from({ length }, (_, i) => `seg-${String(i).padStart(3, '0')}`)
    const parent = (i: number): string | undefined => (i ? segments[i - 1] : cyclic ? segments[length - 1] : undefined)
    const path = fresh(segments.map((id, i) => ({
      id, started_at: t0 + i * 10, ...(parent(i) ? { parent: parent(i)! } : {}),
      ...(i < length - 1 || cyclic ? { end_reason: 'compression', ...(cyclic ? {} : { ended_at: t0 + i * 10 + 5 }) } : {}),
    })))
    const db = openStateDb(path)
    for (const [i, id] of segments.entries()) db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)").run(id, `${id} says`, t0 + i * 10 + 1)
    db.close()
    return { path, segments }
  }

  it.each([30, 200])('follows a %i-segment compression chain from the root to the tip (TAL-893)', (length) => {
    const { path, segments } = chain(length)
    expect(stateDbCompressionLineage(path, segments[0]!)).toEqual(segments)
  })

  it.each([30, 200])('stitches every segment of a %i-segment compression chain read from the tip (TAL-893)', (length) => {
    const { path, segments } = chain(length)
    expect(stateDbSessionRead(path, segments.at(-1)!).rows.map((m) => m.content)).toEqual(segments.map((id) => `${id} says`))
  })

  it.each([30, 200])('reports every segment of a %i-segment compression chain from the tip (TAL-893)', (length) => {
    const { path, segments } = chain(length)
    expect(stateDbLineageReport(path, segments.at(-1)!)).toMatchObject({ found: true, total_segments: length, manual_review: false, lineage_key: segments[0], tip_session_id: segments.at(-1) })
  })

  it('stops a cyclic compression chain after one lap (TAL-893)', () => {
    const { path, segments } = chain(3, true)
    expect(stateDbCompressionLineage(path, segments[0]!)).toEqual(segments)
    expect(stateDbSessionRead(path, segments[2]!).rows.map((m) => m.content)).toEqual(segments.map((id) => `${id} says`))
    expect(stateDbLineageReport(path, segments[2]!)).toMatchObject({ found: true, total_segments: 3, manual_review: true })
  })

  describe('GET /api/session/lineage/report', () => {
    let s: TestServer
    beforeAll(async () => {
      s = await bootTestServer()
      lineageDb(join(s.state, 'state.db'), [
        { id: 'lineage_report_root', started_at: t0, ended_at: t0 + 5, end_reason: 'compression' },
        { id: 'lineage_report_tip', parent: 'lineage_report_root', started_at: t0 + 6 },
      ])
    })
    afterAll(() => s.close())

    it('reports from the active profile\'s state.db', async () => {
      const res = await s.get('/api/session/lineage/report?session_id=lineage_report_tip')
      expect(res.status).toBe(200)
      expect(await json(res)).toMatchObject({ mutation: false, found: true, lineage_key: 'lineage_report_root', total_segments: 2 })
    })

    it('answers 404 for an unknown id and 400 without one', async () => {
      let res = await s.get('/api/session/lineage/report?session_id=missing_lineage_report_session')
      expect([res.status, await json(res)]).toEqual([404, { error: 'Session not found' }])
      res = await s.get('/api/session/lineage/report')
      expect([res.status, await json(res)]).toEqual([400, { error: 'session_id required' }])
    })
  })
})

describe('foreign session detail windows (TAL-1249)', () => {
  let s: TestServer
  let db: DatabaseSync
  const secret = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const canonical = agentSchema.sessions.cli
  const detail = async (sid: string, query: string): Promise<[number, Json]> => {
    const res = await s.get(`/api/session?session_id=${sid}${query}`)
    return [res.status, ((await json(res)).session ?? {}) as Json]
  }
  /** The state.db transcript reads (worker requests) and turn projections one request makes. */
  const observed = async <T>(run: () => Promise<T>): Promise<{ result: T; transcriptReads: string[]; projections: number }> => {
    const posted = vi.spyOn(Worker.prototype, 'postMessage')
    const project = vi.spyOn(s.deps.sessions, 'foreignMessages')
    try {
      const result = await run()
      const reads = posted.mock.calls.map(([request]) => (request as { op?: string; read?: string })).filter((call) => call.op === 'session').map((call) => str(call.read))
      return { result, transcriptReads: reads.filter((r) => ['stateDbSessionRead', 'stateDbSessionMessages'].includes(r)), projections: project.mock.calls.length }
    } finally { posted.mockRestore(); project.mockRestore() }
  }
  const insertRows = (sid: string, rows: { role: string; content: string; ts: number; tool_calls?: unknown; tool_call_id?: string; tool_name?: string }[]): void => {
    for (const row of rows) {
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp, tool_calls, tool_call_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sid, row.role, row.content, row.ts, row.tool_calls ? JSON.stringify(row.tool_calls) : null, row.tool_call_id ?? null, row.tool_name ?? null)
    }
  }
  const session = (id: string, source: string, startedAt: number, extra: { parent?: string; ended_at?: number; end_reason?: string; count: number }): void => {
    db.prepare('INSERT INTO sessions (id, source, started_at, title, model, message_count, parent_session_id, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, source, startedAt, `${id} title`, 'fixture-model', extra.count, extra.parent ?? null, extra.ended_at ?? null, extra.end_reason ?? null)
  }
  const call = (id: string, name: string): unknown => [{ id, type: 'function', function: { name, arguments: '{}' } }]

  beforeAll(async () => {
    s = await bootTestServer({ sidecar: new FakeSidecar() })
    db = openStateDb(join(s.state, 'state.db'))
    db.exec(agentSchema.schema.join('\n'))
    for (const sql of agentSchema.inserts) db.exec(sql)
    await s.deps.settings.save({ show_cli_sessions: true })
    // A CLI conversation the Agent closed: a todo write, a large tool result with a credential, and turns across pages.
    session('f-cli', 'cli', 1000, { ended_at: 1011, end_reason: 'cli_close', count: 10 })
    insertRows('f-cli', [
      { role: 'user', content: 'Plan the release', ts: 1001 },
      { role: 'assistant', content: '', ts: 1002, tool_calls: call('call-todo', 'todo') },
      { role: 'tool', content: JSON.stringify({ todos: [{ id: '1', content: 'ship it', status: 'in_progress' }] }), ts: 1003, tool_call_id: 'call-todo', tool_name: 'todo' },
      { role: 'assistant', content: 'Planned.', ts: 1004 },
      { role: 'user', content: `Read the log with ${secret}`, ts: 1005 },
      { role: 'assistant', content: '', ts: 1006, tool_calls: call('call-log', 'read_file') },
      { role: 'tool', content: `${'log line\n'.repeat(800)}${secret}`, ts: 1007, tool_call_id: 'call-log', tool_name: 'read_file' },
      { role: 'assistant', content: 'Log read.', ts: 1008 },
      { role: 'user', content: 'Thanks', ts: 1009 },
      { role: 'assistant', content: 'Done.', ts: 1010 },
    ])
    // A delegated child: display-only.
    session('f-sub', 'subagent', 1100, { parent: 'f-cli', count: 3 })
    insertRows('f-sub', [{ role: 'user', content: 'Sub task', ts: 1101 }, { role: 'assistant', content: 'Sub working', ts: 1102 }, { role: 'assistant', content: 'Sub done', ts: 1103 }])
    // A compression continuation: the tip's transcript starts in its parent.
    session('f-root', 'cli', 2000, { ended_at: 2003, end_reason: 'compression', count: 3 })
    insertRows('f-root', [{ role: 'user', content: 'Root one', ts: 2001 }, { role: 'assistant', content: 'Root two', ts: 2002 }, { role: 'user', content: 'Root three', ts: 2003 }])
    session('f-tip', 'cli', 2003, { parent: 'f-root', count: 3 })
    insertRows('f-tip', [{ role: 'assistant', content: 'Tip one', ts: 2004 }, { role: 'user', content: 'Tip two', ts: 2005 }, { role: 'assistant', content: 'Tip three', ts: 2006 }])
    // A row whose transcript is empty, and a deleted Web chat whose state.db rows outlive it.
    session('f-empty', 'cli', 3000, { count: 0 })
    session('f-gone', 'webui', 3100, { count: 2 })
    insertRows('f-gone', [{ role: 'user', content: 'Deleted', ts: 3101 }, { role: 'assistant', content: 'Gone', ts: 3102 }])
    await s.deps.sessionStore.recordDeletedTombstone('f-gone')
  })
  afterAll(async () => { db.close(); await s.close() })

  it.each(['f-cli', 'f-sub', 'f-tip', canonical])('answers messages=0 for %s from metadata alone, with the full read\'s count, recency and ownership', async (sid) => {
    const [fullStatus, full] = await detail(sid, '&messages=1')
    expect(fullStatus).toBe(200)
    expect((full.messages as Json[]).length).toBeGreaterThanOrEqual(3)
    const { result: [status, meta], transcriptReads, projections } = await observed(() => detail(sid, '&messages=0'))
    expect(status).toBe(200)
    expect(meta.messages).toEqual([])
    expect(transcriptReads).toEqual([])
    expect(projections).toBe(0)
    for (const key of ['message_count', 'last_message_at', 'read_only', 'read_only_reason', 'is_cli_session', 'source_tag', 'title', 'profile']) expect(meta[key], key).toEqual(full[key])
    expect(await s.deps.sessionStore.exists(sid)).toBe(false)
  })

  it.each([['f-cli', 2], ['f-tip', 2], ['f-cli', 1]] as const)('pages %s with msg_limit=%i consistently with the full read', async (sid, limit) => {
    const [, full] = await detail(sid, '&messages=1')
    const all = full.messages as Json[]
    let before: number | null = null
    const covered: Json[] = []
    for (let page = 0; page < all.length + 1; page += 1) {
      const [status, window] = await detail(sid, `&messages=1&msg_limit=${String(limit)}${before === null ? '' : `&msg_before=${String(before)}`}`)
      expect(status).toBe(200)
      const rows = window.messages as Json[]
      const offset = Number(window._messages_offset)
      expect(rows.length).toBeLessThan(all.length)
      expect(offset + rows.length).toBe(before ?? all.length)
      expect(window._messages_truncated).toBe(offset > 0)
      expect(window.message_count).toBe(full.message_count)
      expect(window.last_message_at).toBe(full.last_message_at)
      expect(window.todo_state).toEqual(full.todo_state)
      for (const [i, row] of rows.entries()) {
        const same = all[offset + i]!
        expect([row.timestamp, row.role, row._turn_id], String(offset + i)).toEqual([same.timestamp, same.role, same._turn_id])
        if (row.role === 'tool' && str(same.content).length > 4096) expect(row._content_truncated).toBe(true)
        else expect(row.content).toEqual(same.content)
      }
      expect(JSON.stringify(rows)).not.toContain(secret)
      covered.unshift(...rows)
      if (offset === 0) break
      before = offset
    }
    expect(covered.map((m) => m.timestamp)).toEqual(all.map((m) => m.timestamp))
    expect(await s.deps.sessionStore.exists(sid)).toBe(false)
  })

  it('keeps the full read\'s todo list and tool outcome on a page without them', async () => {
    const [, full] = await detail('f-cli', '&messages=1')
    expect((full.todo_state as Json).todos).toHaveLength(1)
    const [, page] = await detail('f-cli', '&messages=1&msg_limit=1')
    expect((page.messages as Json[]).map((m) => m.content)).toEqual(['Done.'])
    expect(page.todo_state).toEqual(full.todo_state)
  })

  it.each(['&messages=0', '&messages=1', '&messages=1&msg_limit=2'])('answers 404 for an empty or tombstoned row and keeps refusing claims (%s)', async (query) => {
    expect((await detail('f-empty', query))[0]).toBe(404)
    expect((await detail('f-gone', query))[0]).toBe(404)
    const [, sub] = await detail('f-sub', query)
    expect(sub).toMatchObject({ read_only: true, is_cli_session: false })
    const [, owned] = await detail(canonical, query)
    expect(owned.read_only).toBe(true)
    expect(owned.read_only_reason).toContain('gateway')
    for (const sid of ['f-empty', 'f-gone', 'f-sub', canonical]) expect(await s.deps.sessionStore.exists(sid)).toBe(false)
    // Another profile's row answers 409 before any transcript read.
    const lookup = vi.spyOn(s.deps.sessions as unknown as { lookupCliMeta: (sid: string) => Promise<Json | null> }, 'lookupCliMeta').mockResolvedValue({ session_id: 'f-cli', profile: 'other', source_tag: 'cli' })
    try {
      const { result: [status], transcriptReads, projections } = await observed(() => detail('f-cli', query))
      expect([status, transcriptReads, projections]).toEqual([409, [], 0])
    } finally { lookup.mockRestore() }
  })

  it.each(['&messages=0', '&messages=1', '&messages=1&msg_limit=2'])('answers an unreadable state.db as unknown, never as an empty or missing session (%s)', async (query) => {
    const other = await bootTestServer()
    try {
      mkdirSync(join(other.state, 'state.db'))
      const res = await other.get(`/api/session?session_id=f-cli${query}`)
      expect(res.status).toBe(503)
      expect(await other.deps.sessionStore.exists('f-cli')).toBe(false)
    } finally { await other.close() }
  })
})

describe('one-shot Agent runs and the interactive window (TAL-1379)', () => {
  let s: TestServer
  let db: DatabaseSync
  const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const listed = async (): Promise<Json[]> => { s.deps.cliSessions.invalidate(); return (await json(await s.get('/api/sessions'))).sessions as Json[] }
  const twoTurns = (t: number): [string, number][] => [['user', t + 1], ['assistant', t + 2], ['user', t + 3], ['assistant', t + 4]]
  const ordinary = ['cli-chat', 'tui-chat', 'desktop-chat']
  const burst = (from: number, count: number, at: number): void => {
    for (let i = from; i < from + count; i++) insertSession(db, { id: `oneshot-${String(i)}`, source: 'oneshot', started_at: at + i * 10, title: `One-shot ${String(i)}`, messages: twoTurns(at + i * 10) })
  }
  beforeAll(async () => {
    s = await bootTestServer({ sidecar: new FakeSidecar() })
    db = createStateDb(join(s.state, 'state.db'))
    insertSession(db, { id: 'oneshot-old', source: 'oneshot', started_at: 50, title: 'Old one-shot', messages: twoTurns(50) })
    for (const [i, sid] of ordinary.entries()) insertSession(db, { id: sid, source: sid.split('-')[0]!, started_at: 100 + i * 10, title: `Named ${sid}`, messages: twoTurns(100 + i * 10) })
    burst(0, CLI_VISIBLE_SESSION_LIMIT + 5, 1000)
    await s.deps.settings.save({ show_cli_sessions: true })
  })
  afterAll(async () => { db.close(); await s.close() })

  it('keeps older CLI, TUI and Desktop chats listed past a burst of newer one-shot runs', async () => {
    const rows = await listed()
    expect(rows.map((r) => r.session_id)).toEqual(expect.arrayContaining(ordinary))
    expect(rows.filter((r) => r.raw_source === 'oneshot')).toEqual([])
  })

  it('still lists one-shot runs for an explicit source filter, with the truncation flag', async () => {
    s.deps.cliSessions.invalidate()
    const read = await s.deps.cliSessions.read('default', { sourceFilter: 'oneshot' })
    expect(read.rows.map((r) => r.raw_source)).toEqual(Array<string>(CLI_VISIBLE_SESSION_LIMIT + 6).fill('oneshot'))
    expect(read.truncated.has('oneshot')).toBe(false)
    burst(100, 200, 5000)
    s.deps.cliSessions.invalidate()
    const full = await s.deps.cliSessions.read('default', { sourceFilter: 'oneshot' })
    expect(full.rows).toHaveLength(200)
    expect(full.truncated.has('oneshot')).toBe(true)
    expect((await listed()).map((r) => r.session_id)).toEqual(expect.arrayContaining(ordinary))
  })

  it('opens an old one-shot run by exact id and keeps its saved, pinned, project-filed alias listed', async () => {
    expect(((await json(await s.get('/api/session?session_id=oneshot-old'))).session as Json).session_id).toBe('oneshot-old')
    const project = String(((await json(await post('/api/projects/create', { name: 'One-shots' }))).project as Json).project_id)
    expect((await post('/api/session/rename', { session_id: 'oneshot-old', title: 'Kept one-shot' })).status).toBe(200)
    expect((await post('/api/session/pin', { session_id: 'oneshot-old', pinned: true })).status).toBe(200)
    expect((await post('/api/session/move', { session_id: 'oneshot-old', project_id: project })).status).toBe(200)
    const row = (await listed()).find((r) => r.session_id === 'oneshot-old')
    expect(row).toMatchObject({ title: 'Kept one-shot', pinned: true, project_id: project, workspace: expect.any(String) as unknown })
    expect(((await json(await s.get('/api/session?session_id=oneshot-old'))).session as Json)).toMatchObject({ title: 'Kept one-shot', project_id: project })
  })
})

describe('subagent sessions nest under their parent (TAL-1151)', () => {
  let s: TestServer
  let db: DatabaseSync
  beforeAll(async () => {
    s = await bootTestServer()
    db = createStateDb(join(s.state, 'state.db'))
    const saved = async (session_id: string, title: string, extra: Record<string, unknown> = {}): Promise<void> => {
      await s.deps.sessionStore.save(new Session({ session_id, title, messages: [{ role: 'user', content: 'go', timestamp: 1001 }, { role: 'assistant', content: 'ok', timestamp: 1002 }], ...extra }, { workspace: s.state, model: null }))
    }
    await saved('web-parent', 'Zebra plan', { project_id: 'proj-p' })
    insertSession(db, { id: 'web-parent', source: 'webui', started_at: 1000, title: 'Zebra plan', messages: [['user', 1001], ['assistant', 1002]] })
    insertSession(db, { id: 'sub-web', source: 'subagent', started_at: 1003, title: 'Zebra worker', parent: 'web-parent', messages: [['user', 1004], ['assistant', 1005]] })
    insertSession(db, { id: 'sub-nested', source: 'subagent', started_at: 1006, parent: 'sub-web', messages: [['user', 1007], ['assistant', 1008]] })
    insertSession(db, { id: 'cli-host', source: 'cli', started_at: 1100, title: 'CLI host', messages: [['user', 1101], ['assistant', 1102]] })
    insertSession(db, { id: 'sub-cli', source: 'subagent', started_at: 1103, parent: 'cli-host', messages: [['user', 1104], ['assistant', 1105]] })
    insertSession(db, { id: 'cmp-root', source: 'cli', started_at: 1200, title: 'Long chat', messages: [['user', 1201], ['assistant', 1202]], ended_at: 1210, end_reason: 'compression' })
    insertSession(db, { id: 'cmp-seg2', source: 'cli', started_at: 1210.2, parent: 'cmp-root', messages: [['user', 1211]], ended_at: 1220, end_reason: 'compression' })
    insertSession(db, { id: 'cmp-seg3', source: 'cli', started_at: 1220.3, parent: 'cmp-seg2', messages: [['user', 1221], ['assistant', 1230]] })
    insertSession(db, { id: 'sub-cmp', source: 'subagent', started_at: 1215, parent: 'cmp-seg2', messages: [['user', 1216], ['assistant', 1217]] })
    insertSession(db, { id: 'sub-orphan', source: 'subagent', started_at: 1300, parent: 'missing-parent', messages: [['user', 1301], ['assistant', 1302]] })
    // An untitled single-turn CLI row stays out of the sidebar window.
    insertSession(db, { id: 'cli-hidden', source: 'cli', started_at: 1400, messages: [['user', 1401]], ended_at: 1402, end_reason: 'cli_close' })
    insertSession(db, { id: 'sub-hidden', source: 'subagent', started_at: 1401, parent: 'cli-hidden', messages: [['user', 1402], ['assistant', 1403]] })
    await saved('other-host', 'Other profile host', { profile: 'other' })
    insertSession(db, { id: 'sub-other', source: 'subagent', started_at: 1500, parent: 'other-host', messages: [['user', 1501], ['assistant', 1502]] })
    await s.deps.settings.save({ show_cli_sessions: true })
    s.deps.cliSessions.invalidate()
  })
  afterAll(async () => { db.close(); await s.close() })
  const rows = async (path: string): Promise<Json[]> => (await json(await s.get(path))).sessions as Json[]
  const links = (list: Json[]): Record<string, unknown> => Object.fromEntries(list.filter((r) => str(r.session_id).startsWith('sub-')).map((r): [string, unknown] => [str(r.session_id), r.sidebar_parent_session_id]))

  it('links a child of a project WebUI parent and files it in that project', async () => {
    const child = (await rows('/api/sessions')).find((r) => r.session_id === 'sub-web')
    expect(child).toMatchObject({ sidebar_parent_session_id: 'web-parent', project_id: 'proj-p', source_kind: 'subagent', read_only: true })
    expect((await rows('/api/sessions/search?q=&project_id=none')).map((r) => r.session_id)).not.toContain('sub-web')
    expect((await rows('/api/sessions/search?q=&project_id=proj-p')).map((r) => r.session_id)).toEqual(expect.arrayContaining(['web-parent', 'sub-web', 'sub-nested']))
  })

  it('links CLI, compressed and nested children; leaves missing, hidden and other-profile parents unlinked', async () => {
    expect(links(await rows('/api/sessions'))).toEqual({ 'sub-web': 'web-parent', 'sub-nested': 'web-parent', 'sub-cli': 'cli-host', 'sub-cmp': 'cmp-seg3', 'sub-orphan': null, 'sub-hidden': null, 'sub-other': null })
    const all = await rows('/api/sessions?all_profiles=1')
    expect(all.map((r) => r.session_id)).toContain('other-host')
    expect(links(all)['sub-other']).toBeNull()
    const orphan = await s.get('/api/session?session_id=sub-orphan&messages=0')
    expect(orphan.status).toBe(200)
  })

  it('files a child of a CLI parent in the CLI tab with its parent, never the WebUI tab', async () => {
    const cliTab = await rows('/api/sessions?sidebar_source=cli')
    expect(cliTab.map((r) => r.session_id)).toEqual(expect.arrayContaining(['cli-host', 'sub-cli', 'cmp-seg3', 'sub-cmp']))
    expect(links(cliTab)['sub-cli']).toBe('cli-host')
    const webTab = (await rows('/api/sessions?sidebar_source=webui')).map((r) => r.session_id)
    expect(webTab).not.toContain('sub-cli')
    expect(webTab).toEqual(expect.arrayContaining(['web-parent', 'sub-web', 'sub-orphan']))
  })

  it('links a search match only when its parent row matched too', async () => {
    const both = await rows('/api/sessions/search?q=zebra&include_archived=0')
    expect(both.map((r) => r.session_id)).toEqual(expect.arrayContaining(['web-parent', 'sub-web']))
    expect(links(both)).toEqual({ 'sub-web': 'web-parent' })
    const children = await rows('/api/sessions/search?q=subagent&include_archived=0&sidebar_source=webui')
    expect(children.map((r) => r.session_id)).not.toContain('web-parent')
    expect(links(children)).toMatchObject({ 'sub-web': null, 'sub-nested': null, 'sub-orphan': null })
    expect(Object.keys(links(children))).not.toContain('sub-cli')
  })
})

describe('gateway session feeds under person isolation (TAL-48)', () => {
  it('names only sessions the signed-in person may see, initially and live', async () => {
    const issuer = 'https://identity.invalid'
    const s = await bootTestServer({ gatewayPollMs: 100, env: {
      HERMES_WEBUI_PERSON_ISOLATION: '1', HERMES_WEBUI_OIDC_ISSUER: issuer, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
      HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins',
    }, deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) } })
    const db = createStateDb(join(s.state, 'state.db'))
    try {
      await s.deps.settings.save({ show_cli_sessions: true })
      insertSession(db, { id: 'tg-shared', source: 'telegram', started_at: 500, title: 'Shared gateway chat', messages: [['user', 501]], chat_id: 'c-1' })
      const headers = (subject: string, owner = false) => {
        const cookie = s.deps.auth.createSession({ authType: 'oidc', username: subject, oidcBinding: { issuer, subject, ...(owner ? { owner: true } : {}) } })
        return { cookie: `${s.deps.auth.cookieName()}=${cookie}` }
      }
      const rows = (frames: { event?: string; data?: unknown }[]) => frames.filter((f) => f.event === 'sessions_changed').flatMap((f) => ((f.data as Json).sessions as Json[] | undefined ?? []).map((r) => r.session_id))
      const owner = await s.sse('/api/sessions/gateway/stream', (f) => f.event === 'sessions_changed', { headers: headers('olive', true), timeoutMs: 3000 })
      expect(rows(owner)).toContain('tg-shared')
      const alice = headers('alice')
      for (const path of ['/api/sessions/gateway/stream', '/api/sessions/events?gateway=1']) {
        // The initial gateway snapshot omits the unowned Agent chat.
        const seen = await s.sse(path, (f) => f.event === 'sessions_changed' && (f.data as Json).stream !== 'sessions', { headers: alice, timeoutMs: 2500 })
        expect(seen.some((f) => f.event === 'sessions_changed'), path).toBe(true)
        expect(rows(seen), path).not.toContain('tg-shared')
      }
      // A live insert reaching the watcher is withheld too.
      const live = s.sse('/api/sessions/gateway/stream', () => false, { headers: alice, timeoutMs: 2000 })
      await new Promise((r) => setTimeout(r, 150))
      insertSession(db, { id: 'tg-live', source: 'telegram', started_at: 600, title: 'Live gateway chat', messages: [['user', 601]], chat_id: 'c-2' })
      const liveRows = rows(await live)
      expect(liveRows).not.toContain('tg-live')
      expect(liveRows).not.toContain('tg-shared')
    } finally {
      db.close()
      s.deps.gatewayWatchers.stopAll()
      await s.close()
    }
  })
})

describe('lineage continuations under person isolation (TAL-48)', () => {
  it('give a compressed Web chat\'s Agent tip to the chat\'s person, not to other server owners', async () => {
    const issuer = 'https://identity.invalid'
    const s = await bootTestServer({ gatewayPollMs: 100, env: {
      HERMES_WEBUI_PERSON_ISOLATION: '1', HERMES_WEBUI_OIDC_ISSUER: issuer, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
      HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins',
    }, deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) } })
    const db = createStateDb(join(s.state, 'state.db'))
    try {
      await s.deps.settings.save({ show_cli_sessions: true })
      const headers = (subject: string, owner = false) => {
        const cookie = s.deps.auth.createSession({ authType: 'oidc', username: subject, oidcBinding: { issuer, subject, ...(owner ? { owner: true } : {}) } })
        return { cookie: `${s.deps.auth.cookieName()}=${cookie}` }
      }
      const alice = headers('alice')
      const olive = headers('olive', true)
      const aliceId = ((await (await s.get('/api/auth/status', { headers: alice })).json()) as { person: { id: string } }).person.id
      // Alice's Web chat was compressed: its Web document keeps the root id, the Agent continues under a new tip id.
      const chat = await s.deps.sessionStore.newSession({ profile: 'default' })
      chat.owner_person_id = aliceId
      chat.messages.push({ role: 'user', content: 'private', timestamp: 300 })
      await s.deps.sessionStore.save(chat)
      insertSession(db, { id: chat.session_id, source: 'webui', started_at: 300, title: 'Private chat', messages: [['user', 301]], ended_at: 310, end_reason: 'compression' })
      insertSession(db, { id: 'alicetip0001', source: 'webui', started_at: 310.2, parent: chat.session_id, title: 'Private chat', messages: [['user', 311]] })

      expect((await s.get('/api/session?session_id=alicetip0001', { headers: olive })).status).toBe(404)
      const ids = (frames: { event?: string; data?: unknown }[]) => frames.filter((f) => f.event === 'sessions_changed').flatMap((f) => ((f.data as Json).sessions as Json[] | undefined ?? []).map((r) => r.session_id))
      const feed = await s.sse('/api/sessions/gateway/stream', (f) => f.event === 'sessions_changed', { headers: olive, timeoutMs: 3000 })
      expect(ids(feed)).not.toContain('alicetip0001')
      expect(await s.deps.sessions.foreignOwnerOf('alicetip0001')).toBe(aliceId)
      // A mutation that materializes the tip as a Web document keeps it Alice's.
      const cookie = s.deps.auth.createSession({ authType: 'oidc', username: 'alice', oidcBinding: { issuer, subject: 'alice' } })
      const write = { cookie: `${s.deps.auth.cookieName()}=${cookie}`, origin: s.base, 'X-Hermes-CSRF-Token': s.deps.auth.csrfTokenForSession(cookie)!, 'content-type': 'application/json' }
      const renamed = await s.get('/api/session/rename', { method: 'POST', headers: write, body: JSON.stringify({ session_id: 'alicetip0001', title: 'Renamed' }) })
      expect(renamed.status, await renamed.clone().text()).toBe(200)
      expect((await s.deps.sessionStore.get('alicetip0001', { metadataOnly: true })).owner_person_id).toBe(aliceId)
      expect((await s.get('/api/session?session_id=alicetip0001', { headers: olive })).status).toBe(404)
    } finally {
      db.close()
      s.deps.gatewayWatchers.stopAll()
      await s.close()
    }
  })
})

describe('delegated subagents under person isolation (TAL-48)', () => {
  it('belong to the person whose chat delegated them, through nested delegations', async () => {
    const issuer = 'https://identity.invalid'
    const s = await bootTestServer({ env: {
      HERMES_WEBUI_PERSON_ISOLATION: '1', HERMES_WEBUI_OIDC_ISSUER: issuer, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
      HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins',
    }, deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) } })
    const db = createStateDb(join(s.state, 'state.db'))
    try {
      await s.deps.settings.save({ show_cli_sessions: true })
      const headers = (subject: string, owner = false) => {
        const cookie = s.deps.auth.createSession({ authType: 'oidc', username: subject, oidcBinding: { issuer, subject, ...(owner ? { owner: true } : {}) } })
        return { cookie: `${s.deps.auth.cookieName()}=${cookie}` }
      }
      const alice = headers('alice')
      const olive = headers('olive', true)
      const aliceId = ((await (await s.get('/api/auth/status', { headers: alice })).json()) as { person: { id: string } }).person.id
      await s.deps.sessionStore.save(new Session({ session_id: 'aliceparent', title: 'Alice plan', owner_person_id: aliceId, messages: [{ role: 'user', content: 'go', timestamp: 1001 }] }, { workspace: s.state, model: null }))
      insertSession(db, { id: 'aliceparent', source: 'webui', started_at: 1000, title: 'Alice plan', messages: [['user', 1001]] })
      insertSession(db, { id: 'subalice', source: 'subagent', started_at: 1003, title: 'Alice worker', parent: 'aliceparent', messages: [['user', 1004], ['assistant', 1005]] })
      insertSession(db, { id: 'subalicenested', source: 'subagent', started_at: 1006, title: 'Alice nested', parent: 'subalice', messages: [['user', 1007], ['assistant', 1008]] })
      insertSession(db, { id: 'clihost', source: 'cli', started_at: 1100, title: 'CLI host', messages: [['user', 1101], ['assistant', 1102]] })
      insertSession(db, { id: 'subcli', source: 'subagent', started_at: 1103, parent: 'clihost', messages: [['user', 1104], ['assistant', 1105]] })
      s.deps.cliSessions.invalidate()
      // The sidebar reads a bounded window of Agent rows; here the nested worker's parent falls outside it.
      const read = s.deps.sessions.deps.cliSessions
      s.deps.sessions.deps.cliSessions = async (profile, opts) => {
        const result = await read(profile, opts)
        return opts.sessionIds ? result : { ...result, rows: result.rows.filter((row) => row.session_id !== 'subalice') }
      }

      for (const sid of ['subalice', 'subalicenested']) {
        expect((await s.get(`/api/session?session_id=${sid}&messages=0`, { headers: olive })).status, sid).toBe(404)
        expect((await s.get(`/api/session?session_id=${sid}&messages=0`, { headers: alice })).status, sid).toBe(200)
      }
      const listed = async (h: Record<string, string>) => ((await (await s.get('/api/sessions', { headers: h })).json()) as { sessions: { session_id: string }[] }).sessions.map((r) => r.session_id)
      const aliceRows = await listed(alice)
      const oliveRows = await listed(olive)
      expect(aliceRows).toEqual(expect.arrayContaining(['aliceparent', 'subalicenested']))
      expect(aliceRows).not.toContain('subcli')
      expect(oliveRows).toEqual(expect.arrayContaining(['clihost', 'subcli']))
      for (const sid of ['aliceparent', 'subalice', 'subalicenested']) expect(oliveRows).not.toContain(sid)
    } finally {
      db.close()
      s.deps.gatewayWatchers.stopAll()
      await s.close()
    }
  })
})
