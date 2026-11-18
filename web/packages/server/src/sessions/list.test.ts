import { mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { allSessions, buildSessionListPayload, sessionListResponse, type ListParams, type ListPayload, type Row, type RuntimeOverlay } from './list.js'
import * as sessionRows from './storage/row.js'
import { bootTestServer, openStateDb, type TestServer } from '../test/harness.js'
import { sessionDirectory, sessionIndexPath, sessionPath, useJsonStorage, useSelectedStorage } from '../test/storage.js'
import { Session } from './session.js'
import { str } from '../util.js'

useJsonStorage()

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { session_list: { stored: Row[]; live_stream_ids: string[]; sessions: Row[] }; nested_session_list: { stored: Row[]; sessions: Row[] } }

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return { ...real, readdirSync: vi.fn(real.readdirSync) }
})

describe('session-list storage reads (TAL-1226)', () => {
  it('reads the index once per request and scans the directory once across consecutive requests', async () => {
    const server = await bootTestServer()
    try {
      const store = server.deps.sessionStore
      const rows = ['first', 'second'].map((sid, i) => ({ session_id: sid, title: sid, message_count: 2, last_message_at: 100 + i, updated_at: 100 + i, profile: 'default' }))
      const directory = sessionDirectory(store)
      mkdirSync(directory, { recursive: true })
      for (const row of rows) writeFileSync(sessionPath(store, row.session_id), JSON.stringify({ ...row, messages: [] }))
      writeFileSync(sessionIndexPath(store), JSON.stringify(rows))
      const readIndex = vi.spyOn(store, 'readIndexEntries')
      const reads = vi.mocked(readdirSync)
      reads.mockClear()
      for (let request = 1; request <= 2; request++) {
        expect(await allSessions(store)).toMatchObject([...rows].reverse())
        expect.soft(readIndex).toHaveBeenCalledTimes(request)
        expect.soft(reads.mock.calls.filter(([path]) => path === directory)).toHaveLength(1)
      }
      unlinkSync(sessionPath(store, 'first'))
      const changed = new Date('2030-01-01T00:00:00Z')
      utimesSync(directory, changed, changed)
      expect((await allSessions(store)).map((row) => row.session_id)).toEqual(['second'])
      expect(reads.mock.calls.filter(([path]) => path === directory)).toHaveLength(2)
    } finally { vi.restoreAllMocks(); await server.close() }
  })
})

function listed(stored: Row[], liveStreamIds: string[]): Row[] {
  const payload = { sessions: stored, sidebar_reference_sessions: [], archived_limit: null } as unknown as ListPayload
  const overlay: RuntimeOverlay = { activeStreamIds: new Set(liveStreamIds), runningCronJobs: new Map(), live: () => undefined, attention: () => null }
  return sessionListResponse(payload, overlay, false, 0, () => null).body.sessions
}

