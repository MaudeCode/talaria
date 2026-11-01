/* eslint-disable @typescript-eslint/require-await -- node:sqlite is synchronous; each transaction completes before its promise resolves. */
import { str } from '../../util.js'
import { isSafeSessionId, type Message } from '../session.js'
import { RevisionConflict, type MessageMatch, type SessionBackend, type SessionChange, type SessionIndexEntry, type ShrinkBackup, type StorageBackend, type StorageIssue, type StoredSession } from './backend.js'
import { backupIssue, backupStatus, indexIssues } from './json-recovery.js'
import { sessionSearchMatches, sessionSearchMessageText } from './search-text.js'
import { nextRevision, SqliteDb } from './sqlite-db.js'
import { SqliteDocuments } from './sqlite-documents.js'
import { SqliteJournal } from './sqlite-journal.js'

export interface SqliteStorageOptions { path: string; sessionDir: string; env?: Record<string, string | undefined>; stampingSince: () => number | Promise<number> }

/** `TALARIA_STORAGE=sqlite`: sessions, documents and run journals in one Talaria-owned database. */
export class SqliteStorage implements StorageBackend {
  readonly kind = 'sqlite'
  readonly db: SqliteDb
  readonly sessions: SqliteSessions
  readonly documents: SqliteDocuments
  readonly journals: SqliteJournal
  constructor(options: SqliteStorageOptions) {
    this.db = new SqliteDb(options.path)
    this.sessions = new SqliteSessions(this.db, options.stampingSince)
    this.documents = new SqliteDocuments(this.db)
    this.journals = new SqliteJournal(this.db, options.sessionDir, options.env)
  }
  async close(): Promise<void> {
    if (this.db.isClosed) return
    await this.journals.close()
    this.db.close()
  }
}

/** Splice moves the tail out of the way first, so renumbering never collides with the unique (session_id, idx) key. */
const SHIFT = 1_000_000_000
type Dict = Record<string, unknown>
interface SessionRow { doc: string; message_count: number; revision: number }

/** The statements whose plans the cost tests inspect. */
export const SESSION_SQL = {
  readMessages: 'SELECT body FROM messages WHERE session_id = ? AND idx >= ? AND idx < ? ORDER BY idx',
  searchScope: 'm.session_id IN (SELECT value FROM json_each(?)) AND (? = 0 OR m.idx < ?)',
} as const

/** A GLOB pattern matching `term` literally anywhere. */
const globContaining = (term: string): string => `*${term.replace(/[*?[]/g, (c) => `[${c}]`)}*`

class SqliteSessions implements SessionBackend {
  constructor(private readonly db: SqliteDb, private readonly stampingSince: () => number | Promise<number>) {}
  private checked(sid: string): string {
    this.db.check()
    if (!isSafeSessionId(sid)) throw new Error(`Unsafe session_id ${JSON.stringify(sid)}`)
    return sid
  }
  private row(sid: string): SessionRow | undefined { return this.db.get<SessionRow>('SELECT doc, message_count, revision FROM sessions WHERE id = ?', this.checked(sid)) }
  private allMessages(sid: string): Message[] { return this.db.all<{ body: string }>('SELECT body FROM messages WHERE session_id = ? ORDER BY idx', sid).map((r) => JSON.parse(r.body) as Message) }

