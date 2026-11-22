import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { str } from '../../util.js'
import { isSafeSessionId, type Message } from '../session.js'
import { RevisionConflict, type MessageMatch, type SessionBackend, type SessionChange, type SessionIndexEntry, type ShrinkBackup, type StorageBackend, type StorageIssue, type StoredSession } from './backend.js'
import { withDocumentQueue } from './document.js'
import { JsonDocuments } from './json-documents.js'
import { JsonJournal } from './json-journal.js'
import { backupIssue, backupStatus, indexIssues } from './json-recovery.js'
import { withSessionPrefixRead } from './json-files.js'
import { JsonSessions } from './json.js'
import { sessionSearchEntry, sessionSearchMatches } from './search-text.js'
import { nextRevision } from './sqlite-db.js'

export interface JsonlStorageOptions {
  /** `<stateDir>/sessions-jsonl`: one directory per session. */
  directory: string
  /** The JSON adapter's session directory, which keeps the reused drafts and run journals. */
  sessionDir: string
  stateDir: string
  profileHome?: (profile: string) => string
  env?: Record<string, string | undefined>
  now: () => number
  stampingSince: () => number | Promise<number>
}

/**
 * `TALARIA_STORAGE=jsonl` (TAL-1068): each session is a `meta.json` and an append-only `messages.jsonl` with a fixed-width
 * offset index. Documents and run journals are the JSON adapter's, unchanged.
 */
export class JsonlStorage implements StorageBackend {
  readonly kind = 'jsonl'
  readonly sessions: JsonlSessions
  readonly documents: JsonDocuments
  readonly journals: JsonJournal
  constructor(options: JsonlStorageOptions) {
    this.sessions = new JsonlSessions(options)
    this.documents = new JsonDocuments(options.stateDir, options.profileHome, options.sessionDir)
    this.journals = new JsonJournal(options.sessionDir, options.env)
  }
  async close(): Promise<void> {
    await this.journals.close()
    await this.sessions.close()
    await this.documents.close()
  }
}

/** `meta.json`: the commit point. Rows and offsets past `message_count` / `bytes` are uncommitted. */
interface Meta { revision: number; generation: number; message_count: number; bytes: number; doc: Record<string, unknown> }
/** `backup/backup.json`: the live meta a shrinking write replaced, and when. */
interface BackupMeta extends Meta { saved_at: number }

const META = 'meta.json'
const LINES = 'messages.jsonl'
const OFFSETS = 'messages.idx'
const BACKUP = 'backup'
const BACKUP_META = 'backup.json'
const ENTRY = 8
const SCAN_CHUNK = 64 * 1024
const generationDir = (dir: string, generation: number): string => join(dir, `gen-${String(generation)}`)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
let tmpCounter = 0

async function writeAt(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  for (let offset = 0; offset < data.length;) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, position + offset)
    if (bytesWritten <= 0) throw new Error(`short write: ${String(offset)} of ${String(data.length)} bytes`)
    offset += bytesWritten
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (bytesRead === 0) throw new Error('session log is shorter than its committed length')
    offset += bytesRead
  }
  return buffer
}

/** Lines as bytes and the offset index for them, starting at byte `base`. */
function encode(lines: readonly string[], base: number): { data: Buffer; offsets: Buffer; end: number } {
  const data = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
  const offsets = Buffer.alloc(lines.length * ENTRY)
  let position = base
  lines.forEach((line, n) => { offsets.writeBigUInt64LE(BigInt(position), n * ENTRY); position += Buffer.byteLength(line, 'utf8') + 1 })
  return { data, offsets, end: position }
}

/** The document as stored: no messages, and `message_count` (when the caller keeps one) set to the committed count. */
function storedDoc(doc: Record<string, unknown>, count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) if (key !== 'messages') out[key] = key === 'message_count' ? count : value
  return out
}

/** What a write needs, serialized when `write` is called, so later caller edits cannot reach the stored copy. */
type Edit =
  | { kind: 'unchanged' }
  | { kind: 'append'; lines: string[] }
  | { kind: 'splice'; from: number; deleteCount: number; lines: string[] }
  | { kind: 'replace'; lines: string[] }