describe('session-list row validation (TAL-1218)', () => {
  it('sanitizes each row of a 300-row index exactly once per list read', async () => {
    const server = await bootTestServer()
    try {
      const store = server.deps.sessionStore
      const rows = Array.from({ length: 300 }, (_, i) => ({
        session_id: `indexed-${String(i).padStart(3, '0')}`, title: `Chat ${i}`, message_count: 2,
        last_message_at: 100 + i, updated_at: 100 + i, profile: 'default', archived: false,
      }))
      mkdirSync(sessionDirectory(store), { recursive: true })
      for (const row of rows) writeFileSync(sessionPath(store, row.session_id), JSON.stringify({ ...row, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] }))
      const index = JSON.stringify(rows)
      writeFileSync(sessionIndexPath(store), index)
      const sanitize = vi.spyOn(sessionRows, 'sanitizeSessionRow')
      for (let read = 0; read < 2; read++) {
        sanitize.mockClear()
        const result = await allSessions(store)
        expect(result).toMatchObject([...rows].reverse())
        const callsPerRow = rows.map((row) => sanitize.mock.calls.filter(([value]) => (value as Row).session_id === row.session_id).length)
        expect(callsPerRow).toEqual(rows.map(() => 1))
      }
      expect(readFileSync(sessionIndexPath(store), 'utf8')).toBe(index)
    } finally { vi.restoreAllMocks(); await server.close() }
  })

  it('still sanitizes a resident replacement for an already validated index identity', async () => {
    const server = await bootTestServer()
    try {
      const store = server.deps.sessionStore
      const session = await store.newSession()
      session.title = 'Resident chat'
      vi.spyOn(store, 'readIndexEntries').mockResolvedValue([session.compact()])
      const replacement = { ...session.compact(), title: {}, message_count: '2', read_only: 'unknown' }
      vi.spyOn(session, 'compact').mockReturnValue(replacement)
      const sanitize = vi.spyOn(sessionRows, 'sanitizeSessionRow')
      expect(await allSessions(store)).toMatchObject([{ session_id: session.session_id, title: '', message_count: 2, read_only: true }])
      expect(sanitize.mock.calls.filter(([value]) => value === replacement)).toHaveLength(1)
      expect(replacement).toMatchObject({ title: {}, message_count: '2', read_only: 'unknown' })
    } finally { vi.restoreAllMocks(); await server.close() }
  })
})

describe('canonical session-list order (TAL-306)', () => {
  it('lists pinned rows first, then active rows, then newest sort_ts, then session id, and ships sort_ts', () => {
    const { stored, live_stream_ids: live, sessions } = fixture.session_list
    const rows = listed(stored, live)
    // Pinned beats a streaming unpinned row; a pending prompt counts as active; a created_at-only row sorts by it.
    expect(rows.map((r) => [r.session_id, r.sort_ts])).toEqual(sessions.map((r) => [r.session_id, r.sort_ts]))
    expect(rows).toEqual(sessions)
  })

  it('does not depend on the order rows arrive in', () => {
    const { stored, live_stream_ids: live, sessions } = fixture.session_list
    expect(listed([...stored].reverse(), live).map((r) => r.session_id)).toEqual(sessions.map((r) => r.session_id))
  })
})

describe('nested subagent rows (TAL-1151)', () => {
  it('ships each row\'s sidebar parent link as the shared fixture records it', () => {
    const { stored, sessions } = fixture.nested_session_list
    expect(listed(stored, [])).toEqual(sessions)
    expect(sessions.map((r) => [r.session_id, r.sidebar_parent_session_id])).toEqual([['tal1151-parent', null], ['tal1151-child', 'tal1151-parent'], ['tal1151-orphan', null]])
  })
})

describe('sidebar_source per profile (TAL-1863)', () => {
  const row = (session_id: string, profile: string, source: string, at: number, parent?: string): Row => ({ session_id, profile, title: session_id, source_tag: source, raw_source: source, session_source: source, message_count: 2, updated_at: at, last_message_at: at, ...(parent ? { parent_session_id: parent } : {}) })
  // The same parent id is a CLI chat in one profile and a Web chat in the other; another CLI parent exists only in `work`.
  const rows = [
    row('shared', 'default', 'cli', 10), row('shared', 'work', 'webui', 11), row('work-only', 'work', 'cli', 12),
    row('child-default', 'default', 'subagent', 20, 'shared'), row('child-work', 'work', 'subagent', 21, 'shared'), row('child-foreign', 'default', 'subagent', 22, 'work-only'),
  ]
  const sources = async (activeProfile: string, allProfiles: boolean) => {
    const server = await bootTestServer()
    try {
      const params: ListParams = {
        webuiRows: rows, cliRows: [], activeProfile, allProfiles, includeArchived: false, visibleOnly: false, showCliSessions: true, showClaudeCodeSessions: false, showMessagingSessions: false,
        showPreviousMessagingSessions: false, showCronSessions: false, showWebhookSessions: false, showKanbanSessions: false, sidebarSource: null,
        archivedLimit: null, archivedOffset: 0, isolatedProfileMode: false, profilesMatch: (a, b) => (a ?? 'default') === (b ?? 'default'),
      }
      const { sessions } = await buildSessionListPayload(server.deps.sessionStore, params)
      return Object.fromEntries(sessions.filter((r) => str(r.session_id).startsWith('child-')).map((r): [string, unknown] => [str(r.session_id), r.sidebar_source]))
    } finally { await server.close() }
  }

  it('resolves each child only within its own profile, in all-profiles and single-profile lists', async () => {
    expect(await sources('default', true)).toEqual({ 'child-default': 'cli', 'child-work': 'webui', 'child-foreign': 'webui' })
    expect(await sources('default', false)).toEqual({ 'child-default': 'cli', 'child-foreign': 'webui' })
    expect(await sources('work', false)).toEqual({ 'child-work': 'webui' })
  })
})

