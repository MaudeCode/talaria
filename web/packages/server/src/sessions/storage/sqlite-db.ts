import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

/** Numbered schema steps; `talaria_schema.version` is how many have been applied. Never edit a released step: append one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, doc TEXT NOT NULL, message_count INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at REAL) WITHOUT ROWID;
   -- An integer rowid, because FTS5 external content is keyed by one; (session_id, idx) stays unique for range reads.
   CREATE TABLE messages (rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, idx INTEGER NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL, UNIQUE (session_id, idx));
   -- search_text is already lowercased the way JavaScript does it, so a case-sensitive trigram GLOB is an exact substring test.
   CREATE VIRTUAL TABLE message_search USING fts5(search_text, content='messages', content_rowid='rowid', tokenize='trigram case_sensitive 1');
   CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN INSERT INTO message_search(rowid, search_text) VALUES (new.rowid, new.search_text); END;
   CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN INSERT INTO message_search(message_search, rowid, search_text) VALUES ('delete', old.rowid, old.search_text); END;
   CREATE TRIGGER messages_search_update AFTER UPDATE OF search_text ON messages BEGIN
     INSERT INTO message_search(message_search, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
     INSERT INTO message_search(rowid, search_text) VALUES (new.rowid, new.search_text);
   END;
   CREATE TABLE session_tombstones (id TEXT PRIMARY KEY, deleted_at REAL NOT NULL) WITHOUT ROWID;
   CREATE TABLE shrink_backups (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, doc TEXT NOT NULL, messages TEXT NOT NULL, saved_at REAL NOT NULL, revision INTEGER NOT NULL) WITHOUT ROWID;
   CREATE TABLE session_index (id INTEGER PRIMARY KEY CHECK (id = 1), entries TEXT NOT NULL, revision INTEGER NOT NULL);
   CREATE TABLE documents (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (ns, key)) WITHOUT ROWID;
   CREATE TABLE journal_rows (session_id TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL, row TEXT NOT NULL, written_at REAL NOT NULL, PRIMARY KEY (session_id, stream_id, seq)) WITHOUT ROWID;
   CREATE INDEX journal_rows_stream ON journal_rows (stream_id);
   CREATE TABLE journal_summaries (session_id TEXT NOT NULL, stream_id TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (session_id, stream_id)) WITHOUT ROWID;
   CREATE INDEX journal_summaries_stream ON journal_summaries (stream_id);`,
  // TAL-1748: a settled run's rows compacted in place, as one gzip of its newline-terminated rows. `bytes` is that
  // uncompressed size and `last_seq` its last row's seq; live rows past `last_seq` continue the run.
  `CREATE TABLE journal_archives (session_id TEXT NOT NULL, stream_id TEXT NOT NULL, rows BLOB NOT NULL, bytes INTEGER NOT NULL, last_seq INTEGER NOT NULL, archived_at REAL NOT NULL, PRIMARY KEY (session_id, stream_id)) WITHOUT ROWID;
   CREATE INDEX journal_archives_stream ON journal_archives (stream_id);`,
]
export const SCHEMA_VERSION = MIGRATIONS.length

/** A new revision: never reused after a delete and recreate, and always past the previous one. */
export function nextRevision(previous: number | null): number { return Math.max((previous ?? 0) + 1, Date.now()) }

/** The one `node:sqlite` connection a SQLite store shares; every write is one synchronous transaction on it. */
export class SqliteDb {
  readonly db: DatabaseSync
  private closed = false
  private readonly statements = new Map<string, StatementSync>()
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    // The database holds the same secrets the JSON adapter writes 0600. SQLite creates its WAL and shared-memory files
    // with the database file's mode, so restrict the database before WAL starts, and any side file an older run left.
    closeSync(openSync(path, 'a', 0o600))
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) if (existsSync(file)) chmodSync(file, 0o600)
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL')
      this.migrate()
    } catch (error) { this.db.close(); throw error }
  }
  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS talaria_schema (version INTEGER NOT NULL)')
    const version = (this.db.prepare('SELECT max(version) AS version FROM talaria_schema').get()?.version as number | null) ?? 0
    if (version > SCHEMA_VERSION) throw new Error(`${this.path} uses storage schema ${String(version)}, newer than this Talaria Web supports (${String(SCHEMA_VERSION)}); upgrade Talaria Web to open it`)
    if (version === SCHEMA_VERSION) return
    this.transaction(() => {
      for (const step of MIGRATIONS.slice(version)) this.db.exec(step)
      this.db.exec('DELETE FROM talaria_schema')
      this.db.prepare('INSERT INTO talaria_schema (version) VALUES (?)').run(SCHEMA_VERSION)
    })
  }
  check(): void { if (this.closed) throw new Error('Storage is closed') }
  get isClosed(): boolean { return this.closed }
  prepare(sql: string): StatementSync {
    this.check()
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the row shape a query returns, like `all`.
  get<T = Record<string, SQLInputValue>>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.prepare(sql).get(...params) as T | undefined }
  all<T = Record<string, SQLInputValue>>(sql: string, ...params: SQLInputValue[]): T[] { return this.prepare(sql).all(...params) as T[] }
  run(sql: string, ...params: SQLInputValue[]): number { return Number(this.prepare(sql).run(...params).changes) }
  /** Runs `fn` in one write transaction; a throw anywhere, including at commit, rolls every change back. */
  transaction<T>(fn: () => T, synchronous: 'FULL' | 'NORMAL' = 'FULL'): T {
    this.check()
    if (synchronous !== 'FULL') this.db.exec(`PRAGMA synchronous = ${synchronous}`)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK')
        throw error
      }
    } finally { if (synchronous !== 'FULL') this.db.exec('PRAGMA synchronous = FULL') }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    this.db.close()
  }
}
