/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue1494_state_db_fd_leak.py
 *   web/tests/test_issue2628_cli_sessions_perf.py
 *   web/tests/test_issue3238_orphaned_cli_sidecar_prune.py
 *   web/tests/test_issue3762_importable_rows_schema_guard.py
 *   web/tests/test_issue4385_cron_archive_reappears.py
 *   web/tests/test_issue5455_lineage_readonly_reads.py
 *   web/tests/test_issue5455_listing_readonly_connection.py
 * (issues #1494, #2628, #3238, #3762, #4385, #5455) is covered here; see docs/architecture/regression-port-ledger.md.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { agentSessionRowsExisting, cheapChangeFingerprint, isCliSessionRowVisible, normalizeAgentSessionSource, projectAgentSessionRows, readImportableAgentSessionRows, stateDbHasSession } from './state-db.js'
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

  it('projects messageful gateway rows, hides empty ones, and keeps cron out of the default window [py:test_issue3238_orphaned_cli_sidecar_prune.py::test_agent_session_rows_existing_returns_present_subset]', () => {
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

  it('file operations resolve an Agent-owned state.db session without a sidecar file to the active workspace [py:test_file_manager_external_session.py::test_get_session_for_file_ops_state_db_fallback] [py:test_file_manager_external_session.py::test_get_session_for_file_ops_unknown_session_raises] [py:test_file_manager_external_session.py::test_state_db_has_session_present] [py:test_file_manager_external_session.py::test_state_db_has_session_missing_db]', async () => {
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
    expect(body.session).toMatchObject({ session_id: 'tui-tip', is_cli_session: true, read_only: false, message_count: 4, tool_calls: [] })
    expect((body.session.messages as { content: string }[]).map((m) => m.content)).toEqual(['user says', 'assistant says', 'user says', 'assistant says'])
    // State.db-only transcripts get the same server turn projection as WebUI sessions: turn ids and each turn's scene.
    const stateMessages = body.session.messages as Record<string, unknown>[]
    expect(stateMessages.map((m) => m._turn_id)).toEqual(['legacy:0', 'legacy:0', 'legacy:2', 'legacy:2'])
    expect(stateMessages[3]?._anchor_activity_scene).toMatchObject({ version: 'activity_scene_v1', final_answer: 'assistant says', terminal_state: 'completed', activity_rows: [] })
    // Archiving materializes a WebUI sidecar for the claimable CLI session (Python `_get_or_materialize_session`).
    res = await post('/api/session/archive', { session_id: 'tui-tip', archived: true })
    expect(res.status).toBe(200)
    expect(s.deps.sessionStore.loadMetadataOnly('tui-tip')?.archived).toBe(true)
    expect(s.deps.sessionStore.get('tui-tip').messages).toHaveLength(4)
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
    expect(s.deps.sessionStore.loadMetadataOnly('tg-owned')).toBeNull()
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
    const web = s.deps.sessionStore.get(webSid)
    web.messages = [{ role: 'user', content: 'from web', timestamp: 5000 }, { role: 'assistant', content: 'web reply', timestamp: 5001 }]
    s.deps.sessionStore.save(web)
    insertSession(db, { id: webSid, source: 'webui', started_at: 5000, messages: [['user', 5000], ['assistant', 5001], ['user', 5100], ['assistant', 5101]] })
    body = (await (await s.get(`/api/session?session_id=${webSid}`)).json()) as { session: Record<string, unknown> }
    expect((body.session.messages as { content: string; timestamp: number }[]).map((m) => m.content)).toEqual(['from web', 'web reply', 'user says', 'assistant says'])
    expect(body.session.message_count).toBe(4)
    // Branching indexes that same merged transcript (Python `_merged_session_messages_for_display`): a keep_count past
    // the sidecar tail keeps the CLI turns instead of silently dropping them.
    const branched = (await (await post('/api/session/branch', { session_id: webSid, keep_count: 3 })).json()) as { session_id: string }
    expect(s.deps.sessionStore.get(branched.session_id).messages.map((m) => m.content)).toEqual(['from web', 'web reply', 'user says'])
    // ...and the branch's model context carries the retained CLI row as well (the branch id has no state.db rows).
    expect(s.deps.sessionStore.get(branched.session_id).context_messages.map((m) => m.content)).toEqual(['from web', 'web reply', 'user says'])
  })

  it('applies the state.db owner to an existing sidecar: messaging and Claude Code owners lock it, WebUI-born and claimable CLI sidecars stay writable (TAL-358)', async () => {
    const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    // A WebUI sidecar with no persisted `read_only`, whose id also has a state.db row owned by `source`.
    const sidecar = async (source: string, persisted: Json = {}): Promise<string> => {
      const sid = String(((await json(await post('/api/session/new', {}))).session as Json).session_id)
      const stored = s.deps.sessionStore.get(sid)
      stored.title = `Ownerprobe ${source}`
      stored.messages = [{ role: 'user', content: 'ownerprobe', timestamp: 7000 }, { role: 'assistant', content: 'ok', timestamp: 7001 }]
      Object.assign(stored, persisted)
      s.deps.sessionStore.save(stored)
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
      expect((await post('/api/session/delete', { session_id: sid })).status, sid).toBe(400)
      expect(s.deps.sessionStore.loadMetadataOnly(sid)?.title, sid).toMatch(/^Ownerprobe /)
    }
    for (const sid of writable) expect((await post('/api/session/rename', { session_id: sid, title: 'Ownerprobe renamed' })).status, sid).toBe(200)
  })
})