describe('detailed row meta (TAL-2153)', () => {
  const overlay: RuntimeOverlay = { activeStreamIds: new Set(), runningCronJobs: new Map(), live: () => undefined, attention: () => null }
  const meta = (row: Row, allProfiles: boolean) => sessionListResponse({ sessions: [{ session_id: 'a', title: 'a', ...row }], sidebar_reference_sessions: [], archived_limit: null, all_profiles: allProfiles } as unknown as ListPayload, overlay, false, 0, () => null, true).body.sessions[0]?.meta

  it('orders model, message count, outside source and profile, each only where it applies', () => {
    const cli = { model: 'gpt-5.4', message_count: 7, source_tag: 'cli', source_label: 'CLI', profile: 'work' }
    expect(meta(cli, true)).toEqual(['GPT 5.4', 7, 'CLI', 'work'])
    expect(meta(cli, false)).toEqual(['GPT 5.4', 7, 'CLI'])
    expect(meta({ model: null, message_count: 0, session_source: 'webui', source_label: 'WebUI', profile: 'default' }, true)).toEqual(['default'])
  })
})

describe('one switch per outside source (TAL-2159)', () => {
  const at = (n: number) => ({ created_at: n, updated_at: n, last_message_at: n, profile: 'default' })
  /** A state.db row as the Agent reads it: `source` and its normalized fields. */
  const agent = (session_id: string, source: string, n: number, extra: Row = {}): Row => ({ session_id, title: `Chat ${session_id}`, source, raw_source: source, session_source: source, message_count: 2, actual_message_count: 2, user_message_count: 1, ...at(n), ...extra })
  const WEB: Row[] = [{ session_id: 'web', title: 'Web chat', source_tag: 'webui', raw_source: 'webui', session_source: 'webui', message_count: 2, ...at(1) }]
  const AGENT: Row[] = [
    agent('term', 'cli', 2), agent('desk', 'desktop', 3), agent('api', 'api_server', 4),
    { session_id: 'cc', title: 'Claude chat', source_tag: 'claude_code', raw_source: 'claude_code', session_source: 'external_agent', source_label: 'Claude Code', message_count: 2, ...at(5) },
    agent('tg', 'telegram', 6, { session_source: 'messaging', chat_id: 'c1' }),
    agent('cron_job1_20261101_120000', 'cron', 7), agent('hook', 'webhook', 8), agent('kan', 'kanban', 9),
    agent('sub-web', 'subagent', 10, { parent_session_id: 'web' }), agent('sub-tg', 'subagent', 11, { parent_session_id: 'tg' }),
  ]
  const ALL_ON = { showCliSessions: true, showClaudeCodeSessions: true, showMessagingSessions: true, showCronSessions: true, showWebhookSessions: true, showKanbanSessions: true }
  const listed = async (switches: Partial<typeof ALL_ON>, rows: { web?: Row[]; agent?: Row[]; showPrevious?: boolean } = {}) => {
    const server = await bootTestServer()
    try {
      const params: ListParams = {
        webuiRows: rows.web ?? WEB, cliRows: rows.agent ?? AGENT, activeProfile: 'default', allProfiles: false, includeArchived: false, visibleOnly: false,
        ...ALL_ON, ...switches, showPreviousMessagingSessions: rows.showPrevious ?? true, sidebarSource: null,
        archivedLimit: null, archivedOffset: 0, isolatedProfileMode: false, profilesMatch: (a, b) => (a ?? 'default') === (b ?? 'default'),
      }
      const { sessions } = await buildSessionListPayload(server.deps.sessionStore, params)
      return sessions.map((r) => str(r.session_id)).sort()
    } finally { await server.close() }
  }
  const everything = ['web', ...AGENT.map((r) => str(r.session_id))].sort()

  it.each([
    { name: 'Terminal and desktop apps', key: 'showCliSessions', rows: ['api', 'desk', 'term'] },
    { name: 'Claude Code', key: 'showClaudeCodeSessions', rows: ['cc'] },
    { name: 'Messaging apps', key: 'showMessagingSessions', rows: ['sub-tg', 'tg'] },
    { name: 'Scheduled tasks', key: 'showCronSessions', rows: ['cron_job1_20261101_120000'] },
    { name: 'Webhooks', key: 'showWebhookSessions', rows: ['hook'] },
    { name: 'Kanban', key: 'showKanbanSessions', rows: ['kan'] },
  ] as const)('$name off removes exactly its own chats, and on adds exactly those', async ({ key, rows }) => {
    expect(await listed({})).toEqual(everything)
    expect(await listed({ [key]: false })).toEqual(everything.filter((id) => !(rows as readonly string[]).includes(id)))
    const none = { showCliSessions: false, showClaudeCodeSessions: false, showMessagingSessions: false, showCronSessions: false, showWebhookSessions: false, showKanbanSessions: false }
    expect(await listed({ ...none, [key]: true })).toEqual(['sub-web', 'web', ...rows].sort())
  })

  it('names on each row the switch that lists it, a subagent its parent\'s and a Talaria chat none', async () => {
    const server = await bootTestServer()
    try {
      const params: ListParams = {
        webuiRows: WEB, cliRows: AGENT, activeProfile: 'default', allProfiles: false, includeArchived: false, visibleOnly: false, ...ALL_ON,
        showPreviousMessagingSessions: true, sidebarSource: null, archivedLimit: null, archivedOffset: 0, isolatedProfileMode: false, profilesMatch: () => true,
      }
      const { sessions } = await buildSessionListPayload(server.deps.sessionStore, params)
      expect(Object.fromEntries(sessions.map((r) => [str(r.session_id), r.visibility_setting]))).toEqual({
        web: null, 'sub-web': null, term: 'show_cli_sessions', desk: 'show_cli_sessions', api: 'show_cli_sessions', cc: 'show_claude_code_sessions',
        tg: 'show_messaging_sessions', 'sub-tg': 'show_messaging_sessions', cron_job1_20261101_120000: 'show_cron_sessions', hook: 'show_webhook_sessions', kan: 'show_kanban_sessions',
      })
    } finally { await server.close() }
  })

  it('hides a scheduled-task chat filed in a project with messages while Scheduled tasks is off', async () => {
    const projectCron = [agent('cron_job2_20261101_130000', 'cron', 12, { project_id: 'p1' })]
    const sidecar = [...WEB, { ...agent('cron_job3_20261101_140000', 'cron', 13, { project_id: 'p1' }), source_tag: 'cron' }]
    expect(await listed({ showCronSessions: false }, { web: sidecar, agent: projectCron })).toEqual(['web'])
    expect(await listed({ showCronSessions: true }, { web: sidecar, agent: projectCron })).toEqual(['cron_job2_20261101_130000', 'cron_job3_20261101_140000', 'web'])
  })

  it('keeps one chat per messaging contact under "Only the latest chat per contact", all of them without it, and nothing while Messaging apps is off', async () => {
    const chats = [agent('tg-old', 'telegram', 20, { session_source: 'messaging', chat_id: 'c1' }), agent('tg-new', 'telegram', 21, { session_source: 'messaging', chat_id: 'c1' }), agent('tg-other', 'telegram', 22, { session_source: 'messaging', chat_id: 'c2' })]
    expect(await listed({}, { agent: chats, showPrevious: false })).toEqual(['tg-new', 'tg-other', 'web'])
    expect(await listed({}, { agent: chats, showPrevious: true })).toEqual(['tg-new', 'tg-old', 'tg-other', 'web'])
    for (const showPrevious of [false, true]) expect(await listed({ showMessagingSessions: false }, { agent: chats, showPrevious })).toEqual(['web'])
  })
})

