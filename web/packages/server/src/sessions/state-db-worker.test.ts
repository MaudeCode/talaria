import { sessionDirectory } from '../test/storage.js'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { str } from '../util.js'
import { CliSessionSource } from './cli-sessions.js'
import { GatewayWatcher } from './gateway-watcher.js'
import { Session } from './session.js'
import { agentSessionRowsExistingAsync, crashStateDbWorkerForTests, readImportableAgentSessionRowsAsync, setStateDbReadDelayForTests, stateDbSessionReadAsync, stateDbSessionSourcesAsync, stopStateDbWorker, type StateDbWorkerReply, type StateDbWorkerRequest } from './state-db.js'

type Json = Record<string, unknown>

/** Read-only `state.db` opens made on this (the server's) thread; the listing worker loads the real `node:sqlite`. */
const mainThreadOpens = vi.hoisted(() => [] as string[])
/** Each main-thread open's stack, so a failure names its caller. */
const mainThreadStacks = vi.hoisted(() => [] as string[])
/** A main-thread open blocks the thread this long, as a slow state.db does under memory pressure. */
const mainThreadOpenDelay = vi.hoisted(() => ({ ms: 0 }))
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>()
  class CountingDatabaseSync extends real.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      super(...args)
      if (!args[1]?.readOnly) return
      mainThreadOpens.push(String(args[0]))
      mainThreadStacks.push(new Error().stack ?? '')
      if (mainThreadOpenDelay.ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, mainThreadOpenDelay.ms)
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

describe('independent state.db worker lanes (TAL-1189)', () => {
  let dir: string
  let dbPath: string
  const sessionRow = (): Promise<Json | null> => stateDbSessionReadAsync(null, 'stateDbSessionRow', dbPath, 'lane-session')
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'talaria-state-db-lanes-'))
    dbPath = join(dir, 'state.db')
    seedStateDb(dbPath, [{ id: 'lane-session', source: 'cli', at: 1000 }])
  })
  afterEach(async () => { setStateDbReadDelayForTests(0); await stopStateDbWorker() })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('resolves a single-session row before an already queued slow listing', async () => {
    // Warm both lanes so startup scheduling cannot determine the completion order.
    await Promise.all([readImportableAgentSessionRowsAsync(dbPath), sessionRow()])
    setStateDbReadDelayForTests(1500)
    const listing = readImportableAgentSessionRowsAsync(dbPath).then(() => 'listing')
    setStateDbReadDelayForTests(0)
    const session = sessionRow().then((row) => { expect(row?.id).toBe('lane-session'); return 'session' })
    try {
      expect(await Promise.race([listing, session])).toBe('session')
    } finally {
      await Promise.all([listing, session])
    }
  })

  it('routes mutation sources and existence probes around a slow listing too', async () => {
    await Promise.all([readImportableAgentSessionRowsAsync(dbPath), sessionRow()])
    setStateDbReadDelayForTests(1500)
    const listing = readImportableAgentSessionRowsAsync(dbPath).then(() => 'listing')
    setStateDbReadDelayForTests(0)
    const probes = Promise.all([
      stateDbSessionSourcesAsync(dbPath, ['lane-session']),
      agentSessionRowsExistingAsync(dbPath, ['lane-session']),
    ]).then(([sources, existing]) => {
      expect(sources?.has('lane-session')).toBe(true)
      expect(existing).toEqual(new Set(['lane-session']))
      return 'probes'
    })
    try {
      expect(await Promise.race([listing, probes])).toBe('probes')
    } finally {
      await Promise.all([listing, probes])
    }
  })

  it.each(['listing', 'session'] as const)('keeps FIFO order within the %s lane', async (lane) => {
    const read = (): Promise<unknown> => lane === 'listing' ? readImportableAgentSessionRowsAsync(dbPath) : sessionRow()
    await read()
    setStateDbReadDelayForTests(300)
    const first = read().then(() => 'first')
    setStateDbReadDelayForTests(0)
    const second = read().then(() => 'second')
    expect(await Promise.race([first, second])).toBe('first')
    await second
  })

  it.each(['listing', 'session'] as const)('isolates a %s crash and restarts only the crashed lane', async (lane) => {
    const listingRow = (): Promise<Json | null> => readImportableAgentSessionRowsAsync(dbPath).then((rows) => rows[0] ?? null).catch(() => null)
    const affected = lane === 'listing' ? listingRow : sessionRow
    const unaffected = lane === 'listing' ? sessionRow : listingRow
    await Promise.all([affected(), unaffected()])
    setStateDbReadDelayForTests(1500)
    const pending = unaffected()
    setStateDbReadDelayForTests(0)
    const crash = crashStateDbWorkerForTests(lane)
    const interrupted = affected()
    await expect(crash).rejects.toThrow(/state\.db worker exited/)
    expect(await interrupted).toBeNull()
    expect(await affected()).toMatchObject({ id: 'lane-session' })
    expect(await pending).toMatchObject({ id: 'lane-session' })
  })

  it('terminates both blocked workers, settles their reads and restarts both lanes after shutdown', async () => {
    await Promise.all([readImportableAgentSessionRowsAsync(dbPath), sessionRow()])
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    setStateDbReadDelayForTests(1500)
    const listing = readImportableAgentSessionRowsAsync(dbPath).catch((error: unknown) => error as Error)
    const session = sessionRow()
    setStateDbReadDelayForTests(0)
    try {
      const stop = stopStateDbWorker()
      // Neither lane may restart while shutdown is draining the old workers.
      await expect(readImportableAgentSessionRowsAsync(dbPath)).rejects.toThrow('state.db worker stopped')
      expect(await sessionRow()).toBeNull()
      await stop
      expect(((await listing) as Error).message).toBe('state.db worker stopped')
      expect(await session).toBeNull()
      expect(terminate).toHaveBeenCalledTimes(2)
      expect(terminate.mock.contexts.map((worker) => (worker as Worker).threadId)).toEqual([-1, -1])
    } finally {
      terminate.mockRestore()
    }
    expect((await readImportableAgentSessionRowsAsync(dbPath))[0]?.id).toBe('lane-session')
    expect(await sessionRow()).toMatchObject({ id: 'lane-session' })
  })
})

