import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { Message } from '../session.js'
import { runDocumentBackendConformance, runJournalBackendConformance, runSessionBackendConformance } from './conformance.js'
import { sessionSearchTerms } from './search-text.js'
import { SESSION_SQL, SqliteStorage } from './sqlite.js'
import { SCHEMA_VERSION } from './sqlite-db.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'talaria-sqlite-'))
  const storage = new SqliteStorage({ path: join(dir, 'talaria.db'), sessionDir: join(dir, 'sessions'), env: { HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT: '0' }, stampingSince: () => 0 })
  const db = storage.db.db
  const exec = db.exec.bind(db)
  let failCommit = false
  // Throws where COMMIT would run: everything the write staged is inside the open transaction.
  db.exec = (sql: string) => { if (failCommit && sql === 'COMMIT') { failCommit = false; throw new Error('injected publication failure') } exec(sql) }
  return { dir, storage, failNextWrite: () => { failCommit = true }, cleanup: async () => { await storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

runSessionBackendConformance('SQLite', () => { const test = fixture(); return { storage: test.storage, failNextWrite: test.failNextWrite, cleanup: () => { rmSync(test.dir, { recursive: true, force: true }) } } })
runDocumentBackendConformance('SQLite', () => { const test = fixture(); return { backend: test.storage.documents, failNextWrite: test.failNextWrite, cleanup: test.cleanup } })
runJournalBackendConformance('SQLite', () => { const test = fixture(); return { backend: test.storage.journals, cleanup: test.cleanup } })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
function open() { const test = fixture(); cleanups.push(test.cleanup); return test }
const rows = (count: number, text = (n: number) => `message ${String(n)}`): Message[] => Array.from({ length: count }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: text(n) }))
const doc = (sid: string) => ({ session_id: sid, title: 'Synthetic', updated_at: 100 })

