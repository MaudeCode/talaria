import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { dropTestSchema, startTestPostgres, TEST_POSTGRES_PASSWORD, testSchema, type TestPostgres } from '../../test/postgres.js'
import type { Message } from '../session.js'
import { RevisionConflict } from './backend.js'
import { runDocumentBackendConformance, runJournalBackendConformance, runSessionBackendConformance } from './conformance.js'
import { PostgresStorage } from './postgres.js'
import { MIGRATIONS, postgresOptions, SCHEMA_VERSION, TRIGRAM_EXTENSION_SQL } from './postgres-db.js'
import { sessionSearchTerms } from './search-text.js'

let postgres: TestPostgres
beforeAll(async () => { postgres = await startTestPostgres() }, 60_000)
afterAll(async () => { await postgres.stop() })

async function fixture(schema = testSchema(), env: Record<string, string | undefined> = { HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT: '0' }, logs: string[] = []) {
  const storage = await PostgresStorage.open({ url: postgres.url, schema, poolMax: 4, sessionDir: '/nonexistent/talaria-sessions', env, stampingSince: () => 0, log: (line) => logs.push(line) })
  let failCommit = false
  // Throws where COMMIT would run: everything the write staged is inside the open transaction.
  const wrapped = new WeakSet<pg.PoolClient>()
  storage.db.pool.on('acquire', (client) => {
    if (wrapped.has(client)) return
    wrapped.add(client)
    client.query = ((...args: unknown[]) => {
      if (failCommit && args[0] === 'COMMIT') { failCommit = false; return Promise.reject(new Error('injected publication failure')) }
      // Through the prototype, so a statement count spying on it still sees every query.
      return (pg.Client.prototype.query as (...a: unknown[]) => Promise<unknown>).apply(client, args)
    }) as never
  })
  return { schema, storage, failNextWrite: () => { failCommit = true }, cleanup: async () => { await storage.close(); await dropTestSchema(postgres.url, schema) } }
}

runSessionBackendConformance('Postgres', async () => { const test = await fixture(); return { storage: test.storage, failNextWrite: test.failNextWrite, cleanup: () => dropTestSchema(postgres.url, test.schema) } })
runDocumentBackendConformance('Postgres', async () => { const test = await fixture(); return { backend: test.storage.documents, failNextWrite: test.failNextWrite, cleanup: test.cleanup } })
runJournalBackendConformance('Postgres', async () => { const test = await fixture(); return { backend: test.storage.journals, cleanup: test.cleanup } })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
async function open(schema?: string) { const test = await fixture(schema); cleanups.push(test.cleanup); return test }
const rows = (count: number, text = (n: number) => `message ${String(n)}`): Message[] => Array.from({ length: count }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: text(n) }))
const doc = (sid: string) => ({ session_id: sid, title: 'Synthetic', updated_at: 100 })

it('finds matches across 200 sessions with one statement that the trigram index serves', async () => {
  const { storage } = await open()
  const sids = Array.from({ length: 200 }, (_, n) => `session-${String(n)}`)
  for (const sid of sids) await storage.sessions.write(sid, { doc: doc(sid), messages: { kind: 'replace', rows: rows(20, (n) => sid === 'session-77' && n === 4 ? 'The NEEDLE is here' : `filler ${String(n)} of ${sid}: ${'an ordinary synthetic turn about a commonplace topic. '.repeat(12)}`) } }, null)
  // As autovacuum would: GIN keeps fresh rows in a pending list the planner prices as a full scan until it is flushed.
  await storage.db.run(`VACUUM ANALYZE ${storage.db.s}messages`)
  const queries = vi.spyOn(pg.Client.prototype, 'query')
  // The whole history: the trigram index, not the (session_id, idx) key, is what narrows it.
  const found = await storage.sessions.searchMessages(sids, sessionSearchTerms('needle'), 0)
  expect(found).toEqual(new Map([['session-77', { idx: 4, text: 'The NEEDLE is here' }]]))
  expect(queries).toHaveBeenCalledTimes(1)
  const [sql, params] = queries.mock.calls[0] as unknown as [string, unknown[]]
  vi.restoreAllMocks()
  const plan = (await storage.db.rows<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, ...params as string[])).map((row) => row['QUERY PLAN']).join('\n')
  expect(plan).toMatch(/Bitmap Index Scan on messages_search[^\n]*\n\s+Index Cond: \(search_text ~~ '%needle%'::text\)/)
  expect(plan).not.toMatch(/Seq Scan/)
  expect(await storage.sessions.searchMessages(sids, sessionSearchTerms('needle'), 5)).toEqual(found)
  expect(await storage.sessions.searchMessages(sids, sessionSearchTerms('needle'), 4)).toEqual(new Map())
})