  async exists(sid: string): Promise<boolean> { return this.row(sid) !== undefined }
  async revision(sid: string): Promise<string | null> { const row = this.row(sid); return row ? String(row.revision) : null }
  async readDocument(sid: string, opts: { metadataOnly?: boolean } = {}): Promise<StoredSession | null> {
    const row = this.row(sid)
    if (!row) return null
    const doc = JSON.parse(row.doc) as Dict
    // Every row records its count, so a metadata read never needs the transcript.
    if (opts.metadataOnly) return { doc, messages: [], messageCount: row.message_count, revision: String(row.revision), metadataOnly: true }
    const messages = this.allMessages(sid)
    return { doc, messages, messageCount: messages.length, revision: String(row.revision), metadataOnly: false }
  }
  async readMessages(sid: string, range: { start: number; end: number }): Promise<Message[]> {
    const end = Number.isFinite(range.end) ? range.end : Number.MAX_SAFE_INTEGER
    return this.db.all<{ body: string }>(SESSION_SQL.readMessages, this.checked(sid), Math.max(0, range.start), Math.max(0, end)).map((r) => JSON.parse(r.body) as Message)
  }
  /**
   * One statement for every session. Terms of three or more characters narrow candidates through the trigram index;
   * shorter ones through `instr`. The index only narrows: the reference matcher decides on the original text, so results
   * equal the JSON adapter's scan, including non-ASCII case folding.
   */
  async searchMessages(sids: readonly string[], terms: readonly string[], depth: number): Promise<Map<string, MessageMatch>> {
    this.db.check()
    const matches = new Map<string, MessageMatch>()
    if (!sids.length || !terms.length) return matches
    // Trigrams are of code points, so count those rather than UTF-16 units.
    const codePoints = (term: string): number => Array.from(term).length
    const long = terms.filter((term) => codePoints(term) >= 3)
    const short = terms.filter((term) => codePoints(term) < 3)
    const where = [...long.map(() => 's.search_text GLOB ?'), SESSION_SQL.searchScope, ...short.map(() => 'instr(m.search_text, ?) > 0')].join(' AND ')
    const from = long.length ? 'message_search s CROSS JOIN messages m ON m.rowid = s.rowid' : 'messages m'
    const params = [...long.map(globContaining), JSON.stringify(sids), depth, depth, ...short]
    for (const row of this.db.all<{ session_id: string; idx: number; body: string }>(`SELECT m.session_id, m.idx, m.body FROM ${from} WHERE ${where} ORDER BY m.session_id, m.idx`, ...params)) {
      if (matches.has(row.session_id)) continue
      const text = sessionSearchMessageText(JSON.parse(row.body))
      if (sessionSearchMatches(text, terms)) matches.set(row.session_id, { idx: row.idx, text })
    }
    return matches
  }
  async write(sid: string, change: SessionChange, expected: string | null): Promise<string> {
    this.checked(sid)
    if (change.doc.session_id !== sid) throw new Error('Session document identity does not match its key')
    return this.db.transaction(() => {
      const current = this.row(sid)
      if ((current ? String(current.revision) : null) !== expected) throw new RevisionConflict(sid)
      const before = current?.message_count ?? 0
      const edit = change.messages
      const from = edit.kind === 'splice' ? Math.min(Math.max(0, edit.from), before) : 0
      const removed = edit.kind === 'splice' ? Math.max(0, Math.min(edit.deleteCount, before - from)) : 0
      const after = edit.kind === 'append' ? before + edit.rows.length : edit.kind === 'splice' ? before - removed + edit.rows.length : edit.kind === 'replace' ? edit.rows.length : before
      // The same rule as the JSON `.bak`: keep the transcript a shrinking write is about to drop.
      if (current && after < before) {
        this.db.run('INSERT INTO shrink_backups (session_id, doc, messages, saved_at, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET doc = excluded.doc, messages = excluded.messages, saved_at = excluded.saved_at, revision = excluded.revision',
          sid, current.doc, JSON.stringify(this.allMessages(sid)), Date.now() / 1000, nextRevision(null))
      }
      const doc: Dict = {}
      for (const [key, value] of Object.entries(change.doc)) if (key !== 'messages') doc[key] = key === 'message_count' ? after : value
      const revision = nextRevision(current?.revision ?? null)
      const updatedAt = typeof doc.updated_at === 'number' ? doc.updated_at : null
      this.db.run('INSERT INTO sessions (id, doc, message_count, revision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, message_count = excluded.message_count, revision = excluded.revision, updated_at = excluded.updated_at',
        sid, JSON.stringify(doc), after, revision, updatedAt)
      if (edit.kind === 'append') this.insert(sid, before, edit.rows)
      else if (edit.kind === 'replace') { this.db.run('DELETE FROM messages WHERE session_id = ?', sid); this.insert(sid, 0, edit.rows) }
      else if (edit.kind === 'splice') {
        const delta = edit.rows.length - removed
        if (removed) this.db.run('DELETE FROM messages WHERE session_id = ? AND idx >= ? AND idx < ?', sid, from, from + removed)
        const tail = delta !== 0 && from + removed < before
        if (tail) this.db.run('UPDATE messages SET idx = idx + ? WHERE session_id = ? AND idx >= ?', SHIFT, sid, from + removed)
        this.insert(sid, from, edit.rows)
        if (tail) this.db.run('UPDATE messages SET idx = idx - ? WHERE session_id = ? AND idx >= ?', SHIFT - delta, sid, SHIFT)
      }
      return String(revision)
    })
  }
  private insert(sid: string, start: number, rows: readonly Message[]): void {
    rows.forEach((row, offset) => {
      this.db.run('INSERT INTO messages (session_id, idx, body, search_text) VALUES (?, ?, ?, ?)', sid, start + offset, JSON.stringify(row), sessionSearchMessageText(row).toLowerCase())
    })
  }
  async delete(sid: string, opts: { tombstone: boolean }): Promise<boolean> {
    this.checked(sid)
    this.db.transaction(() => {
      this.db.run('DELETE FROM sessions WHERE id = ?', sid)
      if (opts.tombstone) this.addTombstone(sid)
    })
    return true
  }
  async ids(): Promise<Set<string>> { this.db.check(); return new Set(this.db.all<{ id: string }>('SELECT id FROM sessions').map((r) => r.id)) }
  async hasIndex(): Promise<boolean> { this.db.check(); return this.db.get('SELECT 1 AS present FROM session_index WHERE id = 1') !== undefined }
  async index(): Promise<{ entries: SessionIndexEntry[]; revision: string }> {
    this.db.check()
    const row = this.db.get<{ entries: string; revision: number }>('SELECT entries, revision FROM session_index WHERE id = 1')
    if (!row) throw Object.assign(new Error('session index is missing'), { code: 'ENOENT' })
    const entries = JSON.parse(row.entries) as unknown
    if (!Array.isArray(entries)) throw new Error('session index must be a list')
    return { entries: entries as SessionIndexEntry[], revision: String(row.revision) }
  }
  async writeIndex(entries: SessionIndexEntry[]): Promise<void> {
    this.db.transaction(() => {
      const previous = this.db.get<{ revision: number }>('SELECT revision FROM session_index WHERE id = 1')?.revision ?? null
      this.db.run('INSERT INTO session_index (id, entries, revision) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET entries = excluded.entries, revision = excluded.revision', JSON.stringify(entries), nextRevision(previous))
    })
  }
  private addTombstone(sid: string): void { this.db.run('INSERT INTO session_tombstones (id, deleted_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', sid, Date.now() / 1000) }
  readonly tombstones = {
    has: async (sid: string): Promise<boolean> => { this.db.check(); return this.db.get('SELECT 1 AS present FROM session_tombstones WHERE id = ?', sid) !== undefined },
    all: async (): Promise<Set<string>> => { this.db.check(); return new Set(this.db.all<{ id: string }>('SELECT id FROM session_tombstones').map((r) => r.id)) },
    add: async (sid: string): Promise<void> => { this.db.check(); this.addTombstone(sid) },
    remove: async (sid: string): Promise<void> => { this.db.check(); this.db.run('DELETE FROM session_tombstones WHERE id = ?', sid) },
  }
  private backup(sid: string): { doc: string; messages: string; saved_at: number; revision: number } | undefined {
    return this.db.get('SELECT doc, messages, saved_at, revision FROM shrink_backups WHERE session_id = ?', this.checked(sid))
  }
  /** The live document and its backup, each with `messages`, as the shared restore rule reads them. */
  private backupStatus(sid: string, stampingSince: number) {
    const backup = this.backup(sid)
    const live = this.row(sid)
    if (!backup || !live) return null
    const liveDoc = { ...JSON.parse(live.doc) as Dict, messages: this.allMessages(sid) }
    const bakDoc: Dict & { messages: Message[] } = { ...JSON.parse(backup.doc) as Dict, messages: JSON.parse(backup.messages) as Message[] }
    return { status: backupStatus(sid, liveDoc, bakDoc, backup.saved_at, stampingSince), live, backup, bakDoc }
  }
  private async restore(sid: string, guard?: (live: SessionRow, backup: { revision: number }) => boolean): Promise<boolean> {
    if (!isSafeSessionId(sid)) return false
    const stampingSince = await this.stampingSince()
    return this.db.transaction(() => {
      const found = this.backupStatus(sid, stampingSince)
      if (found?.status.recommend !== 'restore' || (guard && !guard(found.live, found.backup))) return false
      // Like the JSON adapter's `.bak` publication: the backup becomes the session as it was saved.
      const rows = found.bakDoc.messages
      const updatedAt = found.bakDoc.updated_at
      this.db.run('UPDATE sessions SET doc = ?, message_count = ?, revision = ?, updated_at = ? WHERE id = ?', found.backup.doc, rows.length, nextRevision(found.live.revision), typeof updatedAt === 'number' ? updatedAt : null, sid)
      this.db.run('DELETE FROM messages WHERE session_id = ?', sid)
      this.insert(sid, 0, rows)
      return true
    })
  }
  readonly shrinkBackup = {
    discard: async (sid: string): Promise<void> => { this.checked(sid); this.db.run('DELETE FROM shrink_backups WHERE session_id = ?', sid) },
    restore: async (sid: string): Promise<boolean> => this.restore(sid),
    read: async (sid: string): Promise<ShrinkBackup | null> => {
      const backup = this.backup(sid)
      return backup ? { doc: JSON.parse(backup.doc) as Dict, messages: JSON.parse(backup.messages) as Message[], savedAt: backup.saved_at } : null
    },
    write: async (sid: string, backup: ShrinkBackup): Promise<void> => {
      this.checked(sid)
      const doc = { ...backup.doc }
      delete doc.messages
      this.db.run('INSERT INTO shrink_backups (session_id, doc, messages, saved_at, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET doc = excluded.doc, messages = excluded.messages, saved_at = excluded.saved_at, revision = excluded.revision',
        sid, JSON.stringify(doc), JSON.stringify(backup.messages), backup.savedAt, nextRevision(null))
    },
  }
  async diagnose(): Promise<StorageIssue[]> {
    this.db.check()
    const issues: StorageIssue[] = []
    const integrity = (kind: StorageIssue['kind'], category: StorageIssue['category'], recommendation: StorageIssue['recommendation']): StorageIssue => ({ session_id: '', kind, category, recommendation, live_messages: -1, bak_messages: -1 })
    const problems = this.db.all<{ integrity_check: string }>('PRAGMA integrity_check').filter((r) => r.integrity_check !== 'ok')
    const orphans = this.db.get<{ n: number }>('SELECT count(*) AS n FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)')?.n ?? 0
    if (problems.length || orphans) issues.push(integrity('storage_integrity', 'unsafe_to_repair', 'manual_review'))
    try { this.db.db.exec("INSERT INTO message_search (message_search, rank) VALUES ('integrity-check', 1)") } catch { issues.push(integrity('search_index_mismatch', 'repairable', 'rebuild_search_index')) }
    const stampingSince = await this.stampingSince()
    for (const { session_id: sid } of this.db.all<{ session_id: string }>('SELECT session_id FROM shrink_backups ORDER BY session_id')) {
      const found = this.backupStatus(sid, stampingSince)
      if (!found) continue
      const doc = JSON.parse(found.live.doc) as Dict
      const issue = backupIssue(found.status, { session_id: sid, live_messages: found.status.live_messages, bak_messages: found.status.bak_messages, profile: str(doc.profile) || 'default', revision: String(found.live.revision), backupRevision: String(found.backup.revision) })
      if (issue) issues.push(issue)
    }
    const index = this.db.get<{ entries: string }>('SELECT entries FROM session_index WHERE id = 1')
    if (index) {
      let indexed: Set<string> | null = null
      try { indexed = new Set((JSON.parse(index.entries) as Dict[]).map((e) => e.session_id).filter((id): id is string => typeof id === 'string')) } catch { /* reported as unreadable */ }
      const counts = new Map(this.db.all<{ id: string; message_count: number }>('SELECT id, message_count FROM sessions').map((r) => [r.id, r.message_count]))
      issues.push(...indexIssues(indexed, new Set(counts.keys()), (sid) => counts.get(sid) ?? -1))
    }
    return issues
  }
  async repair(issue: StorageIssue): Promise<boolean> {
    this.db.check()
    if (issue.recommendation === 'rebuild_search_index') { this.db.transaction(() => { this.db.db.exec("INSERT INTO message_search (message_search) VALUES ('rebuild')") }); return true }
    if (issue.recommendation !== 'restore_from_bak') return false
    return this.restore(issue.session_id, (live, backup) => String(live.revision) === issue.revision && String(backup.revision) === issue.backupRevision)
  }
}