describe('sidebar groups (TAL-1534)', () => {
  const overlay: RuntimeOverlay = { activeStreamIds: new Set(), runningCronJobs: new Map(), live: () => undefined, attention: () => null }
  const body = (stored: Row[]) => sessionListResponse({ sessions: stored, sidebar_reference_sessions: [], archived_limit: null } as unknown as ListPayload, overlay, false, 0, () => null).body
  const row = (id: string, ts: number, extra: Row = {}): Row => ({ session_id: id, title: id, updated_at: ts, last_message_at: ts, ...extra })
  const groups = (stored: Row[]) => { const b = body(stored); return { rows: b.sessions.map((r) => [r.session_id, r.sidebar_group]), groups: b.sidebar_groups } }
  const PINNED = { kind: 'pinned', title: 'Pinned' }
  const RECENT = { kind: 'recent', title: 'Recents' }

  it('lists no pinned group when no row is pinned', () => {
    expect(groups([row('a', 2), row('b', 1)])).toEqual({ rows: [['a', 'recent'], ['b', 'recent']], groups: [RECENT] })
  })

  it('lists only the pinned group when every row is pinned', () => {
    expect(groups([row('a', 2, { pinned: true }), row('b', 1, { pinned: true })])).toEqual({ rows: [['a', 'pinned'], ['b', 'pinned']], groups: [PINNED] })
  })

  it('lists pinned before recent for mixed rows, in the canonical order', () => {
    expect(groups([row('new', 3), row('pin', 1, { pinned: true }), row('old', 2)])).toEqual({ rows: [['pin', 'pinned'], ['new', 'recent'], ['old', 'recent']], groups: [PINNED, RECENT] })
  })

  it('files archived rows under no group and counts no group for them', () => {
    expect(groups([row('kept', 2), row('gone', 3, { pinned: true, archived: true })])).toEqual({ rows: [['gone', null], ['kept', 'recent']], groups: [RECENT] })
  })

  it('files cron and webhook rows, pinned or archived, under Scheduled and Webhook in the canonical order (TAL-1639)', () => {
    const stored = [
      row('chat', 6),
      row('cron_job_20261031_120000', 5),
      row('cron-pinned', 4, { source_tag: 'cron', pinned: true }),
      row('hook', 3, { source_tag: 'webhook' }),
      row('hook-archived', 2, { source_tag: 'webhook', archived: true }),
      row('pin', 1, { pinned: true }),
    ]
    expect(groups(stored)).toEqual({
      rows: [['cron-pinned', 'scheduled'], ['pin', 'pinned'], ['chat', 'recent'], ['cron_job_20261031_120000', 'scheduled'], ['hook', 'webhook'], ['hook-archived', 'webhook']],
      groups: [PINNED, RECENT, { kind: 'scheduled', title: 'Scheduled sessions' }, { kind: 'webhook', title: 'Webhook sessions' }],
    })
  })
})