class JsonlSessions implements SessionBackend {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  /** The JSON adapter's `_index.json` and tombstone file, kept in this backend's directory. */
  private readonly files: JsonSessions
  constructor(private readonly options: JsonlStorageOptions) {
    this.files = new JsonSessions({ directory: options.directory, now: options.now, stampingSince: options.stampingSince })
  }
  private check(): void { if (this.closed) throw new Error('Storage is closed') }
  async close(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
    this.closed = true
    await this.files.close()
  }
  private dir(sid: string): string {
    this.check()
    if (!isSafeSessionId(sid)) throw new Error(`Unsafe session_id ${JSON.stringify(sid)}`)
    return join(this.options.directory, sid)
  }
  /** Every mutation of one session runs alone, so its revision check and its commit rename see the same state. */
  private locked<T>(sid: string, operation: () => Promise<T>): Promise<T> {
    const result = withDocumentQueue(this, 'session', sid, operation)
    this.pending.add(result)
    void result.catch(() => undefined).then(() => this.pending.delete(result))
    return result
  }

  private async meta(dir: string): Promise<Meta | null> {
    try { return JSON.parse(await readFile(join(dir, META), 'utf8')) as Meta } catch (error) { if (missing(error)) return null; throw error }
  }
  /**
   * Runs `read` against the committed generation; a rewrite that removed that generation after the meta was read retries
   * against the new one.
   */
  private async committed<T>(dir: string, read: (meta: Meta) => Promise<T>): Promise<T | null> {
    for (let attempt = 0; ; attempt += 1) {
      const meta = await this.meta(dir)
      if (!meta) return null
      try { return await read(meta) } catch (error) { if (!missing(error) || attempt >= 2) throw error }
    }
  }
  /** Byte offset of row `row` in a generation of `meta`: an index entry, or the committed end. */
  private async offset(handle: FileHandle, meta: Meta, row: number): Promise<number> {
    return row >= meta.message_count ? meta.bytes : Number((await readAt(handle, row * ENTRY, ENTRY)).readBigUInt64LE(0))
  }
  /** The committed lines of rows `[start, end)` of a generation directory. */
  private async lines(path: string, meta: Meta, start: number, end: number): Promise<string[]> {
    if (start >= end) return []
    let from: number
    let to: number
    const offsets = await open(join(path, OFFSETS), 'r')
    try { from = await this.offset(offsets, meta, start); to = await this.offset(offsets, meta, end) } finally { await offsets.close() }
    const handle = await open(join(path, LINES), 'r')
    try { return (await readAt(handle, from, to - from)).toString('utf8').split('\n').slice(0, end - start) } finally { await handle.close() }
  }

  async exists(sid: string): Promise<boolean> {
    try { await stat(join(this.dir(sid), META)); return true } catch (error) { if (missing(error)) return false; throw error }
  }
  async revision(sid: string): Promise<string | null> { const meta = await this.meta(this.dir(sid)); return meta ? String(meta.revision) : null }
  async readDocument(sid: string, opts: { metadataOnly?: boolean } = {}): Promise<StoredSession | null> {
    const dir = this.dir(sid)
    return this.committed(dir, async (meta) => {
      // `meta.json` records the count, so a metadata read never opens the transcript.
      if (opts.metadataOnly) return { doc: meta.doc, messages: [], messageCount: meta.message_count, revision: String(meta.revision), metadataOnly: true }
      const messages = (await this.lines(generationDir(dir, meta.generation), meta, 0, meta.message_count)).map((line) => JSON.parse(line) as Message)
      return { doc: meta.doc, messages, messageCount: messages.length, revision: String(meta.revision), metadataOnly: false }
    })
  }
  async readMessages(sid: string, range: { start: number; end: number }): Promise<Message[]> {
    const dir = this.dir(sid)
    const rows = await this.committed(dir, async (meta) => {
      const start = Math.min(Math.max(0, range.start), meta.message_count)
      const end = Math.min(Math.max(start, range.end), meta.message_count)
      return (await this.lines(generationDir(dir, meta.generation), meta, start, end)).map((line) => JSON.parse(line) as Message)
    })
    return rows ?? []
  }

