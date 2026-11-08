import { str } from '../../util.js'
import { isSafeSessionId, type Message } from '../session.js'
import { RevisionConflict, type MessageMatch, type SessionBackend, type SessionChange, type SessionIndexEntry, type ShrinkBackup, type StorageBackend, type StorageIssue, type StoredSession } from './backend.js'
import { backupIssue, backupStatus, indexIssues } from './json-recovery.js'
import { NEXT_REVISION, PgDb, SCHEMA_VERSION, type PostgresOptions, type Queries } from './postgres-db.js'
import { PostgresDocuments } from './postgres-documents.js'
import { PostgresJournal } from './postgres-journal.js'
import { sessionSearchMatches, sessionSearchMessageText } from './search-text.js'

export interface PostgresStorageOptions extends PostgresOptions { sessionDir: string; env?: Record<string, string | undefined>; stampingSince: () => number | Promise<number>; log?: (line: string) => void }

/** `TALARIA_STORAGE=postgres`: sessions, documents and run journals in one schema of a Postgres database. */
export class PostgresStorage implements StorageBackend {
  readonly kind = 'postgres'
  readonly sessions: PostgresSessions
  readonly documents: PostgresDocuments
  readonly journals: PostgresJournal
  private constructor(readonly db: PgDb, options: PostgresStorageOptions) {
    this.sessions = new PostgresSessions(db, options.stampingSince)
    this.documents = new PostgresDocuments(db)
    this.journals = new PostgresJournal(db, options.sessionDir, options.env)
  }
  /** Connects and migrates before returning, so an unreachable database fails startup instead of the first request. */
  static async open(options: PostgresStorageOptions): Promise<PostgresStorage> {
    return new PostgresStorage(await PgDb.open(options, options.log), options)
  }
  async close(): Promise<void> {
    if (this.db.isClosed) return
    await this.journals.close()
    await this.db.close()
  }
}

/** Splice moves the tail out of the way first, so renumbering never collides with the (session_id, idx) key. */
const SHIFT = 1_000_000_000
type Dict = Record<string, unknown>
interface SessionRow { doc: string; message_count: number; revision: string }

/** The statements whose plans and counts the cost tests inspect. */
export const SESSION_SQL = {
  readMessages: (s: string) => `SELECT body FROM ${s}messages WHERE session_id = $1 AND idx >= $2 AND idx < $3 ORDER BY idx`,
} as const

/** A LIKE pattern matching `term` literally anywhere (with `ESCAPE '\'`). */
const likeContaining = (term: string): string => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
/** Text as Postgres can store it: no NUL, and a lone surrogate arrives as U+FFFD. */
const searchable = (text: string): string => text.replaceAll('\0', '')
/** Whether the stored search text is the text itself, so a match on it is a real match. */
const exact = (text: string): boolean => !text.includes('\0') && !/\p{Cs}/u.test(text)
/** Rows as one JSON array, so a whole transcript reads in one statement without parsing each row separately. */
const parseRows = (text: string): Message[] => JSON.parse(text) as Message[]
const AGGREGATE_BODIES = (s: string, sid: string) => `(SELECT '[' || coalesce(string_agg(body, ',' ORDER BY idx), '') || ']' FROM ${s}messages WHERE session_id = ${sid})`

class PostgresSessions implements SessionBackend {
  constructor(private readonly db: PgDb, private readonly stampingSince: () => number | Promise<number>) {}
  private get s(): string { return this.db.s }
  private checked(sid: string): string {
    this.db.check()
    if (!isSafeSessionId(sid)) throw new Error(`Unsafe session_id ${JSON.stringify(sid)}`)
    return sid
  }
  private async row(sid: string, q: Queries = this.db): Promise<SessionRow | undefined> {
    return await q.row<SessionRow>(`SELECT doc, message_count, revision FROM ${this.s}sessions WHERE id = $1`, this.checked(sid))
  }