describe('Web-created diagnostic chats (TAL-1040)', () => {
  it('keeps a compressed chat whose receipt names its lineage root while external sessions are hidden', async () => {
    const tip = { session_id: 'tip', _lineage_root_id: 'root', _lineage_tip_id: 'tip', source: 'cli', source_tag: 'cli', message_count: 4, actual_message_count: 4 }
    const other = { session_id: 'other', _lineage_root_id: 'other-root', _lineage_tip_id: 'other', source: 'cli', source_tag: 'cli', message_count: 4, actual_message_count: 4 }
    const server = await bootTestServer()
    try {
      const params: ListParams = {
        webuiRows: [], cliRows: [tip, other], webDiagnosticIds: new Set(['root']), activeProfile: 'default', allProfiles: false, includeArchived: false, visibleOnly: false,
        showCliSessions: false, showClaudeCodeSessions: false, showMessagingSessions: false, showPreviousMessagingSessions: false, showCronSessions: false, showWebhookSessions: false, showKanbanSessions: false,
        sidebarSource: null, archivedLimit: null, archivedOffset: 0, isolatedProfileMode: false, profilesMatch: () => true,
      }
      expect((await buildSessionListPayload(server.deps.sessionStore, params)).sessions.map((r) => r.session_id)).toEqual(['tip'])
    } finally { await server.close() }
  })
})

