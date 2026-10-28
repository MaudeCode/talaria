import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'
import { CliSessionSource } from './cli-sessions.js'
import { Session } from './session.js'
import type { StateDbWorkerRequest } from './state-db.js'
import { GatewayWatcher } from './gateway-watcher.js'

describe('batched sidebar reads and targeted lookup cache', () => {
  let server: TestServer
  let home: string
  let path: string
  let now: number
  let source: CliSessionSource
  const calls = vi.spyOn(Worker.prototype, 'postMessage')
  const ops = (): string[] => calls.mock.calls.map(([request]) => (request as StateDbWorkerRequest).op)
  beforeEach(async () => {
    server = await bootTestServer()
    home = mkdtempSync(join(tmpdir(), 'cli-batches-'))
    path = join(home, 'state.db')
    const db = openStateDb(path)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, title TEXT, model TEXT, message_count INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, timestamp REAL);
      CREATE INDEX idx_messages_session ON messages(session_id, timestamp)`)
    for (const [i, kind] of ['cli', 'webui', 'cron', 'webhook', 'kanban'].entries()) {
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, 1)').run(kind, kind, i, kind)
      db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(i, kind, 'user', i)
    }
    db.close()
    // Cache-reuse cases begin with a settled database; writes below remain fresh.
    utimesSync(path, 1, 1)
    now = 100
    source = new CliSessionSource({ store: server.deps.sessionStore, profileHome: () => home, lastWorkspace: () => home,
      profilesMatch: server.deps.profilesMatch, now: () => now, log: () => undefined })
    calls.mockClear()
  })
  afterEach(async () => { await server.close(); rmSync(home, { recursive: true, force: true }) })

  it('crosses the worker boundary once for the four sidebar queries and storage', async () => {
    const read = await source.read('default')
    expect(read.rows.map((r) => r.session_id)).toEqual(['webui', 'cli', 'cron', 'webhook', 'kanban'])
    expect(read.storage).toEqual({ state: 'ok', reason: null })
    expect(ops()).toEqual(['rowBatches'])
  })

  it('reuses targeted lookups with the same sorted IDs until TTL, database or index changes', async () => {
    const first = await source.read('default', { sessionIds: ['cli', 'cron'], sidebarRows: true })
    calls.mockClear()
    expect(await source.read('default', { sessionIds: ['cron', 'cli'], sidebarRows: true })).toEqual(first)
    expect(ops()).toEqual([])
    first.rows[0]!.title = 'mutated caller copy'
    expect((await source.read('default', { sessionIds: ['cli', 'cron'], sidebarRows: true })).rows[0]?.title).toBe('cron')
    const changes: (() => void | Promise<void>)[] = [
      () => { now += 5 },
      () => { utimesSync(path, new Date(200_000), new Date(200_000)) },
      async () => { await server.deps.sessionStore.save(new Session({ session_id: 'index-change', title: 'Changed' }, { workspace: home, model: null })) },
      () => { source.invalidate() },
    ]
    for (const change of changes) {
      calls.mockClear()
      await change()
      await source.read('default', { sessionIds: ['cli', 'cron'], sidebarRows: true })
      expect(ops()).toEqual(['rowBatches'])
    }
  })

  it('invalidates a targeted snapshot on a WAL-only change', async () => {
    const db = openStateDb(path)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      await source.read('default', { sessionIds: ['cli'] })
      calls.mockClear()
      db.exec("UPDATE sessions SET title = 'New WAL title' WHERE id = 'cli'")
      expect((await source.read('default', { sessionIds: ['cli'] })).rows[0]?.title).toBe('New WAL title')
      expect(ops()).toEqual(['rowBatches'])
    } finally { db.close() }
  })

  it.each([['coarse', 6, false], ['coarse', 0, false], ['coarse', 6, true], ['coarse', 0, true], ['ordinary', 6, false]] as const)('publishes same-size WAL activity with %s timestamps, cache advance %s and future tick %s', async (timestamps, advance, future) => {
    const db = openStateDb(path)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      ALTER TABLE sessions ADD COLUMN last_activity_at REAL;
      CREATE INDEX idx_sessions_effective_activity ON sessions(COALESCE(last_activity_at, started_at) DESC, started_at DESC, id DESC)`)
    // Exercise the current whole-second tick and clocks ahead of the sampling host.
    const tick = Math.floor(Date.now() / 1000) + (future ? 86400 : 0)
    const watcher = new GatewayWatcher('default', home, { rows: (profile) => source.read(profile), now: () => now, log: () => undefined })
    const sub = watcher.subscribe()
    const signatures: string[] = []
    try {
      for (const activity of [110, 111, 112, 113]) {
        db.exec('PRAGMA wal_checkpoint(RESTART)')
        db.prepare("UPDATE sessions SET title = ?, last_activity_at = ? WHERE id = 'cli'").run(`activity-${String(activity)}`, activity)
        if (timestamps === 'coarse') for (const file of [path, `${path}-wal`]) utimesSync(file, tick, tick)
        signatures.push([path, `${path}-wal`].map((file) => { const st = statSync(file, { bigint: true }); return `${st.size}:${st.mtimeNs}` }).join('|'))
        now += advance
        await watcher.pollOnce()
        const event = await sub.next(AbortSignal.timeout(100))
        expect(event?.sessions.find((row) => row.session_id === 'cli'), `committed activity ${String(activity)}`).toMatchObject({ title: `activity-${String(activity)}`, updated_at: activity })
      }
      if (timestamps === 'coarse') expect(signatures[3]).toBe(signatures[2])
      expect(ops().filter((op) => op === 'rowBatches')).toHaveLength(4)
      // Once settled, unchanged polls stay cheap, and parity still refreshes the rows.
      for (const file of [path, `${path}-wal`]) utimesSync(file, 1, 1)
      await watcher.pollOnce()
      calls.mockClear()
      for (let i = 0; i < 10; i++) { now += 5; expect(await watcher.pollOnce()).toBe(false) }
      expect(ops().filter((op) => op === 'rowBatches')).toHaveLength(0)
      now += 300
      expect(await watcher.pollOnce()).toBe(true)
      expect(ops().filter((op) => op === 'rowBatches')).toHaveLength(1)
      expect(await sub.next(AbortSignal.timeout(20))).toBeNull()
    } finally { sub.close(); watcher.stop(); db.close() }
  })

  it('publishes database disappearance after an uncertain signature', async () => {
    const tick = Math.floor(Date.now() / 1000) + 86400
    utimesSync(path, tick, tick)
    const watcher = new GatewayWatcher('default', home, { rows: (profile) => source.read(profile), now: () => now, log: () => undefined })
    const sub = watcher.subscribe()
    try {
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next())?.sessions.length).toBeGreaterThan(0)
      rmSync(path)
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next())?.sessions).toEqual([])
    } finally { sub.close(); watcher.stop() }
  })

  it('bounds retained targeted snapshots while keeping recent ones cached', async () => {
    for (let i = 0; i <= 200; i += 1) await source.read('default', { sessionIds: [`absent-${String(i)}`] })
    calls.mockClear()
    await source.read('default', { sessionIds: ['absent-200'] })
    expect(ops()).toEqual([])
    await source.read('default', { sessionIds: ['absent-0'] })
    expect(ops()).toEqual(['rowBatches'])
  })

  it('isolates malformed background ownership metadata from healthy sidebar windows', async () => {
    const db = openStateDb(path)
    try {
      db.exec('CREATE TABLE worker_executions (session_id TEXT, lineage_json TEXT)')
      db.prepare('INSERT INTO worker_executions VALUES (?, ?)').run('cron', JSON.stringify({ broken: true }))
    } finally { db.close() }
    const read = await source.read('default')
    expect(read.rows.map((row) => row.session_id)).toEqual(['webui', 'cli', 'webhook', 'kanban'])
    expect(read.storage.state).toBe('unavailable')
    expect(ops()).toEqual(['rowBatches'])
  })

  it('separates lookup flags, IDs, profile and source filter from a cached listing', async () => {
    expect((await source.read('default', { sessionIds: ['webui'] })).rows).toEqual([])
    expect((await source.read('default', { sessionIds: ['webui'], sidebarRows: true })).rows).toHaveLength(1)
    calls.mockClear()
    for (const opts of [{ sessionIds: [] }, { sessionIds: ['cli'] }, { sessionIds: ['webui'], keepEmpty: true }, { sourceFilter: 'cron' }, {}]) await source.read('default', opts)
    await source.read('other', { sessionIds: ['webui'] })
    expect(ops()).toEqual(Array<string>(6).fill('rowBatches'))
  })
})
