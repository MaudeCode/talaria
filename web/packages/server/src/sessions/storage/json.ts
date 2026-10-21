/* eslint-disable @typescript-eslint/require-await -- The JSON adapter deliberately keeps each file transaction synchronous behind the async port. */
import { JsonJournal } from './json-journal.js'
import { JsonDocuments } from './json-documents.js'
import { dirname } from 'node:path'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeSessionId, type Message } from '../session.js'
import { RevisionConflict, type MessageMatch, type SessionBackend, type SessionChange, type SessionIndexEntry, type StorageBackend, type StorageIssue, type StoredSession } from './backend.js'
import { readJsonMessagePrefix, readMetadataJsonPrefixWithSignature, statSignature, statSignatureAsync, writeAtomic } from './json-files.js'
import { sessionSearchMatches, sessionSearchMessageText } from './search-text.js'
import { diagnoseJson, repairJson, restoreJsonBackup } from './json-recovery.js'

export interface JsonStorageOptions { directory: string; stateDir?: string; profileHome?: (profile: string) => string; env?: Record<string, string | undefined>; now: () => number; stampingSince: () => number | Promise<number> }

export class JsonStorage implements StorageBackend {
  readonly kind = 'json'
  readonly sessions: JsonSessions
  readonly documents: JsonDocuments
  readonly journals: JsonJournal
  readonly directory: string
  constructor(options: JsonStorageOptions) {
    this.directory = options.directory
    this.sessions = new JsonSessions(options)
    this.documents = new JsonDocuments(options.stateDir ?? dirname(options.directory), options.profileHome, options.directory)
    this.journals = new JsonJournal(options.directory, options.env)
  }
  async close(): Promise<void> {
    await this.journals.close()
    this.sessions.closed = true
    await this.documents.close()
  }
}

// ponytail: fixed entry cap without eviction, so a larger library keeps its first sessions warm; add LRU if hit rates matter.
const SEARCH_TEXT_CACHE_MAX = 5000
/** Clients search 5 leading messages; a deeper (or whole-transcript, depth 0) search is read but never kept resident. */
const SEARCH_TEXT_CACHE_DEPTH_MAX = 20

