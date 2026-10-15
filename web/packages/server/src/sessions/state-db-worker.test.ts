import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { CliSessionSource } from './cli-sessions.js'
import { GatewayWatcher } from './gateway-watcher.js'
import { Session } from './session.js'
import { crashStateDbWorkerForTests, readImportableAgentSessionRowsAsync, setStateDbReadDelayForTests, stopStateDbWorker } from './state-db.js'

type Json = Record<string, unknown>

/** Read-only `state.db` opens made on this (the server's) thread; the listing worker loads the real `node:sqlite`. */
const mainThreadOpens = vi.hoisted(() => [] as string[])
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>()
  class CountingDatabaseSync extends real.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      super(...args)
      if (args[1]?.readOnly) mainThreadOpens.push(String(args[0]))
    }
  }
  return { ...real, DatabaseSync: CountingDatabaseSync }
})

const ALL_SOURCES = '/api/sessions?show_cli_sessions=1&show_claude_code_sessions=1&show_cron_sessions=1&show_webhook_sessions=1'

function seedStateDb(path: string, ids: { id: string; source: string; at: number }[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, title TEXT,
    chat_id TEXT, chat_type TEXT, thread_id TEXT, session_key TEXT, origin_chat_id TEXT, origin_user_id TEXT, platform TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`)
  for (const { id, source, at } of ids) {
    db.prepare('INSERT INTO sessions (id, source, started_at, title, message_count, chat_id) VALUES (?, ?, ?, ?, 2, ?)').run(id, source, at, `${id} title`, `chat-${id}`)
    for (const [role, ts] of [['user', at + 1], ['assistant', at + 2]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(id, role, 'hi', ts)
  }
  db.close()
}

const ids = (body: Json): string[] => (body.sessions as Json[]).map((r) => String(r.session_id))

describe('session list state.db reads off the event loop (TAL-920)', () => {
  let s: TestServer
  let dbPath: string
  beforeAll(async () => {
    s = await bootTestServer()
    dbPath = join(s.state, 'state.db')
    seedStateDb(dbPath, [
      { id: 'cli-a', source: 'cli', at: 1000 }, { id: 'tg-a', source: 'telegram', at: 1010 },
      { id: 'cron_job1_1', source: 'cron', at: 1020 }, { id: 'hook-a', source: 'webhook', at: 1030 },
    ])
  })
  afterAll(async () => { setStateDbReadDelayForTests(0); await s.close() })

  it('never opens state.db on the main thread for /api/sessions, the gateway poll, or relay agent sessions', async () => {
    // A claimed CLI import and a read-only one exercise the list's owner-lock and orphan-prune lookups too.
    s.deps.sessionStore.save(new Session({ session_id: 'cli-a', title: 'Claimed', source_tag: 'cli', raw_source: 'cli', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
    s.deps.sessionStore.save(new Session({ session_id: 'cli-gone', title: 'Gone', source_tag: 'cli', raw_source: 'cli', read_only: true, messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
    s.deps.cliSessions.invalidate()
    mainThreadOpens.length = 0
    const res = await s.get(ALL_SOURCES)
    expect(res.status).toBe(200)
    const listed = ids((await res.json()) as Json)
    expect(listed).toEqual(expect.arrayContaining(['cli-a', 'tg-a', 'cron_job1_1', 'hook-a']))
    // The orphan prune still ran: the read-only import with no state.db row is gone.
    expect(listed).not.toContain('cli-gone')
    const watcher = new GatewayWatcher('default', s.state, { now: () => Date.now() / 1000, log: () => undefined })
    const sub = watcher.subscribe()
    expect(await watcher.pollOnce()).toBe(true)
    expect((await sub.next(AbortSignal.timeout(2000)))?.sessions.map((r) => r.session_id)).toContain('tg-a')
    watcher.stop()
    const agentSessions = (s.deps.relay as unknown as { deps: { agentSessions: (profile: string) => Promise<Json[]> } }).deps.agentSessions
    expect((await agentSessions('default')).map((r) => r.id)).toContain('tg-a')
    expect(mainThreadOpens.filter((path) => path === dbPath)).toEqual([])
  })

  it('answers /health while a slow state.db read holds /api/sessions', async () => {
    s.deps.cliSessions.invalidate()
    setStateDbReadDelayForTests(2000)
    let sessionsAt = Number.POSITIVE_INFINITY
    try {
      const sessions = s.get(ALL_SOURCES).then((res) => { sessionsAt = performance.now(); return res })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const healthStart = performance.now()
      const health = await s.get('/health')
      const healthAt = performance.now()
      setStateDbReadDelayForTests(0)
      expect(health.status).toBe(200)
      expect(healthAt - healthStart).toBeLessThan(200)
      expect(healthAt).toBeLessThan(sessionsAt)
      const res = await sessions
      expect(res.status).toBe(200)
      expect(ids((await res.json()) as Json)).toContain('tg-a')
    } finally {
      setStateDbReadDelayForTests(0)
    }
  })

  it('takes sidecar titles and archived flags from the session index, reading only unindexed sidecar files', async () => {
    const extra = Array.from({ length: 5 }, (_, i) => ({ id: `idx-${String(i)}`, source: 'telegram', at: 2000 + i }))
    seedStateDb(dbPath, extra)
    for (const [i, { id }] of extra.slice(0, 4).entries()) {
      s.deps.sessionStore.save(new Session({ session_id: id, title: `Indexed ${String(i)}`, archived: i === 0, source_tag: 'telegram', raw_source: 'telegram', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
    }
    // A sidecar file the index has never listed is read from disk.
    writeFileSync(join(s.deps.sessionStore.sessionDir, 'idx-4.json'), JSON.stringify({ session_id: 'idx-4', title: 'From file', created_at: 1, updated_at: 1, message_count: 2, archived: true, messages: [] }))
    s.deps.cliSessions.invalidate()
    const loads = vi.spyOn(s.deps.sessionStore, 'loadMetadataOnly')
    try {
      const { rows } = await s.deps.cliSessions.read('default')
      const byId = new Map(rows.map((r) => [String(r.session_id), r]))
      expect(extra.map(({ id }) => [byId.get(id)?.title, byId.get(id)?.archived])).toEqual([['Indexed 0', true], ['Indexed 1', false], ['Indexed 2', false], ['Indexed 3', false], ['From file', true]])
      expect(byId.get('tg-a')).toMatchObject({ title: 'tg-a title', archived: false })
      expect(loads.mock.calls.map(([sid]) => sid)).toEqual(['idx-4'])
    } finally {
      loads.mockRestore()
    }
  })

  it('degrades a crashed worker or a failed query to no CLI rows with the same log line, then restarts the worker', async () => {
    s.deps.cliSessions.invalidate()
    // The crash request runs first, so the worker exits with the sidebar read still queued behind it.
    const crash = crashStateDbWorkerForTests().catch((error: unknown) => error as Error)
    const logs: string[] = []
    const source = new CliSessionSource({ store: s.deps.sessionStore, profilesMatch: s.deps.profilesMatch, profileHome: () => s.state, lastWorkspace: () => s.state, now: () => Date.now() / 1000, log: (line) => logs.push(line) })
    expect((await source.read('default')).rows).toEqual([])
    expect(((await crash) as Error).message).toMatch(/state\.db worker exited/)
    expect(logs).toEqual([expect.stringMatching(/^\[webui\] get_cli_sessions\(\) failed; check state\.db schema or path .*state\.db worker exited/) as unknown])
    source.invalidate()
    expect((await source.read('default')).rows.map((r) => r.session_id)).toContain('tg-a')
    // A sessions table without the columns the listing selects fails the query in the worker, which keeps serving.
    const broken = join(s.state, 'broken')
    mkdirSync(broken, { recursive: true })
    const db = new DatabaseSync(join(broken, 'state.db'))
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT); INSERT INTO sessions VALUES ('x', 'cli')")
    db.close()
    const brokenLogs: string[] = []
    const brokenSource = new CliSessionSource({ store: s.deps.sessionStore, profilesMatch: s.deps.profilesMatch, profileHome: () => broken, lastWorkspace: () => broken, now: () => Date.now() / 1000, log: (line) => brokenLogs.push(line) })
    expect((await brokenSource.read('default')).rows).toEqual([])
    expect(brokenLogs).toEqual([expect.stringMatching(/^\[webui\] get_cli_sessions\(\) failed; check state\.db schema or path .*: no such column/) as unknown])
    expect((await readImportableAgentSessionRowsAsync(dbPath)).map((r) => r.id)).toContain('tg-a')
  })

  it('never stacks gateway polls', async () => {
    const watcher = new GatewayWatcher('default', s.state, { now: () => Date.now() / 1000, log: () => undefined })
    setStateDbReadDelayForTests(300)
    try {
      const first = watcher.pollOnce()
      expect(await watcher.pollOnce()).toBe(false)
      expect(await first).toBe(true)
    } finally {
      setStateDbReadDelayForTests(0)
      watcher.stop()
    }
  })

  it('lets no read interrupted by shutdown restart the worker while it stops', async () => {
    const watcher = new GatewayWatcher('default', s.state, { now: () => Date.now() / 1000, log: () => undefined })
    setStateDbReadDelayForTests(1500)
    // The fingerprint read is held when the stop lands; its caller then goes on to the projection read.
    const poll = watcher.pollOnce()
    setStateDbReadDelayForTests(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await stopStateDbWorker()
    expect(await poll).toBe(false)
    watcher.stop()
  })

  it('stops the worker on server shutdown without leaving a read hanging, and starts a fresh one on the next call', async () => {
    const other = await bootTestServer()
    seedStateDb(join(other.state, 'state.db'), [{ id: 'tg-b', source: 'telegram', at: 1000 }])
    setStateDbReadDelayForTests(1500)
    const started = performance.now()
    const read = other.deps.cliSessions.read('default')
    setStateDbReadDelayForTests(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await other.close()
    expect((await read).rows).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
    expect(other.logs.some((line) => line.includes('state.db worker stopped'))).toBe(true)
    expect((await readImportableAgentSessionRowsAsync(dbPath)).map((r) => r.id)).toContain('tg-a')
    await stopStateDbWorker()
  })
})