it('matches LIKE wildcards and backslashes in a term only literally', async () => {
  const { storage } = await open()
  const texts: Record<string, string> = { percent: 'growth of 100% today', underscore: 'call snake_case here', backslash: 'path C:\\temp\\file', decoy: 'growth of 1000 today, snakeXcase, C:/temp/file' }
  for (const [sid, text] of Object.entries(texts)) await storage.sessions.write(sid, { doc: doc(sid), messages: { kind: 'replace', rows: [{ role: 'user', content: text }] } }, null)
  const search = async (query: string) => [...(await storage.sessions.searchMessages(Object.keys(texts), sessionSearchTerms(query), 0)).keys()].sort()
  expect(await search('100%')).toEqual(['percent'])
  expect(await search('0%')).toEqual(['percent'])
  expect(await search('%')).toEqual(['percent'])
  expect(await search('snake_case')).toEqual(['underscore'])
  expect(await search('_')).toEqual(['underscore'])
  expect(await search('c:\\temp')).toEqual(['backslash'])
  expect(await search('\\')).toEqual(['backslash'])
  expect(await search('%%')).toEqual([])
})

it('raises RevisionConflict for a stale writer on a second pool instead of losing its update', async () => {
  const first = await open()
  const second = await open(first.schema)
  const created = await first.storage.sessions.write('shared', { doc: doc('shared'), messages: { kind: 'replace', rows: rows(2) } }, null)
  const newer = await second.storage.sessions.write('shared', { doc: doc('shared'), messages: { kind: 'append', rows: rows(1, () => 'from the second pool') } }, created)
  await expect(first.storage.sessions.write('shared', { doc: doc('shared'), messages: { kind: 'append', rows: rows(1, () => 'stale') } }, created)).rejects.toBeInstanceOf(RevisionConflict)
  await expect(first.storage.sessions.write('shared', { doc: doc('shared'), messages: { kind: 'replace', rows: [] } }, null)).rejects.toBeInstanceOf(RevisionConflict)
  expect(await first.storage.sessions.revision('shared')).toBe(newer)
  expect((await first.storage.sessions.readMessages('shared', { start: 0, end: Infinity })).map((m) => m.content)).toEqual(['message 0', 'message 1', 'from the second pool'])

  // Racing writers from both pools on the same base: exactly one commits.
  const results = await Promise.allSettled([first, second].map((test, n) => test.storage.sessions.write('shared', { doc: doc('shared'), messages: { kind: 'append', rows: rows(1, () => `racer ${String(n)}`) } }, newer)))
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(RevisionConflict)
  expect(await first.storage.sessions.readMessages('shared', { start: 3, end: Infinity })).toHaveLength(1)

  const document = await first.storage.documents.put('drafts', 'shared', { text: 'first' }, null)
  await second.storage.documents.put('drafts', 'shared', { text: 'second' }, document)
  await expect(first.storage.documents.put('drafts', 'shared', { text: 'stale' }, document)).rejects.toBeInstanceOf(RevisionConflict)
  expect((await first.storage.documents.get('drafts', 'shared'))?.value).toEqual({ text: 'second' })
})

it('applies each migration step exactly once when instances start together', async () => {
  const schema = testSchema()
  const queries = vi.spyOn(pg.Client.prototype, 'query')
  const tests = await Promise.all([fixture(schema), fixture(schema), fixture(schema)])
  cleanups.push(async () => { for (const test of tests) await test.storage.close(); await dropTestSchema(postgres.url, schema) })
  const texts = queries.mock.calls.map((call) => call[0] as unknown)
  for (const step of MIGRATIONS) expect(texts.filter((text) => typeof text === 'string' && text.startsWith(step.slice(0, 40).replaceAll('{s}', `"${schema}"`)))).toHaveLength(1)
  expect(await tests[0].storage.db.rows(`SELECT version FROM ${tests[0].storage.db.s}talaria_schema`)).toEqual([{ version: SCHEMA_VERSION }])
  expect(await tests[2].storage.sessions.diagnose()).toEqual([])
})

it('refuses a schema written by a newer release', async () => {
  const test = await open()
  await test.storage.db.run(`UPDATE ${test.storage.db.s}talaria_schema SET version = $1`, SCHEMA_VERSION + 1)
  await expect(fixture(test.schema)).rejects.toThrow(/newer than this Talaria Web supports/)
})

