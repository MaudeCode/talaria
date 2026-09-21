import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { agentSessionRowsExisting, cheapChangeFingerprint, isCliSessionRowVisible, normalizeAgentSessionSource, projectAgentSessionRows, readImportableAgentSessionRows } from './state-db.js'
import { GatewayWatcher, snapshotHash } from './gateway-watcher.js'
import { capRecentCliSessions, keepLatestMessagingSessionPerSource, mergeCliSidebarMetadata, type GatewayIdentity } from './list.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

/** The Python test schema (`tests/test_gateway_sync.py::_ensure_state_db`): the Agent's columns the projection reads. */
function createStateDb(path: string): DatabaseSync {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
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

  it('normalizes the agent source contract', () => {
    expect(normalizeAgentSessionSource('telegram')).toEqual({ raw_source: 'telegram', session_source: 'messaging', source_label: 'Telegram' })
    expect(normalizeAgentSessionSource('acp')).toEqual({ raw_source: 'acp', session_source: 'cli', source_label: 'ACP' })
    expect(normalizeAgentSessionSource('api_server')).toMatchObject({ session_source: 'api', source_label: 'API' })
    expect(normalizeAgentSessionSource(null)).toEqual({ raw_source: null, session_source: 'other', source_label: 'Agent' })
    expect(normalizeAgentSessionSource('my_bridge')).toMatchObject({ session_source: 'other', source_label: 'My Bridge' })
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
    const watcher = new GatewayWatcher('default', s.state, { now: () => Date.now() / 1000, log: () => undefined, pollIntervalMs: 50 })
    const sub = watcher.subscribe()
    expect(watcher.pollOnce()).toBe(true)
    const first = await sub.next(AbortSignal.timeout(500))
    expect(first?.type).toBe('sessions_changed')
    expect(first?.sessions.map((r) => r.session_id)).toContain('tg-1')
    expect(watcher.pollOnce()).toBe(false)
    insertSession(db, { id: 'tg-2', source: 'telegram', started_at: 400, title: 'Newer', messages: [['user', 401]], chat_id: 'c2' })
    expect(cheapChangeFingerprint(dbPath)).not.toBe(before)
    expect(watcher.pollOnce()).toBe(true)
    const second = await sub.next(AbortSignal.timeout(500))
    expect(second?.sessions.map((r) => r.session_id)).toContain('tg-2')
    watcher.stop()
    expect(await sub.next()).toBeNull()
    expect(await watcher.subscribe().next()).toBeNull()
    expect(snapshotHash([{ session_id: 'b', updated_at: 1 }, { session_id: 'a', updated_at: 2 }])).toBe(snapshotHash([{ session_id: 'a', updated_at: 2 }, { session_id: 'b', updated_at: 1 }]))
  })

  it('serves the merged sidebar feed with state.db snapshots (the standalone gateway stream is dropped)', async () => {
    await s.deps.settings.save({ show_cli_sessions: true })
    expect((await s.get('/api/sessions/gateway/stream')).status).toBe(404)
    const merged = await s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'gateway', { timeoutMs: 3000 })
    expect(merged[0]).toMatchObject({ event: 'gateway_status', data: { ok: true, watcher_running: true } })
    expect(merged.some((f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'gateway')).toBe(true)
    // A live insert reaches the merged feed through the 100 ms poll.
    const live = s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'sessions_changed' && (f.data as Json).stream === 'gateway' && ((f.data as Json).sessions as Json[]).some((r) => r.session_id === 'tg-3'), { timeoutMs: 4000 })
    await new Promise((r) => setTimeout(r, 150))
    insertSession(db, { id: 'tg-3', source: 'telegram', started_at: 500, title: 'Live', messages: [['user', 501]], chat_id: 'c3' })
    const liveFrames = await live
    expect(liveFrames.some((f) => (f.data as Json).stream === 'gateway' && ((f.data as Json).sessions as Json[]).some((r) => r.session_id === 'tg-3'))).toBe(true)
    await s.deps.settings.save({ show_cli_sessions: false })
    const status = await s.sse('/api/sessions/events?gateway=1', (f) => f.event === 'gateway_status', { timeoutMs: 2000 })
    expect(status[0]?.data).toMatchObject({ ok: false, enabled: false, error: 'agent sessions not enabled' })
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
    const old = new DatabaseSync(legacy)
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL NOT NULL, message_count INTEGER)')
    old.close()
    const logs: string[] = []
    expect(readImportableAgentSessionRows(legacy, { log: (l) => logs.push(l) })).toEqual([])
    expect(logs[0]).toContain("no 'source' column")
    writeFileSync(join(s.state, 'profiles', 'legacy', 'note.txt'), 'x')
  })
})
