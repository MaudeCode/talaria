/**
 * TAL-785: a damaged state.db reports degraded Agent session storage instead of an empty history with an upgrade hint;
 * a readable database without the `source` column keeps the upgrade path.
 */
import { chmodSync, closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { stateDbSessionRead } from './state-db.js'

type Json = Record<string, unknown>

/** A healthy v31-shaped state.db with enough rows that the sessions table spans pages past the first. */
function writeStateDb(path: string, opts: { sourceColumn?: boolean } = {}): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, ${opts.sourceColumn === false ? '' : 'source TEXT NOT NULL, '}started_at REAL NOT NULL, title TEXT, model TEXT, message_count INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content)`)
  for (let i = 0; i < 100; i += 1) {
    const id = `cli-${String(i)}`
    if (opts.sourceColumn === false) db.prepare('INSERT INTO sessions (id, started_at, title, message_count) VALUES (?, ?, ?, 2)').run(id, 1000 + i, `Chat ${String(i)} ${'x'.repeat(80)}`)
    else db.prepare('INSERT INTO sessions (id, source, started_at, title, message_count) VALUES (?, ?, ?, ?, 2)').run(id, 'cli', 1000 + i, `Chat ${String(i)} ${'x'.repeat(80)}`)
    for (const [role, ts] of [['user', 1000.1 + i], ['assistant', 1000.2 + i]] as const) {
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(id, role, `${role} says`, ts)
      db.prepare('INSERT INTO messages_fts (content) VALUES (?)').run(`${role} says`)
    }
  }
  db.close()
}

/** Overwrite `[from, to)` of the file with junk, as a torn write or disk fault would. */
function smash(path: string, from: number, to = statSync(path).size): void {
  const fd = openSync(path, 'r+')
  try { writeSync(fd, Buffer.alloc(to - from, 0xa5), 0, to - from, from) } finally { closeSync(fd) }
}

describe('degraded Agent session storage (TAL-785)', () => {
  let s: TestServer
  let dbPath: string
  beforeAll(async () => {
    s = await bootTestServer()
    dbPath = join(s.state, 'state.db')
    await s.deps.settings.save({ show_cli_sessions: true })
  })
  afterAll(async () => { s.deps.gatewayWatchers.stopAll(); await s.close() })
  beforeEach(() => { s.deps.cliSessions.invalidate(); s.logs.length = 0 })

  const list = async (): Promise<Json> => (await (await s.get('/api/sessions')).json()) as Json
  const upgradeHint = (text: unknown): boolean => /upgrade hermes-agent/i.test(String(text))

  it('reports healthy storage as ok and lists its sessions', async () => {
    writeStateDb(dbPath)
    const body = await list()
    expect(body.agent_storage).toEqual({ state: 'ok', reason: null })
    expect((body.sessions as Json[]).some((r) => r.session_id === 'cli-99')).toBe(true)
  })

  it('reports a database whose schema pages are damaged as corrupt, with no upgrade hint', async () => {
    writeStateDb(dbPath)
    smash(dbPath, 100, 4096)
    const body = await list()
    expect(s.logs.filter(upgradeHint)).toEqual([])
    expect(body.agent_storage).toMatchObject({ state: 'corrupt', reason: expect.stringMatching(/malformed/) as unknown })
    expect(upgradeHint((body.agent_storage as Json).reason)).toBe(false)
  })

  it('reports a database whose data pages are damaged as corrupt', async () => {
    writeStateDb(dbPath)
    smash(dbPath, 4096)
    expect((await list()).agent_storage).toMatchObject({ state: 'corrupt', reason: expect.stringMatching(/malformed/) as unknown })
  })

  it('reports damage that only a background kind\'s read reaches as corrupt', async () => {
    writeStateDb(dbPath)
    const db = new DatabaseSync(dbPath)
    db.prepare("INSERT INTO sessions (id, source, started_at, title, message_count) VALUES ('cron_job_1', 'cron', 5000, 'Nightly', 2)").run()
    for (const ts of [5000.1, 5000.2]) db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('cron_job_1', 'assistant', ?, ?)").run(`CRONPAGE${'c'.repeat(3900)}`, ts)
    db.exec('CREATE INDEX idx_messages_session ON messages(session_id, timestamp)')
    db.close()
    // A row this size fills a page alone, so only the cron read reaches the damaged one.
    const at = readFileSync(dbPath).lastIndexOf('CRONPAGE')
    smash(dbPath, Math.floor(at / 4096) * 4096, Math.floor(at / 4096) * 4096 + 4096)
    const body = await list()
    expect((body.sessions as Json[]).some((r) => r.session_id === 'cli-99')).toBe(true)
    expect(body.agent_storage).toMatchObject({ state: 'corrupt', reason: expect.stringMatching(/malformed/) as unknown })
  })

  it('reports a file that is not a database as corrupt', async () => {
    writeStateDb(dbPath)
    smash(dbPath, 0, 100)
    expect((await list()).agent_storage).toMatchObject({ state: 'corrupt', reason: expect.stringMatching(/not a database/) as unknown })
  })

  it('reports a database it cannot read for another reason as unavailable, never ok', async ({ onTestFinished }) => {
    writeStateDb(dbPath)
    chmodSync(dbPath, 0o000)
    onTestFinished(() => { chmodSync(dbPath, 0o644) })
    const body = await list()
    expect(body.agent_storage).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/could not be read/) as unknown })
    expect(upgradeHint((body.agent_storage as Json).reason)).toBe(false)
  })

  it('keeps storage ok when only the full-text index is damaged', async () => {
    writeStateDb(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'messages_fts_data'").get() as { rootpage: number }
    const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number }
    db.close()
    smash(dbPath, (rootpage - 1) * pageSize, rootpage * pageSize)
    const body = await list()
    expect(body.agent_storage).toEqual({ state: 'ok', reason: null })
    expect((body.sessions as Json[]).some((r) => r.session_id === 'cli-99')).toBe(true)
  })

  it('keeps the upgrade hint for a readable database from an older hermes-agent', async () => {
    writeStateDb(dbPath, { sourceColumn: false })
    const body = await list()
    expect(body.agent_storage).toMatchObject({ state: 'outdated' })
    expect(upgradeHint((body.agent_storage as Json).reason)).toBe(true)
  })

  it('answers a corrupt session read with the same reason', () => {
    writeStateDb(dbPath)
    expect(stateDbSessionRead(dbPath, 'cli-1')).toMatchObject({ ok: true, reason: null })
    smash(dbPath, 100, 4096)
    expect(stateDbSessionRead(dbPath, 'cli-1')).toMatchObject({ rows: [], ok: false, reason: expect.stringMatching(/malformed/) as unknown })
  })
})