/** Row writes per table, counted by temporary triggers on the backend's own connection. */
function countWrites(db: DatabaseSync): () => Record<string, number> {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS writes (tbl TEXT NOT NULL, op TEXT NOT NULL)')
  for (const table of ['sessions', 'messages', 'shrink_backups']) for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS count_${table}_${op} AFTER ${op} ON main.${table} BEGIN INSERT INTO writes VALUES ('${table}', '${op.toLowerCase()}'); END`)
  }
  db.exec('DELETE FROM writes')
  return () => Object.fromEntries((db.prepare('SELECT tbl || \'.\' || op AS k, count(*) AS n FROM writes GROUP BY k').all() as { k: string; n: number }[]).map((r) => [r.k, r.n]))
}
const plan = (db: DatabaseSync, sql: string, ...params: (string | number)[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join('\n')

it('reads a 50-row page of a 5,000-message session through the (session_id, idx) index only', async () => {
  const { storage } = open()
  await storage.sessions.write('big', { doc: doc('big'), messages: { kind: 'replace', rows: rows(5000) } }, null)
  const page = await storage.sessions.readMessages('big', { start: 4000, end: 4050 })
  expect(page.map((m) => m.content)).toEqual(rows(5000).slice(4000, 4050).map((m) => m.content))
  const detail = plan(storage.db.db, SESSION_SQL.readMessages, 'big', 4000, 4050)
  expect(detail).toMatch(/SEARCH messages USING INDEX \S+ \(session_id=\? AND idx>\? AND idx<\?\)/)
  expect(detail).not.toMatch(/SCAN/)
})

it('writes only the appended rows, and moves only the tail on a splice', async () => {
  const { storage } = open()
  let revision = await storage.sessions.write('big', { doc: doc('big'), messages: { kind: 'replace', rows: rows(5000) } }, null)
  const writes = countWrites(storage.db.db)
  revision = await storage.sessions.write('big', { doc: doc('big'), messages: { kind: 'append', rows: rows(3, (n) => `appended ${String(n)}`) } }, revision)
  expect(writes()).toEqual({ 'messages.insert': 3, 'sessions.update': 1 })

  storage.db.db.exec('DELETE FROM writes')
  // Replace 2 rows at 4990 with 3: the 11 rows after them each move out of the way and back.
  revision = await storage.sessions.write('big', { doc: doc('big'), messages: { kind: 'splice', from: 4990, deleteCount: 2, rows: rows(3, (n) => `spliced ${String(n)}`) } }, revision)
  expect(writes()).toEqual({ 'messages.delete': 2, 'messages.insert': 3, 'messages.update': 22, 'sessions.update': 1 })
  const all = await storage.sessions.readMessages('big', { start: 0, end: Infinity })
  const expected = [...rows(5000), ...rows(3, (n) => `appended ${String(n)}`)]
  expected.splice(4990, 2, ...rows(3, (n) => `spliced ${String(n)}`))
  expect(all).toEqual(expected)
  expect((await storage.sessions.readDocument('big', { metadataOnly: true }))?.messageCount).toBe(5004)

  storage.db.db.exec('DELETE FROM writes')
  await storage.sessions.write('big', { doc: { ...doc('big'), title: 'Renamed' }, messages: { kind: 'unchanged' } }, revision)
  expect(writes()).toEqual({ 'sessions.update': 1 })
})

it('finds matches across 200 sessions with one statement driven by the trigram index', async () => {
  const { storage } = open()
  const sids = Array.from({ length: 200 }, (_, n) => `session-${String(n)}`)
  for (const sid of sids) await storage.sessions.write(sid, { doc: doc(sid), messages: { kind: 'replace', rows: rows(10, (n) => sid === 'session-77' && n === 4 ? 'The NEEDLE is here' : `filler ${String(n)}`) } }, null)
  const statements = [vi.spyOn(StatementSync.prototype, 'all'), vi.spyOn(StatementSync.prototype, 'get'), vi.spyOn(StatementSync.prototype, 'run'), vi.spyOn(StatementSync.prototype, 'iterate')]
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
  const found = await storage.sessions.searchMessages(sids, sessionSearchTerms('needle'), 5)
  expect(found).toEqual(new Map([['session-77', { idx: 4, text: 'The NEEDLE is here' }]]))
  expect(statements.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(1)
  const sql = prepare.mock.calls.at(-1)?.[0] ?? ''
  vi.restoreAllMocks()
  const detail = plan(storage.db.db, sql, '*needle*', JSON.stringify(sids), 5, 5)
  expect(detail).toMatch(/SCAN s VIRTUAL TABLE INDEX \d+:G/)
  expect(detail).toMatch(/SEARCH m USING INTEGER PRIMARY KEY/)
  expect(detail).not.toMatch(/SCAN m\b/)
  expect(await storage.sessions.searchMessages(sids, sessionSearchTerms('needle'), 4)).toEqual(new Map())
})

it('keeps the previous revision and an agreeing search index when a write throws inside its transaction', async () => {
  const test = open()
  const sessions = test.storage.sessions
  const revision = await sessions.write('session', { doc: doc('session'), messages: { kind: 'replace', rows: rows(3, (n) => `kept ${String(n)}`) } }, null)
  test.failNextWrite()
  await expect(sessions.write('session', { doc: doc('session'), messages: { kind: 'replace', rows: rows(1, () => 'lost words') } }, revision)).rejects.toThrow('injected publication failure')
  expect(await sessions.revision('session')).toBe(revision)
  expect((await sessions.readMessages('session', { start: 0, end: Infinity })).map((m) => m.content)).toEqual(['kept 0', 'kept 1', 'kept 2'])
  expect(await sessions.shrinkBackup.read('session')).toBeNull()
  expect(await sessions.diagnose()).toEqual([])
  expect(await sessions.searchMessages(['session'], ['lost'], 0)).toEqual(new Map())
  expect((await sessions.searchMessages(['session'], ['kept'], 0)).get('session')?.idx).toBe(0)
})

it('reports and rebuilds a search index that disagrees with its messages', async () => {
  const { storage } = open()
  await storage.sessions.write('session', { doc: doc('session'), messages: { kind: 'replace', rows: rows(2) } }, null)
  storage.db.db.exec("INSERT INTO message_search (message_search, rowid, search_text) VALUES ('delete', (SELECT rowid FROM messages LIMIT 1), 'message 0')")
  const [issue, ...rest] = await storage.sessions.diagnose()
  expect(rest).toEqual([])
  expect(issue).toMatchObject({ kind: 'search_index_mismatch', category: 'repairable', recommendation: 'rebuild_search_index' })
  expect(await storage.sessions.repair(issue!)).toBe(true)
  expect(await storage.sessions.diagnose()).toEqual([])
})

it('refuses a database written by a newer schema', async () => {
  const test = open()
  await test.storage.close()
  const db = new DatabaseSync(join(test.dir, 'talaria.db'))
  db.prepare('UPDATE talaria_schema SET version = ?').run(SCHEMA_VERSION + 1)
  db.close()
  expect(() => new SqliteStorage({ path: join(test.dir, 'talaria.db'), sessionDir: test.dir, stampingSince: () => 0 })).toThrow(/newer than this Talaria Web supports/)
})