it('reports a missing search index and rebuilds it', async () => {
  const { storage } = await open()
  await storage.sessions.write('session', { doc: doc('session'), messages: { kind: 'replace', rows: rows(2) } }, null)
  await storage.db.run(`DROP INDEX ${storage.db.s}messages_search`)
  const [issue, ...rest] = await storage.sessions.diagnose()
  expect(rest).toEqual([])
  expect(issue).toMatchObject({ kind: 'search_index_mismatch', category: 'repairable', recommendation: 'rebuild_search_index' })
  expect(await storage.sessions.repair(issue!)).toBe(true)
  expect(await storage.sessions.diagnose()).toEqual([])
  expect((await storage.sessions.searchMessages(['session'], sessionSearchTerms('message 1'), 0)).get('session')?.idx).toBe(1)
})

it('never puts the connection password in an error or log line, including a failed connection', async () => {
  const closed = new PGLiteSocketServer({ db: await PGlite.create(), port: 0 })
  await closed.start()
  const port = closed.getServerConn().split(':')[1]
  await closed.stop()
  const secret = 'p@ss:w0rd/with%40escapes'
  const url = `postgres://talaria:${encodeURIComponent(secret)}@127.0.0.1:${port ?? ''}/postgres`
  const logs: string[] = []
  const failure = await PostgresStorage.open({ url, schema: 'talaria', poolMax: 1, sessionDir: '/nonexistent', stampingSince: () => 0, log: (line) => logs.push(line) }).then(() => null, (error: unknown) => error as Error)
  if (!failure) throw new Error('an unreachable database must fail to open')
  const text = `${failure.message}\n${failure.stack ?? ''}\n${String((failure.cause as Error | undefined)?.message)}\n${logs.join('\n')}`
  expect(text).toMatch(/could not start/)
  expect(text).toContain('127.0.0.1')
  for (const leaked of [secret, encodeURIComponent(secret), 'w0rd']) expect(text).not.toContain(leaked)

  // A pooled client's later error reaches the log scrubbed too.
  const test = await fixture(testSchema(), {}, logs)
  cleanups.push(test.cleanup)
  test.storage.db.pool.emit('error', new Error(`connection to ${postgres.url} reset`), {})
  expect(logs.at(-1)).toMatch(/Postgres connection error/)
  expect(logs.join('\n')).not.toContain(TEST_POSTGRES_PASSWORD)
})

it('names the statement an administrator runs when the role may not create pg_trgm', async () => {
  const db = await PGlite.create({ extensions: { pg_trgm } })
  await db.exec(`CREATE ROLE limited LOGIN; REVOKE CREATE ON DATABASE postgres FROM PUBLIC; CREATE SCHEMA talaria AUTHORIZATION limited; SET ROLE limited`)
  const server = new PGLiteSocketServer({ db, port: 0, maxConnections: 4 })
  await server.start()
  try {
    const url = `postgres://limited:${TEST_POSTGRES_PASSWORD}@${server.getServerConn()}/postgres`
    await expect(PostgresStorage.open({ url, schema: 'talaria', poolMax: 1, sessionDir: '/nonexistent', stampingSince: () => 0 })).rejects.toThrow(`have a database administrator run: ${TRIGRAM_EXTENSION_SQL};`)
  } finally { await server.stop(); await db.close() }
})

it('reads the connection settings, refusing a missing URL, an unsafe schema and a bad pool size', () => {
  expect(postgresOptions({ TALARIA_STORAGE_URL: ' postgres://host/db ' })).toEqual({ url: 'postgres://host/db', schema: 'talaria', poolMax: 10 })
  expect(postgresOptions({ TALARIA_STORAGE_URL: 'postgres://host/db', TALARIA_STORAGE_SCHEMA: 'web_2', TALARIA_STORAGE_POOL_MAX: '3' })).toEqual({ url: 'postgres://host/db', schema: 'web_2', poolMax: 3 })
  expect(() => postgresOptions({})).toThrow('TALARIA_STORAGE=postgres needs TALARIA_STORAGE_URL')
  for (const schema of ['Talaria', 'a"b', 'public; drop']) expect(() => postgresOptions({ TALARIA_STORAGE_URL: 'postgres://host/db', TALARIA_STORAGE_SCHEMA: schema })).toThrow('Invalid TALARIA_STORAGE_SCHEMA')
  for (const pool of ['0', '2.5', 'ten']) expect(() => postgresOptions({ TALARIA_STORAGE_URL: 'postgres://host/db', TALARIA_STORAGE_POOL_MAX: pool })).toThrow('Invalid TALARIA_STORAGE_POOL_MAX')
})