describe('sidebar probe lane isolation (TAL-1189)', () => {
  let s: TestServer
  let dbPath: string
  beforeAll(async () => {
    s = await bootTestServer()
    dbPath = join(s.state, 'state.db')
    seedStateDb(dbPath, [{ id: 'sidebar-cli', source: 'cli', at: 1000 }, { id: 'cron_job1_1', source: 'cron', at: 1010 }])
    const db = new DatabaseSync(dbPath)
    try { db.exec("UPDATE sessions SET title = NULL WHERE source = 'cron'") } finally { db.close() }
    await s.deps.sessionStore.save(new Session({ session_id: 'sidebar-cli', title: 'Imported', source_tag: 'cli', raw_source: 'cli', read_only: true, messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, { workspace: s.state, model: null }))
  })
  afterAll(async () => { await s.close() })

  it.each(['sources', 'existing', 'cron admissions'] as const)('serves interactive reads before a held sidebar %s probe', async (phase) => {
    s.deps.cliSessions.invalidate()
    await Promise.all([readImportableAgentSessionRowsAsync(dbPath), stateDbSessionReadAsync(null, 'stateDbSessionRow', dbPath, 'sidebar-cli')])
    let dispatched!: () => void
    let completed!: () => void
    const started = new Promise<void>((resolve) => { dispatched = resolve })
    const held = new Promise<void>((resolve) => { completed = resolve })
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forward with the original Worker receiver below.
    const post = Worker.prototype.postMessage
    const calls = vi.spyOn(Worker.prototype, 'postMessage')
    let heldRequest = false
    let cleanup = (): void => undefined
    calls.mockImplementation(function (this: Worker, value, transferList) {
      const request = value as StateDbWorkerRequest
      const matches = phase === 'cron admissions' ? request.op === 'session' && request.read === 'stateDbCronJobIds' : request.op === phase
      if (!heldRequest && matches) {
        heldRequest = true
        const onReply = (reply: StateDbWorkerReply): void => { if (reply.id === request.id) completed() }
        this.on('message', onReply)
        cleanup = () => { this.off('message', onReply) }
        post.call(this, { ...request, delayMs: 1500 }, transferList)
        dispatched()
      } else post.call(this, value, transferList)
    })
    const listing = s.get(ALL_SOURCES).then(async (res) => { expect(res.status).toBe(200); return ids(await res.json() as Json) })
    try {
      await Promise.race([started, listing.then(() => { throw new Error(`sidebar never dispatched ${phase}`) })])
      const interactive = Promise.all([
        stateDbSessionReadAsync(null, 'stateDbSessionRow', dbPath, 'sidebar-cli'),
        stateDbSessionSourcesAsync(dbPath, ['sidebar-cli']),
        agentSessionRowsExistingAsync(dbPath, ['sidebar-cli']),
      ]).then(([row, sources, existing]) => {
        expect(row?.id).toBe('sidebar-cli')
        expect(sources?.get('sidebar-cli')).toBe('cli')
        expect(existing).toEqual(new Set(['sidebar-cli']))
        return 'interactive'
      })
      expect(await Promise.race([held.then(() => 'sidebar'), interactive])).toBe('interactive')
      expect(await listing).toEqual(expect.arrayContaining(['sidebar-cli', 'cron_job1_1']))
    } finally {
      try { await listing } finally {
        calls.mockRestore()
        cleanup()
      }
    }
  })
})

/** The stacks of this thread's opens of `dbPath` while `run` handles one request. */
async function opensDuring(s: TestServer, dbPath: string, run: () => Promise<void>): Promise<string[]> {
  s.deps.cliSessions.invalidate()
  mainThreadOpens.length = 0
  mainThreadStacks.length = 0
  await run()
  return mainThreadStacks.filter((_, i) => mainThreadOpens[i] === dbPath)
}

/** `request` against a slow state.db: worker reads held 2 s, main-thread opens 500 ms. Neither `/health` nor the event loop waits on it. */
async function expectHealthyWhileSlow(s: TestServer, request: () => Promise<unknown>, outcome: unknown): Promise<void> {
  s.deps.cliSessions.invalidate()
  setStateDbReadDelayForTests(2000)
  mainThreadOpenDelay.ms = 500
  let doneAt = Number.POSITIVE_INFINITY
  // The test client shares the server's thread, so the longest event-loop stall is what a watchdog probe would wait.
  let last = performance.now()
  let maxGap = 0
  const ticker = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now }, 10)
  try {
    const pending = request().then((result) => { doneAt = performance.now(); return result })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const healthStart = performance.now()
    const health = await s.get('/health')
    const healthAt = performance.now()
    const result = await pending
    clearInterval(ticker)
    expect(maxGap).toBeLessThan(200)
    expect(health.status).toBe(200)
    expect(healthAt - healthStart).toBeLessThan(200)
    expect(healthAt).toBeLessThan(doneAt)
    expect(result).toEqual(outcome)
  } finally {
    clearInterval(ticker)
    setStateDbReadDelayForTests(0)
    mainThreadOpenDelay.ms = 0
  }
}

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
    await s.deps.sessionStore.save(new Session({ session_id: 'cli-a', title: 'Claimed', source_tag: 'cli', raw_source: 'cli', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
    await s.deps.sessionStore.save(new Session({ session_id: 'cli-gone', title: 'Gone', source_tag: 'cli', raw_source: 'cli', read_only: true, messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
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

  it('reads cron admissions and completion links only on the worker', async () => {
    mainThreadOpens.length = 0
    expect(await stateDbSessionReadAsync(new Map(), 'stateDbCronJobIds', dbPath)).toEqual(new Map())
    expect(await stateDbSessionReadAsync(new Map(), 'latestCronSessionInfo', dbPath, ['job1'], ['job1'])).toEqual(new Map([['job1', { session_id: 'cron_job1_1', message_count: 2 }]]))
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
      await s.deps.sessionStore.save(new Session({ session_id: id, title: `Indexed ${String(i)}`, archived: i === 0, source_tag: 'telegram', raw_source: 'telegram', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
    }
    // A sidecar file the index has never listed is read from disk.
    writeFileSync(join(sessionDirectory(s.deps.sessionStore), 'idx-4.json'), JSON.stringify({ session_id: 'idx-4', title: 'From file', created_at: 1, updated_at: 1, message_count: 2, archived: true, messages: [] }))
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
    await new Promise((resolve) => setTimeout(resolve, 100))
    await other.close()
    // The session-index lookup can yield before dispatch: keep the delay armed until shutdown interrupts the read.
    setStateDbReadDelayForTests(0)
    expect((await read).rows).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
    expect(other.logs.some((line) => line.includes('state.db worker stopped'))).toBe(true)
    expect((await readImportableAgentSessionRowsAsync(dbPath)).map((r) => r.id)).toContain('tg-a')
    await stopStateDbWorker()
  })
})

describe('single-session state.db lookups off the event loop (TAL-923)', () => {
  let s: TestServer
  let dbPath: string
  const post = (path: string, body: Json): Promise<Response> => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const subagentStart = (): Promise<Response> => post('/api/chat/start', { session_id: 'sub-a', message: 'hi' })
  const SUBAGENT_REFUSAL = [403, 'session is read-only in its foreign store; cannot be claimed writeable in WebUI']
  beforeAll(async () => {
    s = await bootTestServer()
    dbPath = join(s.state, 'state.db')
    seedStateDb(dbPath, [{ id: 'sub-a', source: 'subagent', at: 1000 }, { id: 'cli-d', source: 'cli', at: 1010 }, { id: 'web-p', source: 'webui', at: 1020 }])
    for (const [sid, title] of [['web-p', 'Pin me'], ['web-d', 'Delete me']] as const) {
      await s.deps.sessionStore.save(new Session({ session_id: sid, title, source_tag: 'webui', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
    }
  })
  afterAll(async () => { setStateDbReadDelayForTests(0); mainThreadOpenDelay.ms = 0; await s.close() })

  it('never opens state.db on the main thread for chat start, a state.db-only detail, pin, unpin, or delete', async () => {
    expect(await opensDuring(s, dbPath, async () => {
      const res = await subagentStart()
      expect([res.status, ((await res.json()) as Json).error]).toEqual(SUBAGENT_REFUSAL)
    })).toEqual([])
    expect(await opensDuring(s, dbPath, async () => {
      const res = await s.get('/api/session?session_id=cli-d')
      expect(((await res.json()) as { session: Json }).session).toMatchObject({ session_id: 'cli-d', title: 'cli-d title', read_only: false })
    })).toEqual([])
    for (const pinned of [true, false]) {
      expect(await opensDuring(s, dbPath, async () => {
        const res = await post('/api/session/pin', { session_id: 'web-p', pinned })
        expect(((await res.json()) as { session: Json }).session.pinned).toBe(pinned)
      })).toEqual([])
    }
    expect(await opensDuring(s, dbPath, async () => { expect((await post('/api/session/delete', { session_id: 'web-d' })).status).toBe(200) })).toEqual([])
    expect(await s.deps.sessionStore.loadMetadataOnly('web-d')).toBeNull()
  })

  it('looks one session up by id instead of building the sidebar listing', async () => {
    const reads = vi.spyOn(s.deps.cliSessions, 'read')
    try {
      await s.deps.sessionStore.save(new Session({ session_id: 'web-e', title: 'Delete me too', source_tag: 'webui', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }, { workspace: s.state, model: null }))
      s.deps.cliSessions.invalidate()
      expect((await subagentStart()).status).toBe(403)
      expect((await s.get('/api/session?session_id=cli-d')).status).toBe(200)
      for (const pinned of [true, false]) expect((await post('/api/session/pin', { session_id: 'web-p', pinned })).status).toBe(200)
      expect((await post('/api/session/delete', { session_id: 'web-e' })).status).toBe(200)
      expect(reads.mock.calls.length).toBeGreaterThan(0)
      expect(reads.mock.calls.filter(([, opts]) => !opts?.sessionIds?.length).map(([, opts]) => opts), 'an unwindowed sidebar read').toEqual([])
    } finally {
      reads.mockRestore()
    }
    // The targeted row is the one the sidebar lists, Web-born state.db rows included.
    seedStateDb(dbPath, [{ id: 'cron_job9_1', source: 'cron', at: 1030 }, { id: 'chain-root', source: 'cli', at: 1040 }, { id: 'chain-tip', source: 'cli', at: 1050 }])
    const db = new DatabaseSync(dbPath)
    db.exec("UPDATE sessions SET end_reason = 'compression', ended_at = 1050 WHERE id = 'chain-root'; UPDATE sessions SET parent_session_id = 'chain-root' WHERE id = 'chain-tip'")
    db.close()
    s.deps.cliSessions.invalidate()
    const listed = new Map((await s.deps.cliSessions.read('default')).rows.map((r) => [String(r.session_id), r]))
    const lookup = (s.deps.sessions as unknown as { lookupCliMeta: (sid: string) => Promise<Json | null> }).lookupCliMeta.bind(s.deps.sessions)
    // A compression chain lists as one row: the root's lineage under its tip's id.
    expect(listed.get('chain-tip')).toMatchObject({ _lineage_root_id: 'chain-root', parent_session_id: null })
    for (const sid of ['cli-d', 'sub-a', 'web-p', 'cron_job9_1', 'chain-tip']) {
      expect(listed.get(sid), sid).toBeDefined()
      expect(await lookup(sid), sid).toEqual(listed.get(sid))
    }
  })

  it('follows only compression continuations when it reads a chain, however many other children hang off it', async () => {
    const forks = Array.from({ length: 1000 }, (_, i) => ({ id: `fan-fork-${String(i)}`, source: 'telegram', at: 3000 + i }))
    seedStateDb(dbPath, [{ id: 'fan-tip1', source: 'cli', at: 2000 }, { id: 'fan-tip2', source: 'cli', at: 2100 }, { id: 'fan-tip3', source: 'cli', at: 2200 }, ...forks])
    const db = new DatabaseSync(dbPath)
    db.exec(`UPDATE sessions SET end_reason = 'compression', ended_at = 2100 WHERE id = 'fan-tip1';
      UPDATE sessions SET parent_session_id = 'fan-tip1', end_reason = 'compression', ended_at = 2200 WHERE id = 'fan-tip2';
      UPDATE sessions SET parent_session_id = 'fan-tip2' WHERE id = 'fan-tip3';
      UPDATE sessions SET parent_session_id = 'fan-tip1' WHERE id LIKE 'fan-fork-%'`)
    db.close()
    const { rows } = await s.deps.cliSessions.read('default', { sourceFilter: null, sessionIds: ['fan-tip1'], sidebarRows: true })
    expect(rows.map((r) => [r.session_id, r._lineage_root_id])).toEqual([['fan-tip3', 'fan-tip1']])
  })

  it.each([
    ['a chat start on a state.db-only subagent session', async () => { const res = await subagentStart(); return [res.status, ((await res.json()) as Json).error] }, SUBAGENT_REFUSAL],
    ['a pin', async () => { const res = await post('/api/session/pin', { session_id: 'web-p', pinned: true }); return [res.status, ((await res.json()) as { session: Json }).session.pinned] }, [200, true]],
  ])('answers /health while a slow state.db holds %s', async (_, request, outcome) => {
    await expectHealthyWhileSlow(s, request, outcome)
  }, 60_000)
})

describe('transcript state.db reads off the event loop (TAL-1162)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let dbPath: string
  const post = (path: string, body: Json): Promise<Response> => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const completedTurn = (messages: Json[]): SidecarResult<'chat.start'> => ({
    status: 'completed', messages, final_response: str(messages.at(-1)?.content), error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  })
  /** Rows a CLI or the turn's Agent commits to state.db for `sid`. */
  const commit = (sid: string, rows: [string, string, number][]): void => {
    const db = new DatabaseSync(dbPath)
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
  }
  const maxId = (sid: string): number => {
    const db = new DatabaseSync(dbPath)
    try { return (db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?').get(sid) as { id: number }).id } finally { db.close() }
  }
  /** A WebUI session whose state.db holds its two rows and a CLI row the transcript has not seen yet. */
  const seeded = async (sid: string, at: number): Promise<void> => {
    seedStateDb(dbPath, [{ id: sid, source: 'webui', at }])
    commit(sid, [['user', 'CLI later', at + 3]])
    await s.deps.sessionStore.save(new Session({ session_id: sid, title: sid, source_tag: 'webui', messages: [{ role: 'user', content: 'hi', timestamp: at + 1 }, { role: 'assistant', content: 'hi', timestamp: at + 2 }] }, { workspace: join(s.state, 'workspace'), model: null }))
  }
  const contents = async (path: string): Promise<unknown[]> => (((await (await s.get(path)).json()) as { session: Json }).session.messages as Json[]).map((m) => m.content)
  /** A turn whose Agent commits its prompt and answer to state.db, run through to the end of its stream. */
  const turn = async (sid: string, message: string): Promise<[number, unknown]> => {
    sidecar.respond('chat.start', (params) => {
      commit(sid, [['user', message, 9000], ['assistant', `${message} answered`, 9001]])
      return completedTurn([...params.conversation_history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: `${message} answered` }])
    })
    const res = await post('/api/chat/start', { session_id: sid, message })
    const start = (await res.json()) as Json
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    return [res.status, (await contents(`/api/session?session_id=${sid}`)).at(-1)]
  }
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    s = await bootTestServer({ sidecar })
    dbPath = join(s.state, 'state.db')
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
  })
  afterAll(async () => { setStateDbReadDelayForTests(0); mainThreadOpenDelay.ms = 0; await s.close() })

  it('never opens state.db on the main thread for a turn, its settlement, a cancelled turn, or the session detail', async () => {
    await seeded('web-turn', 1000)
    expect(await opensDuring(s, dbPath, async () => { expect(await turn('web-turn', 'next')).toEqual([200, 'next answered']) })).toEqual([])
    expect(await contents('/api/session?session_id=web-turn')).toEqual(['hi', 'hi', 'CLI later', 'next', 'next answered'])
    expect((await s.deps.sessionStore.get('web-turn')).state_db_seen_id).toBe(maxId('web-turn'))

    await seeded('web-detail', 1100)
    expect(await opensDuring(s, dbPath, async () => {
      expect(await contents('/api/session?session_id=web-detail')).toEqual(['hi', 'hi', 'CLI later'])
      expect((await contents('/api/session?session_id=web-detail&msg_limit=2')).at(-1)).toBe('CLI later')
    })).toEqual([])

    await seeded('web-cancel', 1200)
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      commit('web-cancel', [['user', 'stop me', 9000], ['assistant', 'partial', 9001]])
      emit({ event: 'token', data: { text: 'partial' } })
      opts.signal?.addEventListener('abort', () => { resolve({ ...completedTurn([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
    const streamId = String(((await (await post('/api/chat/start', { session_id: 'web-cancel', message: 'stop me' })).json()) as Json).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    expect(await opensDuring(s, dbPath, async () => {
      await s.get(`/api/chat/cancel?stream_id=${streamId}`)
      await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
    })).toEqual([])
    expect((await contents('/api/session?session_id=web-cancel')).filter((c) => c === 'stop me' || c === 'partial' || c === 'CLI later')).toEqual(['CLI later', 'stop me', 'partial'])
    expect((await s.deps.sessionStore.get('web-cancel')).state_db_seen_id).toBe(maxId('web-cancel'))
  })

  it('answers /health while a slow state.db holds a turn', async () => {
    await seeded('web-slow-turn', 1300)
    await expectHealthyWhileSlow(s, () => turn('web-slow-turn', 'slow'), [200, 'slow answered'])
  }, 60_000)

  it.each(['', '&msg_limit=2'])('answers /health while a slow state.db holds the session detail%s', async (query) => {
    const sid = `web-slow-detail${query ? '-paged' : ''}`
    await seeded(sid, 1400)
    const path = `/api/session?session_id=${sid}${query}`
    const expected = await contents(path)
    // A new state.db signature misses the page-tail cache, so the slow request reads again.
    utimesSync(dbPath, new Date(), new Date())
    await expectHealthyWhileSlow(s, () => contents(path), expected)
  }, 60_000)

  it('settles a Stop that lands during the starting read as a turn whose read failed', async () => {
    await seeded('web-stop', 1500)
    const begin = s.deps.sessions.beginStateDbTurn.bind(s.deps.sessions)
    let reading = false
    const read = vi.spyOn(s.deps.sessions, 'beginStateDbTurn').mockImplementation((session) => { reading = true; return begin(session) })
    const settle = vi.spyOn(s.deps.sessions, 'settleStateDb')
    try {
      setStateDbReadDelayForTests(1500)
      const streamId = String(((await (await post('/api/chat/start', { session_id: 'web-stop', message: 'halt' })).json()) as Json).stream_id)
      const deadline = Date.now() + 10_000
      while (!reading && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      await s.get(`/api/chat/cancel?stream_id=${streamId}`)
      setStateDbReadDelayForTests(0)
      await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
      const settled = settle.mock.calls.filter(([session]) => session.session_id === 'web-stop')
      expect(settled.length).toBeGreaterThan(0)
      expect(settled.map(([, t]) => [t.startId ?? null, t.startGeneration ?? null])).toEqual(settled.map(() => [null, null]))
    } finally {
      setStateDbReadDelayForTests(0)
      read.mockRestore()
      settle.mockRestore()
    }
    const rows = (all: unknown[]): unknown[] => all.filter((c) => c !== '')
    const expected = ['hi', 'hi', 'CLI later', 'halt']
    expect(rows(await contents('/api/session?session_id=web-stop'))).toEqual(expected)
    // A reload from disk shows each row once too.
    s.deps.sessionStore.sessions.delete('web-stop')
    expect(rows(await contents('/api/session?session_id=web-stop'))).toEqual(expected)
    expect((await s.deps.sessionStore.get('web-stop')).state_db_seen_id).toBe(maxId('web-stop'))
  }, 30_000)

  it('lets a Stop that lands during the settlement read take the cancel path', async () => {
    await seeded('web-late-stop', 1600)
    sidecar.respond('chat.start', (params) => {
      commit('web-late-stop', [['user', 'late', 9000], ['assistant', 'late answered', 9001]])
      return completedTurn([...params.conversation_history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'late answered' }])
    })
    const settlementRead = s.deps.sessions.settlementRead.bind(s.deps.sessions)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding = false
    // The turn's settlement read is held until the Stop has settled.
    const read = vi.spyOn(s.deps.sessions, 'settlementRead').mockImplementationOnce(async (session) => { holding = true; await held; return settlementRead(session) })
    try {
      const streamId = String(((await (await post('/api/chat/start', { session_id: 'web-late-stop', message: 'late' })).json()) as Json).stream_id)
      const deadline = Date.now() + 10_000
      while (!holding && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      await s.get(`/api/chat/cancel?stream_id=${streamId}`)
      release()
      const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
      expect(frames.map((f) => f.event)).not.toContain('done')
    } finally {
      release()
      read.mockRestore()
    }
    const stored = await s.deps.sessionStore.get('web-late-stop')
    expect(stored.messages.filter((m) => m.content === 'late answered')).toEqual([])
    expect(stored.messages.at(-1)?._terminal_state).toBe('cancelled')
  }, 30_000)

  it.each(['', '&msg_limit=50'])('builds a detail%s from the session as it is after its transcript read', async (query) => {
    const sid = `web-settling${query ? '-paged' : ''}`
    await seeded(sid, 1700)
    let finish = (): void => undefined
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'settling answered' } })
      finish = () => {
        commit(sid, [['user', 'settle', 9000], ['assistant', 'settling answered', 9001]])
        resolve(completedTurn([...params.conversation_history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'settling answered' }]))
      }
    }))
    const streamId = String(((await (await post('/api/chat/start', { session_id: sid, message: 'settle' })).json()) as Json).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    const stateDbRows = s.deps.sessions.stateDbRows.bind(s.deps.sessions)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding = false
    // The detail's transcript read is held while the turn settles.
    const read = vi.spyOn(s.deps.sessions, 'stateDbRows').mockImplementationOnce(async (session) => { holding = true; await held; return stateDbRows(session) })
    try {
      const detail = contents(`/api/session?session_id=${sid}${query}`)
      const deadline = Date.now() + 10_000
      while (!holding && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      finish()
      await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
      release()
      expect((await detail).filter((c) => c === 'settle' || c === 'settling answered')).toEqual(['settle', 'settling answered'])
    } finally {
      release()
      read.mockRestore()
    }
  }, 30_000)
})