  /**
   * Reads each session's leading `depth` rows (all when 0) in order and stops at the first match.
   * ponytail: a scan with no text index; add a per-generation search sidecar file if search on this backend becomes slow.
   */
  async searchMessages(sids: readonly string[], terms: readonly string[], depth: number): Promise<Map<string, MessageMatch>> {
    const matches = new Map<string, MessageMatch>()
    for (const sid of sids) {
      try {
        const dir = this.dir(sid)
        const match = await this.committed(dir, (meta) => this.scan(generationDir(dir, meta.generation), meta, terms, depth > 0 ? Math.min(depth, meta.message_count) : meta.message_count))
        if (match) matches.set(sid, match)
      } catch { /* unreadable sessions cannot match */ }
    }
    return matches
  }
  private async scan(path: string, meta: Meta, terms: readonly string[], rows: number): Promise<MessageMatch | null> {
    if (rows === 0) return null
    let end = meta.bytes
    if (rows < meta.message_count) {
      const offsets = await open(join(path, OFFSETS), 'r')
      try { end = await this.offset(offsets, meta, rows) } finally { await offsets.close() }
    }
    return withSessionPrefixRead(async () => {
      const handle = await open(join(path, LINES), 'r')
      try {
        // The current row's pieces, joined once at its newline, so a row longer than a chunk is copied once.
        let pieces: Buffer[] = []
        let idx = 0
        for (let position = 0; position < end && idx < rows;) {
          const chunk = await readAt(handle, position, Math.min(SCAN_CHUNK, end - position))
          position += chunk.length
          // A newline byte never occurs inside a UTF-8 sequence, so splitting bytes on it keeps every character whole.
          let start = 0
          for (let newline = chunk.indexOf(10); newline >= 0 && idx < rows; newline = chunk.indexOf(10, start)) {
            pieces.push(chunk.subarray(start, newline))
            const line = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces)
            pieces = []
            const entry = sessionSearchEntry(JSON.parse(line.toString('utf8')), idx)
            if (sessionSearchMatches(entry.text, terms)) return { idx, ...entry }
            idx += 1
            start = newline + 1
          }
          if (start < chunk.length) pieces.push(chunk.subarray(start))
        }
        return null
      } finally { await handle.close() }
    })
  }

  async write(sid: string, change: SessionChange, expected: string | null): Promise<string> {
    const dir = this.dir(sid)
    if (change.doc.session_id !== sid) throw new Error('Session document identity does not match its key')
    const doc = JSON.parse(JSON.stringify(storedDoc(change.doc, 0))) as Record<string, unknown>
    const serialize = (rows: readonly Message[]): string[] => rows.map((row) => JSON.stringify(row))
    const all = change.all ? (change.serializedRows?.length === change.all.length ? [...change.serializedRows] : serialize(change.all)) : null
    const m = change.messages
    const edit: Edit = m.kind === 'unchanged' ? m : m.kind === 'splice' ? { kind: 'splice', from: m.from, deleteCount: m.deleteCount, lines: serialize(m.rows) } : { kind: m.kind, lines: serialize(m.rows) }
    return this.locked(sid, async () => {
      const meta = await this.meta(dir)
      if ((meta ? String(meta.revision) : null) !== expected) throw new RevisionConflict(sid)
      if (meta && edit.kind === 'unchanged') return this.publish(dir, { ...meta, revision: nextRevision(meta.revision), doc: storedDoc(doc, meta.message_count) })
      if (meta && edit.kind === 'append') return this.append(dir, meta, doc, edit.lines)
      let lines = all
      if (!lines) {
        const base = meta ? await this.lines(generationDir(dir, meta.generation), meta, 0, meta.message_count) : []
        lines = edit.kind === 'replace' ? edit.lines : edit.kind === 'append' ? edit.lines : edit.kind === 'splice' ? [...base.slice(0, edit.from), ...edit.lines, ...base.slice(edit.from + edit.deleteCount)] : base
      }
      return this.rewrite(dir, meta, doc, lines, { backup: true })
    })
  }

  /** Appends rows and offsets past the committed end, fsyncs both, then commits them with `meta.json`. */
  private async append(dir: string, meta: Meta, doc: Record<string, unknown>, lines: string[]): Promise<string> {
    const path = generationDir(dir, meta.generation)
    const { data, offsets, end } = encode(lines, meta.bytes)
    const log = await open(join(path, LINES), 'r+')
    try {
      // Bytes past the committed end belong to a write that crashed before its commit.
      await log.truncate(meta.bytes)
      await writeAt(log, data, meta.bytes)
      const index = await open(join(path, OFFSETS), 'r+')
      try {
        await index.truncate(meta.message_count * ENTRY)
        await writeAt(index, offsets, meta.message_count * ENTRY)
        await log.sync()
        await index.sync()
      } finally { await index.close() }
    } finally { await log.close() }
    const count = meta.message_count + lines.length
    return this.publish(dir, { ...meta, revision: nextRevision(meta.revision), message_count: count, bytes: end, doc: storedDoc(doc, count) })
  }

  /**
   * Writes the whole transcript as the next generation and commits it with `meta.json`; until that rename the old
   * generation stays authoritative. A shrinking write keeps the old generation as `backup/`.
   * ponytail: a splice rewrites the whole session; add per-segment files if splice-heavy sessions appear.
   */
  private async rewrite(dir: string, meta: Meta | null, doc: Record<string, unknown>, lines: string[], opts: { backup: boolean }): Promise<string> {
    const generation = (meta?.generation ?? 0) + 1
    const next = generationDir(dir, generation)
    await rm(next, { recursive: true, force: true })
    await mkdir(next, { recursive: true })
    const { data, offsets, end } = encode(lines, 0)
    await this.writeFile(join(next, LINES), data)
    await this.writeFile(join(next, OFFSETS), offsets)
    const previous = meta && generationDir(dir, meta.generation)
    const shrink = opts.backup && meta !== null && lines.length < meta.message_count
    if (shrink) await this.writeFile(join(previous!, BACKUP_META), Buffer.from(JSON.stringify({ ...meta, saved_at: this.options.now() } satisfies BackupMeta)))
    const revision = await this.publish(dir, { revision: nextRevision(meta?.revision ?? null), generation, message_count: lines.length, bytes: end, doc: storedDoc(doc, lines.length) })
    // Committed; what follows only tidies. Like the JSON `.bak`, the backup is best effort.
    try {
      if (shrink) {
        await rm(join(dir, BACKUP), { recursive: true, force: true })
        await rename(previous!, join(dir, BACKUP))
      }
      for (const name of await readdir(dir)) if (name !== META && name !== BACKUP && name !== `gen-${String(generation)}`) await rm(join(dir, name), { recursive: true, force: true })
    } catch { /* a stale generation is never read and the next rewrite removes it */ }
    return revision
  }

  private async writeFile(path: string, data: Buffer): Promise<void> {
    const handle = await open(path, 'w')
    try { await writeAt(handle, data, 0); await handle.sync() } finally { await handle.close() }
  }
  /** The commit point: a fsynced `meta.json` renamed into place. */
  private async publish(dir: string, meta: Meta): Promise<string> {
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `${META}.tmp.${String(process.pid)}.${String(++tmpCounter)}`)
    try {
      await this.writeFile(tmp, Buffer.from(JSON.stringify(meta)))
      await rename(tmp, join(dir, META))
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    return String(meta.revision)
  }

  async delete(sid: string, opts: { tombstone: boolean }): Promise<boolean> {
    const dir = this.dir(sid)
    return this.locked(sid, async () => {
      try { await rm(dir, { recursive: true, force: true }) } catch { return false }
      if (opts.tombstone) await this.files.tombstones.add(sid)
      return true
    })
  }
  async ids(opts: { strict?: boolean } = {}): Promise<Set<string>> {
    this.check()
    let names: string[]
    try { names = await readdir(this.options.directory) } catch (error) {
      if (opts.strict && !missing(error)) throw error
      return new Set()
    }
    return new Set(names.filter((name) => !name.startsWith('_') && isSafeSessionId(name) && existsSync(join(this.options.directory, name, META))))
  }
  hasIndex(): Promise<boolean> { this.check(); return this.files.hasIndex() }
  index(): Promise<{ entries: SessionIndexEntry[]; revision: string }> { this.check(); return this.files.index() }
  writeIndex(entries: SessionIndexEntry[]): Promise<void> { this.check(); return this.files.writeIndex(entries) }
  get tombstones(): SessionBackend['tombstones'] { this.check(); return this.files.tombstones }

  private async backupMeta(dir: string): Promise<BackupMeta | null> {
    try { return JSON.parse(await readFile(join(dir, BACKUP, BACKUP_META), 'utf8')) as BackupMeta } catch (error) { if (missing(error)) return null; throw error }
  }
  /** The live meta, null when absent; `present` with a null meta when it exists but cannot be read, which recovery restores over. */
  private async liveMeta(dir: string): Promise<{ meta: Meta | null; present: boolean }> {
    try { const meta = await this.meta(dir); return { meta, present: meta !== null } } catch { return { meta: null, present: true } }
  }
  /** The live session and its backup as the shared restore rule reads them; only transcript lengths matter to it. */
  private async backupState(dir: string, sid: string, stampingSince: number) {
    const backup = await this.backupMeta(dir)
    if (!backup) return null
    const { meta: live, present } = await this.liveMeta(dir)
    const withMessages = (meta: Meta) => ({ ...meta.doc, messages: Array.from({ length: meta.message_count }) })
    return { live, present, backup, status: backupStatus(sid, live && withMessages(live), withMessages(backup), backup.saved_at, stampingSince) }
  }
  private async restore(sid: string, guard?: (live: Meta | null, backup: BackupMeta) => boolean): Promise<boolean> {
    if (!isSafeSessionId(sid)) return false
    const dir = this.dir(sid)
    const stampingSince = await this.options.stampingSince()
    return this.locked(sid, async () => {
      const found = await this.backupState(dir, sid, stampingSince)
      if (found?.status.recommend !== 'restore' || (guard && !guard(found.live, found.backup))) return false
      // Like the JSON adapter's `.bak` publication: the backup becomes the session as it was saved, and stays.
      const lines = await this.lines(join(dir, BACKUP), found.backup, 0, found.backup.message_count)
      await this.rewrite(dir, found.live, found.backup.doc, lines, { backup: false })
      return true
    })
  }
  readonly shrinkBackup = {
    discard: async (sid: string): Promise<void> => { const dir = this.dir(sid); await this.locked(sid, () => rm(join(dir, BACKUP), { recursive: true, force: true })) },
    restore: async (sid: string): Promise<boolean> => this.restore(sid),
    read: async (sid: string): Promise<ShrinkBackup | null> => {
      const dir = this.dir(sid)
      const backup = await this.backupMeta(dir)
      if (!backup) return null
      const messages = (await this.lines(join(dir, BACKUP), backup, 0, backup.message_count)).map((line) => JSON.parse(line) as Message)
      return { doc: backup.doc, messages, savedAt: backup.saved_at }
    },
    write: async (sid: string, backup: ShrinkBackup): Promise<void> => {
      const dir = this.dir(sid)
      const lines = backup.messages.map((row) => JSON.stringify(row))
      const doc = JSON.parse(JSON.stringify(storedDoc(backup.doc, lines.length))) as Record<string, unknown>
      await this.locked(sid, async () => {
        const staged = join(dir, `${BACKUP}.tmp.${String(process.pid)}.${String(++tmpCounter)}`)
        await mkdir(staged, { recursive: true })
        const { data, offsets, end } = encode(lines, 0)
        await this.writeFile(join(staged, LINES), data)
        await this.writeFile(join(staged, OFFSETS), offsets)
        const meta: BackupMeta = { revision: nextRevision(null), generation: 0, message_count: lines.length, bytes: end, doc, saved_at: backup.savedAt }
        await this.writeFile(join(staged, BACKUP_META), Buffer.from(JSON.stringify(meta)))
        await rm(join(dir, BACKUP), { recursive: true, force: true })
        await rename(staged, join(dir, BACKUP))
      })
    },
  }

  async diagnose(): Promise<StorageIssue[]> {
    this.check()
    const stampingSince = await this.options.stampingSince()
    let names: string[] = []
    try { names = (await readdir(this.options.directory)).filter((name) => !name.startsWith('_') && isSafeSessionId(name)).sort() } catch { /* empty */ }
    const issues: StorageIssue[] = []
    const counts = new Map<string, number>()
    for (const sid of names) {
      const dir = join(this.options.directory, sid)
      const { meta: live, present } = await this.liveMeta(dir)
      if (present) counts.set(sid, live?.message_count ?? -1)
      // An unreadable backup cannot be restored.
      const found = await this.backupState(dir, sid, stampingSince).catch(() => null)
      if (!found) continue
      const base = { session_id: sid, live_messages: found.status.live_messages, bak_messages: found.status.bak_messages, profile: str((live ?? found.backup).doc.profile) || 'default', revision: live ? String(live.revision) : null, backupRevision: String(found.backup.revision) }
      if (present) { const issue = backupIssue(found.status, base); if (issue) issues.push(issue) }
      else issues.push({ ...base, kind: 'orphan_backup', category: 'repairable', recommendation: 'restore_from_bak' })
    }
    if (await this.files.hasIndex()) {
      let indexed: Set<string> | null = null
      try { indexed = new Set((await this.files.index()).entries.map((e) => e.session_id).filter((id): id is string => typeof id === 'string')) } catch { /* reported as unreadable */ }
      issues.push(...indexIssues(indexed, new Set(counts.keys()), (sid) => counts.get(sid) ?? -1))
    }
    return issues
  }
  async repair(issue: StorageIssue): Promise<boolean> {
    this.check()
    if (issue.recommendation !== 'restore_from_bak') return false
    return this.restore(issue.session_id, (live, backup) => (live ? String(live.revision) : null) === (issue.revision ?? null) && String(backup.revision) === issue.backupRevision)
  }
}
