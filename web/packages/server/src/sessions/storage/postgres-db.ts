import pg from 'pg'
import { redactSensitive } from '../../redact.js'

/** `TALARIA_STORAGE=postgres` settings, from `TALARIA_STORAGE_URL`, `TALARIA_STORAGE_SCHEMA` and `TALARIA_STORAGE_POOL_MAX`. */
export interface PostgresOptions { url: string; schema: string; poolMax: number }

export function postgresOptions(env: Record<string, string | undefined>): PostgresOptions {
  const url = (env.TALARIA_STORAGE_URL ?? '').trim()
  if (!url) throw new Error('TALARIA_STORAGE=postgres needs TALARIA_STORAGE_URL, a postgres:// connection string')
  const schema = (env.TALARIA_STORAGE_SCHEMA ?? '').trim() || 'talaria'
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid TALARIA_STORAGE_SCHEMA=${JSON.stringify(schema)}; use lowercase letters, digits and underscores`)
  const rawPool = (env.TALARIA_STORAGE_POOL_MAX ?? '').trim()
  const poolMax = rawPool ? Number(rawPool) : 10
  if (!Number.isInteger(poolMax) || poolMax < 1) throw new Error(`Invalid TALARIA_STORAGE_POOL_MAX=${JSON.stringify(rawPool)}; use a whole number of connections`)
  return { url, schema, poolMax }
}

/**
 * Numbered schema steps, in the SQLite adapter's logical schema; `talaria_schema.version` is how many have been applied.
 * Never edit a released step: append one. `{s}` is the schema and `{trgm}` the schema holding `pg_trgm`.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE {s}.sessions (id text PRIMARY KEY, doc text NOT NULL, message_count integer NOT NULL, revision bigint NOT NULL, updated_at double precision);
   CREATE TABLE {s}.messages (session_id text NOT NULL REFERENCES {s}.sessions(id) ON DELETE CASCADE, idx integer NOT NULL, body text NOT NULL, search_text text NOT NULL, search_exact boolean NOT NULL, PRIMARY KEY (session_id, idx));
   -- search_text is already lowercased the way JavaScript does it, so a case-sensitive LIKE on it is an exact substring
   -- test. search_exact is false when it could not hold that text exactly (a NUL or a lone surrogate).
   CREATE INDEX messages_search ON {s}.messages USING gin (search_text {trgm}.gin_trgm_ops);
   CREATE TABLE {s}.session_tombstones (id text PRIMARY KEY, deleted_at double precision NOT NULL);
   CREATE TABLE {s}.shrink_backups (session_id text PRIMARY KEY REFERENCES {s}.sessions(id) ON DELETE CASCADE, doc text NOT NULL, messages text NOT NULL, saved_at double precision NOT NULL, revision bigint NOT NULL);
   CREATE TABLE {s}.session_index (id integer PRIMARY KEY CHECK (id = 1), entries text NOT NULL, revision bigint NOT NULL);
   CREATE TABLE {s}.documents (ns text NOT NULL, key text NOT NULL, value text NOT NULL, revision bigint NOT NULL, PRIMARY KEY (ns, key));
   CREATE TABLE {s}.journal_rows (session_id text NOT NULL, stream_id text NOT NULL, seq integer NOT NULL, row text NOT NULL, written_at double precision NOT NULL, PRIMARY KEY (session_id, stream_id, seq));
   CREATE INDEX journal_rows_stream ON {s}.journal_rows (stream_id);
   CREATE TABLE {s}.journal_summaries (session_id text NOT NULL, stream_id text NOT NULL, summary text NOT NULL, PRIMARY KEY (session_id, stream_id));
   CREATE INDEX journal_summaries_stream ON {s}.journal_summaries (stream_id);
   CREATE TABLE {s}.journal_archives (session_id text NOT NULL, stream_id text NOT NULL, rows bytea NOT NULL, bytes bigint NOT NULL, last_seq integer NOT NULL, archived_at double precision NOT NULL, PRIMARY KEY (session_id, stream_id));
   CREATE INDEX journal_archives_stream ON {s}.journal_archives (stream_id);`,
]
export const SCHEMA_VERSION = MIGRATIONS.length
/** One lock for every schema: `CREATE EXTENSION` is database-wide, so two schemas migrating at once must not race it. */
const MIGRATION_LOCK = 'talaria-storage-migrate'
export const TRIGRAM_EXTENSION_SQL = 'CREATE EXTENSION IF NOT EXISTS pg_trgm'

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`

/** A new revision, past the previous one and the clock in milliseconds, so a deleted and recreated item never reuses one. */
export const NEXT_REVISION = (previous: string): string => `GREATEST(${previous} + 1, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)`

export type Param = string | number | boolean | null | Buffer | readonly (string | number | boolean)[]
/** Queries on one connection: the pool, or a transaction's client. */
export interface Queries {
  rows<T>(sql: string, ...params: Param[]): Promise<T[]>
  row<T>(sql: string, ...params: Param[]): Promise<T | undefined>
  /** Rows changed. */
  run(sql: string, ...params: Param[]): Promise<number>
}
const on = (client: pg.Pool | pg.PoolClient): Queries => ({
  rows: async <T>(sql: string, ...params: Param[]) => (await client.query(sql, params)).rows as T[],
  row: async <T>(sql: string, ...params: Param[]) => (await client.query(sql, params)).rows[0] as T | undefined,
  run: async (sql: string, ...params: Param[]) => (await client.query(sql, params)).rowCount ?? 0,
})

/**
 * The pool a Postgres store shares. Every table is schema-qualified (`db.s`), never found through `search_path`, so a
 * store sees only its own schema whatever the role's defaults. Every write is one transaction on one pooled client.
 */
export class PgDb implements Queries {
  /** The quoted schema and a dot, prefixed to every table name. */
  readonly s: string
  private closed = false
  private readonly queries: Queries
  private constructor(readonly pool: pg.Pool, readonly schema: string, private readonly scrub: (text: string) => string) {
    this.s = `${quote(schema)}.`
    this.queries = on(pool)
  }

  /** Connects and migrates; any failure closes the pool and names the problem without the URL's password. */
  static async open(options: PostgresOptions, log: (line: string) => void = () => undefined): Promise<PgDb> {
    const scrub = scrubber(options.url)
    let pool: pg.Pool
    try {
      pool = new pg.Pool({ connectionString: options.url, max: options.poolMax, connectionTimeoutMillis: 10_000 })
    } catch (error) { throw new Error(`Invalid TALARIA_STORAGE_URL: ${scrub(errorText(error))}`) }
    // An idle client's connection can drop at any time; the pool replaces it, and the next query reports any lasting fault.
    pool.on('error', (error) => { log(`[storage] Postgres connection error: ${scrub(errorText(error))}`) })
    const db = new PgDb(pool, options.schema, scrub)
    try { await db.migrate() } catch (error) {
      await pool.end().catch(() => undefined)
      throw new Error(`Postgres storage at ${scrub(options.url)} could not start: ${scrub(errorText(error))}`, { cause: scrubbed(error, scrub) })
    }
    return db
  }

  private async migrate(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', MIGRATION_LOCK)
      // A role given an existing schema needs no right to create one.
      if (!await tx.row('SELECT 1 FROM pg_namespace WHERE nspname = $1', this.schema)) await tx.run(`CREATE SCHEMA ${quote(this.schema)}`)
      await tx.run(`CREATE TABLE IF NOT EXISTS ${this.s}talaria_schema (version integer NOT NULL)`)
      const version = (await tx.row<{ version: number | null }>(`SELECT max(version) AS version FROM ${this.s}talaria_schema`))?.version ?? 0
      if (version > SCHEMA_VERSION) throw new Error(`schema ${this.schema} uses storage schema ${String(version)}, newer than this Talaria Web supports (${String(SCHEMA_VERSION)}); upgrade Talaria Web to open it`)
      if (version === SCHEMA_VERSION) return
      const trgm = await this.trigramSchema(tx)
      for (const step of MIGRATIONS.slice(version)) await tx.run(step.replaceAll('{s}', quote(this.schema)).replaceAll('{trgm}', quote(trgm)))
      await tx.run(`DELETE FROM ${this.s}talaria_schema`)
      await tx.run(`INSERT INTO ${this.s}talaria_schema (version) VALUES ($1)`, SCHEMA_VERSION)
    })
  }

  /** The schema holding `pg_trgm`, creating the extension when the role may; otherwise the statement an administrator runs. */
  private async trigramSchema(tx: Queries): Promise<string> {
    const installed = async (): Promise<string | undefined> => (await tx.row<{ schema: string }>("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'"))?.schema
    const existing = await installed()
    if (existing) return existing
    try { await tx.run(TRIGRAM_EXTENSION_SQL) } catch (error) {
      if ((error as { code?: string }).code === '42501') throw new Error(`this role may not create the pg_trgm extension that session search needs; have a database administrator run: ${TRIGRAM_EXTENSION_SQL};`)
      throw error
    }
    const created = await installed()
    if (!created) throw new Error(`pg_trgm is unavailable; have a database administrator run: ${TRIGRAM_EXTENSION_SQL};`)
    return created
  }

  /** Recreates the search index, and `pg_trgm` when it was dropped, from the messages' stored search text. */
  async rebuildSearchIndex(): Promise<void> {
    await this.transaction(async (tx) => {
      const trgm = await this.trigramSchema(tx)
      await tx.run(`CREATE INDEX IF NOT EXISTS messages_search ON ${this.s}messages USING gin (search_text ${quote(trgm)}.gin_trgm_ops)`)
      await tx.run(`REINDEX INDEX ${this.s}messages_search`)
    })
  }

  check(): void { if (this.closed) throw new Error('Storage is closed') }
  get isClosed(): boolean { return this.closed }
  async rows<T>(sql: string, ...params: Param[]): Promise<T[]> { this.check(); return await this.guard(this.queries.rows<T>(sql, ...params)) }
  async row<T>(sql: string, ...params: Param[]): Promise<T | undefined> { this.check(); return await this.guard(this.queries.row<T>(sql, ...params)) }
  async run(sql: string, ...params: Param[]): Promise<number> { this.check(); return await this.guard(this.queries.run(sql, ...params)) }

  /** Runs `fn` in one transaction on one client; a throw anywhere, including at commit, rolls every change back. */
  async transaction<T>(fn: (tx: Queries) => Promise<T>): Promise<T> {
    this.check()
    const client = await this.guard(this.pool.connect())
    let broken = false
    try {
      await client.query('BEGIN')
      try {
        const result = await fn(on(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { broken = true }
        throw error
      }
    } catch (error) { throw scrubbed(error, this.scrub) } finally { client.release(broken) }
  }
  private async guard<T>(work: Promise<T>): Promise<T> { try { return await work } catch (error) { throw scrubbed(error, this.scrub) } }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Removes the URL's password, literally and by the shared URL-userinfo rule, from any text a failure carries. */
function scrubber(url: string): (text: string) => string {
  let password = ''
  try { password = decodeURIComponent(new URL(url).password) } catch { /* an unparseable URL leaves only the shared rule */ }
  const raw = /^[^:]+:\/\/[^:/@]*:([^@/]*)@/.exec(url)?.[1] ?? ''
  const secrets = [...new Set([password, raw].filter((secret) => secret.length > 0))]
  return (text) => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('***')
    return redactSensitive(out)
  }
}
/** The same error with its message scrubbed, so a log or a rethrow never carries the password. */
function scrubbed(error: unknown, scrub: (text: string) => string): unknown {
  if (!(error instanceof Error)) return new Error(scrub(String(error)))
  const message = scrub(error.message)
  if (message !== error.message) error.message = message
  if (error.stack) error.stack = scrub(error.stack)
  return error
}
