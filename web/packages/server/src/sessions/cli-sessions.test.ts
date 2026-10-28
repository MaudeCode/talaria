import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'
import { CliSessionSource } from './cli-sessions.js'
import { Session } from './session.js'
import type { StateDbWorkerRequest } from './state-db.js'

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