describe('parent snapshot lookup (TAL-1219)', () => {
  it.each([
    { indexed: true, snapshot: true },
    { indexed: true, snapshot: false },
    { indexed: true, snapshot: undefined },
    { indexed: false, snapshot: true },
    { indexed: false, snapshot: false },
    { indexed: false, snapshot: undefined },
  ].flatMap((test) => (test.indexed ? [false, true] : [false]).map((legacy) => ({ ...test, legacy }))))('lists 50 forks with indexed=$indexed, snapshot=$snapshot, legacy=$legacy without redundant parent loads', async ({ indexed, snapshot, legacy }) => {
    const server = await bootTestServer()
    const store = server.deps.sessionStore
    try {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        session_id: `fork_${i}`, parent_session_id: indexed ? legacy ? 'legacy_parent' : `parent_${i}` : 'missing_parent',
        source_tag: 'telegram', chat_id: 'shared_chat', message_count: 2, updated_at: i + 1,
      }))
      if (indexed) {
        for (const sid of new Set(rows.map((row) => row.parent_session_id))) {
          const parent = new Session({ session_id: sid, pre_compression_snapshot: snapshot, archived: true }, { workspace: '/synthetic', model: 'synthetic' })
          await store.save(parent)
        }
        const index = await store.readIndexEntries()
        if (legacy) writeFileSync(sessionIndexPath(store), JSON.stringify([null, ...index.map((row) => {
          const old = { ...row }
          Reflect.deleteProperty(old, 'pre_compression_snapshot')
          return old
        })]))
        store.sessions.clear()
      }
      const load = vi.spyOn(store, 'loadMetadataOnly')
      if (!indexed && snapshot !== undefined) load.mockResolvedValue(new Session({ session_id: 'missing_parent', pre_compression_snapshot: snapshot }, { workspace: '/synthetic', model: 'synthetic' }))
      const params: ListParams = {
        webuiRows: rows, activeProfile: 'default', allProfiles: false, includeArchived: false,
        visibleOnly: false, showCliSessions: false, showClaudeCodeSessions: false, showMessagingSessions: true,
        showPreviousMessagingSessions: false, showCronSessions: false, showWebhookSessions: false,
        showKanbanSessions: false, sidebarSource: null,
        archivedLimit: null, archivedOffset: 0, isolatedProfileMode: false, profilesMatch: () => true,
      }
      const expected = (snapshot ? [...rows].reverse() : [rows[49]!]).map((row) => ({ ...row, is_cli_session: false, sidebar_parent_session_id: null, sidebar_source: 'webui', visibility_setting: 'show_messaging_sessions' }))
      expect((await buildSessionListPayload(store, params)).sessions).toEqual(expected)
      expect(load).toHaveBeenCalledTimes(indexed && !legacy ? 0 : 1)
      if (!indexed || legacy) expect(load).toHaveBeenCalledWith(legacy ? 'legacy_parent' : 'missing_parent')
      expect((await buildSessionListPayload(store, params)).sessions).toEqual(expected)
      expect(load).toHaveBeenCalledTimes(indexed && !legacy ? 0 : 2)
    } finally { vi.restoreAllMocks(); await server.close() }
  })
})

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