  async exists(sid: string): Promise<boolean> { return (await this.row(sid)) !== undefined }
  async revision(sid: string): Promise<string | null> { return (await this.row(sid))?.revision ?? null }
  async readDocument(sid: string, opts: { metadataOnly?: boolean } = {}): Promise<StoredSession | null> {
    if (opts.metadataOnly) {
      // Every row records its count, so a metadata read never needs the transcript.
      const row = await this.row(sid)
      return row ? { doc: JSON.parse(row.doc) as Dict, messages: [], messageCount: row.message_count, revision: row.revision, metadataOnly: true } : null
    }
    // One statement, so the document and its rows come from the same committed revision.
    const row = await this.db.row<SessionRow & { messages: string }>(`SELECT doc, message_count, revision, ${AGGREGATE_BODIES(this.s, '$1')} AS messages FROM ${this.s}sessions WHERE id = $1`, this.checked(sid))
    if (!row) return null
    const messages = parseRows(row.messages)
    return { doc: JSON.parse(row.doc) as Dict, messages, messageCount: messages.length, revision: row.revision, metadataOnly: false }
  }
  async readMessages(sid: string, range: { start: number; end: number }): Promise<Message[]> {
    const clamp = (n: number): number => Math.min(Math.max(0, n), 2 ** 31 - 1)
    const end = Number.isFinite(range.end) ? range.end : Number.MAX_SAFE_INTEGER
    return (await this.db.rows<{ body: string }>(SESSION_SQL.readMessages(this.s), this.checked(sid), clamp(range.start), clamp(end))).map((r) => JSON.parse(r.body) as Message)
  }
  /**
   * One statement for every session. Terms of three or more characters narrow candidates through the trigram index (a
   * LIKE with the term's wildcards escaped); shorter ones by `strpos`. `search_text` is computed on write from the same
   * function, so a candidate whose stored text is exact is a real match: each session returns its rows up to and
   * including the first such one, which for ordinary text is that row alone. The reference matcher decides on the stored
   * row, so results equal the JSON adapter's scan, including non-ASCII case folding.
   */
  async searchMessages(sids: readonly string[], terms: readonly string[], depth: number): Promise<Map<string, MessageMatch>> {
    this.db.check()
    const matches = new Map<string, MessageMatch>()
    if (!sids.length || !terms.length) return matches
    const params: (string | number | readonly string[])[] = [sids, depth]
    const where = ['session_id = ANY($1::text[])', '($2::integer = 0 OR idx < $2::integer)']
    // A term Postgres cannot store exactly can only be in a row whose stored text is not exact either.
    if (!terms.every(exact)) where.push('NOT search_exact')
    for (const term of terms) {
      const narrow = searchable(term)
      if (!narrow) continue
      params.push(Array.from(narrow).length >= 3 ? likeContaining(narrow) : narrow)
      where.push(Array.from(narrow).length >= 3 ? `search_text LIKE $${String(params.length)} ESCAPE '\\'` : `strpos(search_text, $${String(params.length)}) > 0`)
    }
    for (const row of await this.db.rows<{ session_id: string; idx: number; body: string }>(`SELECT session_id, idx, body FROM (
        SELECT session_id, idx, body, count(*) FILTER (WHERE search_exact) OVER (PARTITION BY session_id ORDER BY idx ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS exact_before
        FROM ${this.s}messages WHERE ${where.join(' AND ')}) AS candidates
      WHERE exact_before = 0 ORDER BY session_id, idx`, ...params)) {
      if (matches.has(row.session_id)) continue
      const text = sessionSearchMessageText(JSON.parse(row.body))
      if (sessionSearchMatches(text, terms)) matches.set(row.session_id, { idx: row.idx, text })
    }
    return matches
  }
  /**
   * One transaction. The session row is locked (or created) only when `expected` still names its revision, so a stale
   * writer on any pool raises `RevisionConflict` instead of overwriting a newer save.
   */
  async write(sid: string, change: SessionChange, expected: string | null): Promise<string> {
    this.checked(sid)
    if (change.doc.session_id !== sid) throw new Error('Session document identity does not match its key')
    const edit = change.messages
    const doc: Dict = {}
    for (const [key, value] of Object.entries(change.doc)) if (key !== 'messages') doc[key] = value
    return await this.db.transaction(async (tx) => {
      let before = 0
      if (expected !== null) {
        const current = await tx.row<{ message_count: number }>(`SELECT message_count FROM ${this.s}sessions WHERE id = $1 AND revision = $2 FOR UPDATE`, sid, expected)
        if (!current) throw new RevisionConflict(sid)
        before = current.message_count
      }
      const from = edit.kind === 'splice' ? Math.min(Math.max(0, edit.from), before) : 0
      const removed = edit.kind === 'splice' ? Math.max(0, Math.min(edit.deleteCount, before - from)) : 0
      const after = edit.kind === 'append' ? before + edit.rows.length : edit.kind === 'splice' ? before - removed + edit.rows.length : edit.kind === 'replace' ? edit.rows.length : before
      if (Object.hasOwn(change.doc, 'message_count')) doc.message_count = after
      const updatedAt = typeof doc.updated_at === 'number' ? doc.updated_at : null
      let revision: string | undefined
      if (expected === null) {
        revision = (await tx.row<{ revision: string }>(`INSERT INTO ${this.s}sessions (id, doc, message_count, revision, updated_at) VALUES ($1, $2, $3, ${NEXT_REVISION('0')}, $4) ON CONFLICT (id) DO NOTHING RETURNING revision`, sid, JSON.stringify(doc), after, updatedAt))?.revision
        if (revision === undefined) throw new RevisionConflict(sid)
      } else {
        // The same rule as the JSON `.bak`: keep the transcript a shrinking write is about to drop.
        if (after < before) {
          await tx.run(`INSERT INTO ${this.s}shrink_backups (session_id, doc, messages, saved_at, revision) SELECT id, doc, ${AGGREGATE_BODIES(this.s, '$1')}, $2, ${NEXT_REVISION('0')} FROM ${this.s}sessions WHERE id = $1
            ON CONFLICT (session_id) DO UPDATE SET doc = excluded.doc, messages = excluded.messages, saved_at = excluded.saved_at, revision = excluded.revision`, sid, Date.now() / 1000)
        }
        revision = (await tx.row<{ revision: string }>(`UPDATE ${this.s}sessions SET doc = $2, message_count = $3, revision = ${NEXT_REVISION('revision')}, updated_at = $4 WHERE id = $1 RETURNING revision`, sid, JSON.stringify(doc), after, updatedAt))!.revision
      }
      if (edit.kind === 'append') await this.insert(tx, sid, before, edit.rows)
      else if (edit.kind === 'replace') { if (before) await tx.run(`DELETE FROM ${this.s}messages WHERE session_id = $1`, sid); await this.insert(tx, sid, 0, edit.rows) }
      else if (edit.kind === 'splice') {
        const delta = edit.rows.length - removed
        if (removed) await tx.run(`DELETE FROM ${this.s}messages WHERE session_id = $1 AND idx >= $2 AND idx < $3`, sid, from, from + removed)
        const tail = delta !== 0 && from + removed < before
        if (tail) await tx.run(`UPDATE ${this.s}messages SET idx = idx + $2 WHERE session_id = $1 AND idx >= $3`, sid, SHIFT, from + removed)
        await this.insert(tx, sid, from, edit.rows)
        if (tail) await tx.run(`UPDATE ${this.s}messages SET idx = idx - $2 WHERE session_id = $1 AND idx >= $3`, sid, SHIFT - delta, SHIFT)
      }
      return revision
    })
  }
  /** Every row in one statement, whatever the count. */
  private async insert(tx: Queries, sid: string, start: number, rows: readonly Message[]): Promise<void> {
    if (!rows.length) return
    const texts = rows.map((row) => sessionSearchMessageText(row).toLowerCase())
    await tx.run(`INSERT INTO ${this.s}messages (session_id, idx, body, search_text, search_exact) SELECT $1, $2 + u.n - 1, u.body, u.search_text, u.search_exact FROM unnest($3::text[], $4::text[], $5::boolean[]) WITH ORDINALITY AS u(body, search_text, search_exact, n)`,
      sid, start, rows.map((row) => JSON.stringify(row)), texts.map(searchable), texts.map(exact))
  }
  async delete(sid: string, opts: { tombstone: boolean }): Promise<boolean> {
    this.checked(sid)
    await this.db.transaction(async (tx) => {
      await tx.run(`DELETE FROM ${this.s}sessions WHERE id = $1`, sid)
      if (opts.tombstone) await this.addTombstone(tx, sid)
    })
    return true
  }
  async ids(): Promise<Set<string>> { return new Set((await this.db.rows<{ id: string }>(`SELECT id FROM ${this.s}sessions`)).map((r) => r.id)) }
  async hasIndex(): Promise<boolean> { return (await this.db.row(`SELECT 1 FROM ${this.s}session_index WHERE id = 1`)) !== undefined }
  async index(): Promise<{ entries: SessionIndexEntry[]; revision: string }> {
    const row = await this.db.row<{ entries: string; revision: string }>(`SELECT entries, revision FROM ${this.s}session_index WHERE id = 1`)
    if (!row) throw Object.assign(new Error('session index is missing'), { code: 'ENOENT' })
    const entries = JSON.parse(row.entries) as unknown
    if (!Array.isArray(entries)) throw new Error('session index must be a list')
    return { entries: entries as SessionIndexEntry[], revision: row.revision }
  }
  async writeIndex(entries: SessionIndexEntry[]): Promise<void> {
    await this.db.run(`INSERT INTO ${this.s}session_index AS i (id, entries, revision) VALUES (1, $1, ${NEXT_REVISION('0')}) ON CONFLICT (id) DO UPDATE SET entries = excluded.entries, revision = ${NEXT_REVISION('i.revision')}`, JSON.stringify(entries))
  }
  private async addTombstone(q: Queries, sid: string): Promise<void> { await q.run(`INSERT INTO ${this.s}session_tombstones (id, deleted_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, sid, Date.now() / 1000) }
  readonly tombstones = {
    has: async (sid: string): Promise<boolean> => (await this.db.row(`SELECT 1 FROM ${this.s}session_tombstones WHERE id = $1`, sid)) !== undefined,
    all: async (): Promise<Set<string>> => new Set((await this.db.rows<{ id: string }>(`SELECT id FROM ${this.s}session_tombstones`)).map((r) => r.id)),
    add: async (sid: string): Promise<void> => { this.db.check(); await this.addTombstone(this.db, sid) },
    remove: async (sid: string): Promise<void> => { await this.db.run(`DELETE FROM ${this.s}session_tombstones WHERE id = $1`, sid) },
  }
  private async backup(sid: string, q: Queries = this.db): Promise<{ doc: string; messages: string; saved_at: number; revision: string } | undefined> {
    return await q.row(`SELECT doc, messages, saved_at, revision FROM ${this.s}shrink_backups WHERE session_id = $1`, this.checked(sid))
  }
  /** The live document and its backup, each with `messages`, as the shared restore rule reads them. */
  private async backupStatus(sid: string, stampingSince: number, q: Queries = this.db) {
    const backup = await this.backup(sid, q)
    if (!backup) return null
    const live = await q.row<SessionRow & { messages: string }>(`SELECT doc, message_count, revision, ${AGGREGATE_BODIES(this.s, '$1')} AS messages FROM ${this.s}sessions WHERE id = $1`, sid)
    if (!live) return null
    const liveDoc = { ...JSON.parse(live.doc) as Dict, messages: parseRows(live.messages) }
    const bakDoc: Dict & { messages: Message[] } = { ...JSON.parse(backup.doc) as Dict, messages: JSON.parse(backup.messages) as Message[] }
    return { status: backupStatus(sid, liveDoc, bakDoc, backup.saved_at, stampingSince), live, backup, bakDoc }
  }
  private async restore(sid: string, guard?: (live: SessionRow, backup: { revision: string }) => boolean): Promise<boolean> {
    if (!isSafeSessionId(sid)) return false
    const stampingSince = await this.stampingSince()
    return await this.db.transaction(async (tx) => {
      await tx.run(`SELECT 1 FROM ${this.s}sessions WHERE id = $1 FOR UPDATE`, sid)
      const found = await this.backupStatus(sid, stampingSince, tx)
      if (found?.status.recommend !== 'restore' || (guard && !guard(found.live, found.backup))) return false
      // Like the JSON adapter's `.bak` publication: the backup becomes the session as it was saved.
      const rows = found.bakDoc.messages
      const updatedAt = found.bakDoc.updated_at
      await tx.run(`UPDATE ${this.s}sessions SET doc = $2, message_count = $3, revision = ${NEXT_REVISION('revision')}, updated_at = $4 WHERE id = $1`, sid, found.backup.doc, rows.length, typeof updatedAt === 'number' ? updatedAt : null)
      await tx.run(`DELETE FROM ${this.s}messages WHERE session_id = $1`, sid)
      await this.insert(tx, sid, 0, rows)
      return true
    })
  }
  readonly shrinkBackup = {
    discard: async (sid: string): Promise<void> => { await this.db.run(`DELETE FROM ${this.s}shrink_backups WHERE session_id = $1`, this.checked(sid)) },
    restore: async (sid: string): Promise<boolean> => await this.restore(sid),
    read: async (sid: string): Promise<ShrinkBackup | null> => {
      const backup = await this.backup(sid)
      return backup ? { doc: JSON.parse(backup.doc) as Dict, messages: JSON.parse(backup.messages) as Message[], savedAt: backup.saved_at } : null
    },
    write: async (sid: string, backup: ShrinkBackup): Promise<void> => {
      this.checked(sid)
      const doc = { ...backup.doc }
      delete doc.messages
      await this.db.run(`INSERT INTO ${this.s}shrink_backups (session_id, doc, messages, saved_at, revision) VALUES ($1, $2, $3, $4, ${NEXT_REVISION('0')})
        ON CONFLICT (session_id) DO UPDATE SET doc = excluded.doc, messages = excluded.messages, saved_at = excluded.saved_at, revision = excluded.revision`, sid, JSON.stringify(doc), JSON.stringify(backup.messages), backup.savedAt)
    },
  }
  /** The schema version, `pg_trgm` and the search index, orphaned rows, then the backup and index rules every adapter shares. */
  async diagnose(): Promise<StorageIssue[]> {
    this.db.check()
    const issues: StorageIssue[] = []
    const integrity = (kind: StorageIssue['kind'], category: StorageIssue['category'], recommendation: StorageIssue['recommendation']): StorageIssue => ({ session_id: '', kind, category, recommendation, live_messages: -1, bak_messages: -1 })
    const health = await this.db.row<{ version: number | null; trgm: boolean; search_index: boolean; orphans: string }>(`SELECT
      (SELECT max(version) FROM ${this.s}talaria_schema) AS version,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'messages_search') AS search_index,
      (SELECT count(*) FROM ${this.s}messages m WHERE NOT EXISTS (SELECT 1 FROM ${this.s}sessions s WHERE s.id = m.session_id))
        + (SELECT count(*) FROM ${this.s}shrink_backups b WHERE NOT EXISTS (SELECT 1 FROM ${this.s}sessions s WHERE s.id = b.session_id)) AS orphans`, this.db.schema)
    if ((health?.version ?? 0) !== SCHEMA_VERSION || Number(health?.orphans ?? 0) > 0) issues.push(integrity('storage_integrity', 'unsafe_to_repair', 'manual_review'))
    if (!health?.trgm || !health.search_index) issues.push(integrity('search_index_mismatch', 'repairable', 'rebuild_search_index'))
    const stampingSince = await this.stampingSince()
    for (const { session_id: sid } of await this.db.rows<{ session_id: string }>(`SELECT session_id FROM ${this.s}shrink_backups ORDER BY session_id COLLATE "C"`)) {
      const found = await this.backupStatus(sid, stampingSince)
      if (!found) continue
      const doc = JSON.parse(found.live.doc) as Dict
      const issue = backupIssue(found.status, { session_id: sid, live_messages: found.status.live_messages, bak_messages: found.status.bak_messages, profile: str(doc.profile) || 'default', revision: found.live.revision, backupRevision: found.backup.revision })
      if (issue) issues.push(issue)
    }
    const index = await this.db.row<{ entries: string }>(`SELECT entries FROM ${this.s}session_index WHERE id = 1`)
    if (index) {
      let indexed: Set<string> | null = null
      try { indexed = new Set((JSON.parse(index.entries) as Dict[]).map((e) => e.session_id).filter((id): id is string => typeof id === 'string')) } catch { /* reported as unreadable */ }
      const counts = new Map((await this.db.rows<{ id: string; message_count: number }>(`SELECT id, message_count FROM ${this.s}sessions`)).map((r) => [r.id, r.message_count]))
      issues.push(...indexIssues(indexed, new Set(counts.keys()), (sid) => counts.get(sid) ?? -1))
    }
    return issues
  }
  async repair(issue: StorageIssue): Promise<boolean> {
    this.db.check()
    if (issue.recommendation === 'rebuild_search_index') { await this.db.rebuildSearchIndex(); return true }
    if (issue.recommendation !== 'restore_from_bak') return false
    return await this.restore(issue.session_id, (live, backup) => live.revision === issue.revision && backup.revision === issue.backupRevision)
  }
}