class JsonSessions implements SessionBackend {
  closed = false
  private parsedIndex: { revision: string; entries: SessionIndexEntry[] } | null = null
  /** TAL-1212: each session's leading-message search text, valid while its file keeps the recorded revision. */
  private readonly searchTexts = new Map<string, { revision: string; depth: number; texts: string[] }>()
  constructor(private readonly options: JsonStorageOptions) {}
  private check(): void { if (this.closed) throw new Error('Storage is closed') }
  private path(sid: string): string {
    this.check()
    if (!isSafeSessionId(sid)) throw new Error(`Unsafe session_id ${JSON.stringify(sid)}`)
    return join(this.options.directory, `${sid}.json`)
  }
  private get indexPath(): string { this.check(); return join(this.options.directory, '_index.json') }
  private get tombstonePath(): string { this.check(); return join(this.options.directory, '_deleted_webui_sessions.json') }
  async exists(sid: string): Promise<boolean> {
    try { lstatSync(this.path(sid)); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  async revision(sid: string): Promise<string | null> { return statSignature(this.path(sid)) }
  async readDocument(sid: string, opts: { metadataOnly?: boolean } = {}): Promise<StoredSession | null> {
    const path = this.path(sid)
    if (!existsSync(path)) return null
    if (opts.metadataOnly) {
      try {
        const { prefix, signature } = readMetadataJsonPrefixWithSignature(path)
        if (prefix) {
          const doc = JSON.parse(prefix) as Record<string, unknown>
          const count = doc.message_count
          const known = typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null
          if (['session_id', 'title', 'created_at', 'updated_at'].every((key) => key in doc) && (known !== null || 'anchor_scene_index' in doc)) {
            return { doc, messageCount: known, revision: signature, metadataOnly: true }
          }
        }
      } catch { /* legacy document: use a full stable read */ }
    }
    let doc: Record<string, unknown> = {}
    let revision: string | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = statSignature(path)
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      doc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      const after = statSignature(path)
      if (before !== null && before === after) { revision = after; break }
    }
    const messageCount = Array.isArray(doc.messages) ? doc.messages.length : 0
    delete doc.messages
    return { doc, messageCount, revision, metadataOnly: false }
  }
  async readMessages(sid: string, range: { start: number; end: number }): Promise<Message[]> {
    const path = this.path(sid)
    if (!existsSync(path)) return []
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return Array.isArray(doc.messages) ? (doc.messages as Message[]).slice(Math.max(0, range.start), Math.max(0, range.end)) : []
  }
  /** The leading `depth` messages (all when 0), parsed without reading or parsing the rest of the file. */
  private async readMessagePrefix(sid: string, depth: number): Promise<{ rows: Message[]; revision: string }> {
    const { rows, signature } = await readJsonMessagePrefix(this.path(sid), depth || Infinity)
    return { rows: rows as Message[], revision: signature }
  }
  async searchMessages(sids: readonly string[], terms: readonly string[], depth: number): Promise<Map<string, MessageMatch>> {
    const matches = new Map<string, MessageMatch>()
    for (const sid of sids) {
      try {
        const texts = await this.searchText(sid, depth)
        const idx = texts.findIndex((text) => sessionSearchMatches(text, terms))
        if (idx >= 0) matches.set(sid, { idx, text: texts[idx]! })
      } catch { /* unreadable sessions cannot match */ }
    }
    return matches
  }
  private async searchText(sid: string, depth: number): Promise<string[]> {
    const revision = await statSignatureAsync(this.path(sid))
    if (revision === null) return []
    const cached = this.searchTexts.get(sid)
    if (cached?.revision === revision && cached.depth === depth) return cached.texts
    const prefix = await this.readMessagePrefix(sid, depth)
    const texts = prefix.rows.map(sessionSearchMessageText)
    if (depth > 0 && depth <= SEARCH_TEXT_CACHE_DEPTH_MAX && (cached || this.searchTexts.size < SEARCH_TEXT_CACHE_MAX)) this.searchTexts.set(sid, { revision: prefix.revision, depth, texts })
    return texts
  }
  async write(sid: string, change: SessionChange, expected: string | null): Promise<string> {
    const path = this.path(sid)
    if (change.doc.session_id !== sid) throw new Error('Session document identity does not match its key')
    if (statSignature(path) !== expected) throw new RevisionConflict(sid)
    const edit = change.messages
    // Appends and growing splices cannot shrink the file, so with the full list in hand there is no base to re-read.
    const mayShrink = edit.kind === 'replace' || (edit.kind === 'splice' && edit.deleteCount > edit.rows.length)
    let previous: Record<string, unknown> | null = null
    let previousText: string | null = null
    if ((!change.all || mayShrink) && existsSync(path)) {
      previousText = readFileSync(path, 'utf8')
      try { previous = JSON.parse(previousText) as Record<string, unknown> } catch { /* a replacement may repair corruption */ }
    }
    let rows: Message[] = Array.isArray(previous?.messages) ? [...previous.messages as Message[]] : []
    if (change.all) rows = change.all
    else if (edit.kind === 'replace') rows = [...edit.rows]
    else if (edit.kind === 'append') rows = rows.concat(edit.rows)
    else if (edit.kind === 'splice') rows = [...rows.slice(0, edit.from), ...edit.rows, ...rows.slice(edit.from + edit.deleteCount)]
    const document: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(change.doc)) {
      if (key === 'messages') continue
      document[key] = key === 'message_count' ? rows.length : value
      if (key === 'anchor_scene_index') document.messages = rows
    }
    document.messages ??= rows
    const payload = JSON.stringify(document)
    mkdirSync(this.options.directory, { recursive: true })
    if (previousText !== null && Array.isArray(previous?.messages) && previous.messages.length > rows.length) {
      try { writeAtomic(`${path}.bak`, previousText) } catch { /* backup is best effort */ }
    }
    this.searchTexts.delete(sid)
    writeAtomic(path, payload)
    return statSignature(path)!
  }
  async delete(sid: string, opts: { tombstone: boolean }): Promise<boolean> {
    const path = this.path(sid)
    this.searchTexts.delete(sid)
    try { rmSync(path, { force: true }) } catch { return false }
    if (existsSync(path)) return false
    try { rmSync(`${path}.bak`, { force: true }) } catch { /* best effort */ }
    if (opts.tombstone) this.addTombstone(sid)
    return true
  }
  async ids(opts: { strict?: boolean } = {}): Promise<Set<string>> {
    this.check()
    try { return new Set(readdirSync(this.options.directory).filter((n) => n.endsWith('.json') && !n.startsWith('_')).map((n) => n.slice(0, -5))) }
    catch (error) {
      if (opts.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return new Set()
    }
  }
  async hasIndex(): Promise<boolean> { return existsSync(this.indexPath) }
  async index(): Promise<{ entries: SessionIndexEntry[]; revision: string }> {
    const revision = statSignature(this.indexPath)
    if (revision !== null && this.parsedIndex?.revision === revision) return { entries: [...this.parsedIndex.entries], revision }
    const entries = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown
    if (!Array.isArray(entries)) throw new Error('session index must be a list')
    if (revision !== null && revision === statSignature(this.indexPath)) this.parsedIndex = { entries: entries as SessionIndexEntry[], revision }
    return { entries: entries as SessionIndexEntry[], revision: revision ?? '' }
  }
  async writeIndex(entries: SessionIndexEntry[]): Promise<void> {
    mkdirSync(this.options.directory, { recursive: true })
    for (const name of readdirSync(this.options.directory)) {
      if (!name.includes('.tmp.')) continue
      const path = join(this.options.directory, name)
      try { if (statSync(path).mtimeMs / 1000 < this.options.now() - 3600) unlinkSync(path) } catch { /* best effort */ }
    }
    writeAtomic(this.indexPath, JSON.stringify(entries))
    this.parsedIndex = { entries, revision: statSignature(this.indexPath)! }
  }
  private allTombstones(): Set<string> {
    try {
      if (!existsSync(this.tombstonePath)) return new Set()
      const raw = JSON.parse(readFileSync(this.tombstonePath, 'utf8')) as Record<string, unknown>
      if (!raw || typeof raw !== 'object' || Number(raw.version) !== 1 || !Array.isArray(raw.ids)) return new Set()
      return new Set(raw.ids.map((v) => String(v ?? '').trim()).filter(Boolean))
    } catch { return new Set() }
  }
  private saveTombstones(ids: Set<string>): void {
    try {
      mkdirSync(this.options.directory, { recursive: true })
      writeAtomic(this.tombstonePath, JSON.stringify({ version: 1, ids: [...ids].sort().slice(-1000) }, null, 2))
    } catch { /* legacy best effort */ }
  }
  private addTombstone(sid: string): void {
    const ids = this.allTombstones()
    if (ids.has(sid)) return
    ids.add(sid)
    this.saveTombstones(ids)
  }
  readonly tombstones = {
    has: async (sid: string): Promise<boolean> => this.allTombstones().has(sid),
    all: async (): Promise<Set<string>> => this.allTombstones(),
    add: async (sid: string): Promise<void> => { this.addTombstone(sid) },
    remove: async (sid: string): Promise<void> => {
      const ids = this.allTombstones()
      if (!ids.delete(sid)) return
      if (ids.size) this.saveTombstones(ids)
      else rmSync(this.tombstonePath, { force: true })
    },
  }
  readonly shrinkBackup = {
    discard: async (sid: string): Promise<void> => { rmSync(`${this.path(sid)}.bak`, { force: true }) },
    restore: async (sid: string): Promise<boolean> => restoreJsonBackup(this.options.directory, sid, await this.options.stampingSince()),
  }
  async diagnose(): Promise<StorageIssue[]> { this.check(); return diagnoseJson(this.options.directory, await this.options.stampingSince()) }
  async repair(issue: StorageIssue): Promise<boolean> { this.check(); return repairJson(this.options.directory, issue, await this.options.stampingSince()) }
}