function createStateDb(path: string): DatabaseSync {
  const db = openStateDb(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, title TEXT,
    chat_id TEXT, chat_type TEXT, thread_id TEXT, session_key TEXT, origin_chat_id TEXT, origin_user_id TEXT, platform TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`)
  return db
}
function insertSession(db: DatabaseSync, row: { id: string; source: string; started_at: number; messages?: [string, number][] }): void {
  const messages = row.messages ?? []
  db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)').run(row.id, row.source, row.started_at, messages.length)
  for (const [role, ts] of messages) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(row.id, role, `${role} says`, ts)
}

describe('state.db session windows', () => {
  useSelectedStorage()
  let s: TestServer
  let dbPath = ''
  beforeAll(async () => {
    s = await bootTestServer()
    dbPath = join(s.state, 'state.db')
    // Python gates the Cron Jobs chip on the profile having opted into projects (#5379).
    expect((await post(s, '/api/projects/create', { name: 'User project' })).status).toBe(200)
    const db = createStateDb(dbPath)
    insertSession(db, { id: 'cron_old_1', source: 'cron', started_at: 10, messages: [['user', 11], ['assistant', 12]] })
    insertSession(db, { id: 'cron_empty', source: 'cron', started_at: 20 })
    for (let i = 0; i < 25; i += 1) insertSession(db, { id: `cli-${String(i)}`, source: 'cli', started_at: 100 + i, messages: [['user', 100 + i]] })
    db.close()
    await s.deps.settings.save({ show_cli_sessions: true })
    s.deps.cliSessions.invalidate()
  })
  afterAll(() => s.close())

  it('an older cron session outnumbered by newer CLI rows is still listed with a project', async () => {
    const rows = (await json(await s.get('/api/sessions?show_cron_sessions=1'))).sessions as Json[]
    const cron = rows.find((r) => r.session_id === 'cron_old_1')
    expect(cron, JSON.stringify(rows.map((r) => r.session_id))).toBeDefined()
    expect(cron?.source_tag).toBe('cron')
    expect(cron?.project_id).toBeTruthy()
  })

  it('each cron id appears exactly once', async () => {
    const rows = (await json(await s.get('/api/sessions?show_cron_sessions=1'))).sessions as Json[]
    expect(rows.filter((r) => r.session_id === 'cron_old_1')).toHaveLength(1)
  })

  it('a message-less cron row is not surfaced', async () => {
    const rows = (await json(await s.get('/api/sessions?show_cron_sessions=1'))).sessions as Json[]
    expect(rows.map((r) => r.session_id)).not.toContain('cron_empty')
  })

  it('a sidecar that claims CLI but whose state.db row says webui lists as a WebUI session', async () => {
    const db = openStateDb(dbPath)
    insertSession(db, { id: 'stale-json', source: 'webui', started_at: 500, messages: [['user', 501]] })
    db.close()
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    session.session_id = 'stale-json'
    session.messages = [{ role: 'user', content: 'hi' }]
    Object.assign(session, { is_cli_session: true, session_source: 'cli', raw_source: 'cli' })
    await s.deps.sessionStore.save(session)
    s.deps.cliSessions.invalidate()
    const rows = (await json(await s.get('/api/sessions'))).sessions as Json[]
    const row = rows.find((r) => r.session_id === 'stale-json')
    expect(row, JSON.stringify(rows.map((r) => r.session_id))).toBeDefined()
    expect(row).toMatchObject({ is_cli_session: false, session_source: 'webui' })
  })
})

describe('sidebar automated-session counts (TAL-482)', () => {
  useSelectedStorage()
  let s: TestServer
  beforeAll(async () => {
    s = await bootTestServer()
    const db = createStateDb(join(s.state, 'state.db'))
    // One past the server's 200-row per-kind window, so the count has to say more exist.
    for (let i = 0; i < 201; i += 1) insertSession(db, { id: `cron_job_${String(i)}`, source: 'cron', started_at: 1_000 + i, messages: [['user', 1_000 + i]] })
    for (let i = 0; i < 3; i += 1) insertSession(db, { id: `hook-${String(i)}`, source: 'webhook', started_at: 2_000 + i, messages: [['user', 2_000 + i]] })
    db.close()
    s.deps.cliSessions.invalidate()
  })
  afterAll(() => s.close())

  it('counts listed scheduled and webhook sessions and flags the capped kind', async () => {
    const body = await json(await s.get('/api/sessions?show_cron_sessions=1&show_webhook_sessions=1'))
    expect(body).toMatchObject({ scheduled_session_count: 200, scheduled_sessions_truncated: true, webhook_session_count: 3, webhook_sessions_truncated: false })
  })

  it('does not flag a kind the request hides', async () => {
    const body = await json(await s.get('/api/sessions?show_cron_sessions=0&show_webhook_sessions=1'))
    expect(body).toMatchObject({ scheduled_session_count: 0, scheduled_sessions_truncated: false, webhook_session_count: 3 })
  })

  it('leaves archived sessions out of the count', async () => {
    expect((await post(s, '/api/session/archive', { session_id: 'hook-0', archived: true })).status).toBe(200)
    s.deps.cliSessions.invalidate()
    const body = await json(await s.get('/api/sessions?show_cron_sessions=1&show_webhook_sessions=1'))
    expect(body).toMatchObject({ webhook_session_count: 2, webhook_sessions_truncated: false })
  })
})

describe('server-classified session sources (TAL-310)', () => {
  useSelectedStorage()
  let s: TestServer
  const platforms = ['signal', 'whatsapp', 'weixin', 'wecom_callback']
  const rowsOf = async (path: string): Promise<Json[]> => (await json(await s.get(path))).sessions as Json[]
  const sidecar = async (title: string, fields: Json): Promise<string> => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const stored = (await s.deps.sessionStore.get(sid))
    stored.title = title
    stored.messages = [{ role: 'user', content: 'kindprobe', timestamp: 3000 }, { role: 'assistant', content: 'ok', timestamp: 3001 }]
    Object.assign(stored, fields)
    await s.deps.sessionStore.save(stored)
    return sid
  }
  beforeAll(async () => {
    s = await bootTestServer()
    const db = createStateDb(join(s.state, 'state.db'))
    platforms.forEach((source, i) => { insertSession(db, { id: `chat-${source}`, source, started_at: 1_000 + i, messages: [['user', 1_000 + i], ['assistant', 1_001 + i]] }) })
    db.close()
    await s.deps.settings.save({ show_cli_sessions: true })
    s.deps.cliSessions.invalidate()
  })
  afterAll(() => s.close())

  it('files every messaging platform from the state.db scan as messaging, with its detail', async () => {
    const rows = await rowsOf('/api/sessions')
    for (const source of platforms) {
      const row = rows.find((r) => r.session_id === `chat-${source}`)
      expect(row, `${source} in ${JSON.stringify(rows.map((r) => r.session_id))}`).toMatchObject({ source_kind: 'messaging', is_messaging_session: true, session_source: 'messaging' })
      const detail = (await json(await s.get(`/api/session?session_id=chat-${source}`))).session as Json
      expect(detail, source).toMatchObject({ source_kind: 'messaging', is_messaging_session: true })
    }
  })

  it('files a messaging sidecar from the session index as messaging in the list, detail and search', async () => {
    const sid = await sidecar('Kindprobe signal', { raw_source: 'signal' })
    const hit = (await rowsOf('/api/sessions/search?q=kindprobe')).find((r) => r.session_id === sid)
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const row = (await rowsOf('/api/sessions')).find((r) => r.session_id === sid)
    for (const payload of [hit, detail, row]) expect(payload).toMatchObject({ source_kind: 'messaging', is_messaging_session: true })
  })

  it('keeps a WebUI-marked session with a stale is_cli_session out of CLI', async () => {
    const sid = await sidecar('Kindprobe stale', { session_source: 'webui', is_cli_session: true })
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    const row = (await rowsOf('/api/sessions')).find((r) => r.session_id === sid)
    for (const payload of [detail, row]) expect(payload).toMatchObject({ source_kind: 'webui', is_messaging_session: false, is_cli_session: false })
  })
})
