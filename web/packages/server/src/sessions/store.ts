import { str } from '../util.js'
/**
 * The WebUI session store (Python `api/models.py`): `sessions/<sid>.json`
 * sidecars written atomically with a `.bak` on shrink, the sorted
 * `sessions/_index.json` sidebar index with incremental patching, a bounded
 * LRU of resident sessions that never evicts active or unsaved work, the
 * deleted-session tombstone, composer draft overlays, and per-session
 * mutation locks.
 *
 * The state.db projection (CLI sessions, lineage metadata, transcript
 * reconciliation) is not part of this store; it layers on in the sidebar
 * builder once the read-only SQLite projection lands.
 */
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { basename, join } from 'node:path'
import { sanitizeSessionRow } from './list.js'
import type { DraftStore } from './drafts.js'
import type { SessionEventBus } from './events.js'
import { anchorSceneIndexFromRecords, collapseAdjacentDuplicatePartials, isSafeSessionId, Session, type SessionDefaults, type SessionInit } from './session.js'

export class SessionNotFound extends Error {
  constructor(readonly sid: string) {
    super(`Session not found: ${sid}`)
    this.name = 'SessionNotFound'
  }
}

export interface SessionStoreDeps {
  sessionDir: string
  drafts: DraftStore
  events: SessionEventBus
  /** Defaults for a brand-new session (last workspace of the profile, effective default model). */
  defaults: (profile: string | null) => SessionDefaults
  activeStreamIds: () => Set<string>
  now: () => number
  log: (line: string) => void
  cacheMax: () => number
  /** TAL-372: a deleted session's other in-memory state goes with it. */
  onDeleted?: (sid: string) => void
}

const LOAD_STABLE_READ_ATTEMPTS = 3
const UNSAVED_SHELL_GRACE_S = 1800
const STALE_TMP_AGE_S = 3600
const DELETED_TOMBSTONE_CAP = 1000
const DELETED_TOMBSTONE_VERSION = 1
let tmpCounter = 0

function tmpName(path: string): string {
  return `${path}.tmp.${process.pid}.${++tmpCounter}`
}

function writeAtomic(path: string, text: string): void {
  const tmp = tmpName(path)
  const fd = openSync(tmp, 'w')
  try {
    writeFully(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    renameSync(tmp, path)
  } catch (error) {
    try { closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(tmp) } catch { /* gone */ }
    throw error
  }
}

export function statSignature(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${path}:${st.mtimeNs}:${st.size}:${st.ctimeNs}`
  } catch {
    return null
  }
}

/** Python `_read_metadata_json_prefix`: everything before the top-level `messages` (or `anchor_activity_scenes`) key. */
export function readMetadataJsonPrefix(path: string, maxBytes = 1024 * 1024): string | null {
  return readMetadataJsonPrefixWithSignature(path, maxBytes).prefix
}

/**
 * The metadata prefix together with the signature of the inode it was read from (fstat of the open descriptor), so a
 * file atomically replaced during the read is never cached under the replacement's identity.
 */
export function readMetadataJsonPrefixWithSignature(path: string, maxBytes = 1024 * 1024): { prefix: string | null; signature: string } {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd, { bigint: true })
    const signature = `${path}:${st.mtimeNs}:${st.size}:${st.ctimeNs}`
    return { prefix: readPrefixFromFd(fd, maxBytes, Math.min(64 * 1024, maxBytes)), signature }
  } finally {
    closeSync(fd)
  }
}

function readPrefixFromFd(fd: number, maxBytes: number, initialStage: number): string | null {
  let stage = initialStage
  {
    let raw = Buffer.alloc(0)
    let text = ''
    let stopPos: number | null = null
    while (raw.length < maxBytes) {
      const chunk = Buffer.alloc(Math.min(stage, maxBytes - raw.length))
      const n = readSyncFully(fd, chunk)
      if (n === 0) return null
      raw = Buffer.concat([raw, chunk.subarray(0, n)])
      text = raw.toString('utf8')
      const messagesPos = findTopLevelJsonKey(text, 'messages')
      const scenesPos = findTopLevelJsonKey(text, 'anchor_activity_scenes')
      stopPos = messagesPos
      if (scenesPos !== null && (stopPos === null || scenesPos < stopPos)) stopPos = scenesPos
      if (stopPos !== null) break
      stage *= 2
    }
    if (stopPos === null) return null
    let prefix = text.slice(0, stopPos).trimEnd()
    if (prefix.endsWith(',')) prefix = prefix.slice(0, -1).trimEnd()
    return `${prefix}\n}`
  }
}

import { readSync } from 'node:fs'
function readSyncFully(fd: number, buf: Buffer): number {
  let total = 0
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, null)
    if (n === 0) break
    total += n
  }
  return total
}

/** Offset of `"key":` at JSON nesting depth 1, or null. */
export function findTopLevelJsonKey(text: string, key: string): number | null {
  let depth = 0
  let inString = false
  let escape = false
  let stringStart = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') {
        inString = false
        if (depth === 1 && text.slice(stringStart + 1, i) === key) {
          let j = i + 1
          while (j < text.length && /\s/.test(text[j] ?? '')) j += 1
          if (text[j] === ':') return stringStart
        }
      }
      continue
    }
    if (ch === '"') { inString = true; stringStart = i; continue }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
  }
  return null
}

export function readPersistedMessageCount(path: string): number | null {
  try {
    const prefix = readMetadataJsonPrefix(path)
    if (!prefix) return null
    const value = (JSON.parse(prefix) as Record<string, unknown>).message_count
    if (typeof value === 'boolean') return null
    const n = Number(value)
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export class SessionStore {
  readonly sessionDir: string
  readonly indexFile: string
  /** Resident sessions in LRU order (oldest first). */
  readonly sessions = new Map<string, Session>()
  private readonly locks = new Map<string, Promise<void>>()
  private persistedIdsCache: { mtimeNs: bigint | null; ids: Set<string> } | null = null
  private parsedIndexCache: { signature: string; entries: Record<string, unknown>[] } | null = null
  private indexFlush: Promise<void> | null = null
  private indexPending = new Map<string, Record<string, unknown>>()

  constructor(readonly deps: SessionStoreDeps) {
    this.sessionDir = deps.sessionDir
    this.indexFile = join(deps.sessionDir, '_index.json')
  }

  pathFor(sid: string): string {
    return join(this.sessionDir, `${sid}.json`)
  }

  // ── locks ────────────────────────────────────────────────────────────────

  /** Serialize one session's read-modify-write sequences (Python `_get_session_agent_lock`). */
  async withLock<T>(sid: string, fn: () => Promise<T> | T, opts: { timeoutMs?: number } = {}): Promise<T> {
    const previous = this.locks.get(sid) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chained = previous.then(() => current)
    this.locks.set(sid, chained)
    if (opts.timeoutMs !== undefined) {
      const acquired = await Promise.race([previous.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => { resolve(false) }, opts.timeoutMs))])
      if (!acquired) {
        release()
        throw new SessionBusy(sid)
      }
    } else {
      await previous
    }
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(sid) === chained) this.locks.delete(sid)
    }
  }

  // ── creation / resolution ────────────────────────────────────────────────

  private construct(init: SessionInit, profile: string | null): Session {
    const session = new Session(init, this.deps.defaults(profile))
    // New-session defaults must not replace the title supplied by the read projection.
    if (typeof init.title === 'string') session.title = init.title
    return session
  }

  /** In-memory only until the first message is persisted (Python `new_session`). */
  newSession(opts: { workspace?: string | null; model?: string | null; modelProvider?: string | null; profile?: string | null; projectId?: string | null; worktree?: { path: string; branch: string; repo_root: string; created_at: number } | null; enabledToolsets?: string[] | null } = {}): Session {
    const profile = opts.profile ?? null
    const defaults = this.deps.defaults(profile)
    const wt = opts.worktree ?? null
    const s = new Session(
      {
        workspace: (wt ? wt.path : opts.workspace) || defaults.workspace,
        model: opts.model ?? defaults.model,
        model_provider: opts.model ? opts.modelProvider ?? null : opts.modelProvider ?? null,
        profile,
        project_id: opts.projectId ?? null,
        personality: null,
        worktree_path: wt?.path ?? null,
        worktree_branch: wt?.branch ?? null,
        worktree_repo_root: wt?.repo_root ?? null,
        worktree_created_at: wt?.created_at ?? null,
        enabled_toolsets: opts.enabledToolsets ?? null,
      },
      defaults,
    )
    this.clearDeletedTombstone(s.session_id)
    this.touch(s)
    if (wt) this.save(s)
    return s
  }

  /** Insert or refresh a session in the LRU and evict over the cap. */
  touch(session: Session): void {
    this.sessions.delete(session.session_id)
    this.sessions.set(session.session_id, session)
    this.evictOverCap()
  }

  load(sid: string): Session | null {
    if (!isSafeSessionId(sid)) return null
    const path = this.pathFor(sid)
    if (!existsSync(path)) return null
    // Another process may replace the file atomically while we read it: retry until one read is bracketed by the
    // same signature. A read that never stabilises keeps a null signature, which `cachedLagsDisk` treats as stale.
    let data: Record<string, unknown> = {}
    let signature: string | null = null
    for (let attempt = 0; attempt < LOAD_STABLE_READ_ATTEMPTS; attempt += 1) {
      const preSig = statSignature(path)
      data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const postSig = statSignature(path)
      if (preSig !== null && preSig === postSig) { signature = postSig; break }
    }
    const clean = sanitizeSessionRow(data, this, basename(path))
    if (!clean) return null
    data = clean
    const [messages, collapsed] = collapseAdjacentDuplicatePartials(data.messages)
    data.messages = messages
    const session = this.construct(data, (data.profile as string | null | undefined) ?? null)
    if (collapsed) {
      try { this.save(session, { touchUpdatedAt: false, skipIndex: true }) } catch { /* best effort */ }
    } else {
      session.sidecarLoadedSignature = signature
    }
    try {
      session.composer_draft = this.deps.drafts.read(sid, session.composer_draft)
    } catch { /* ignore */ }
    return session
  }

  loadMetadataOnly(sid: string, opts: { indexMessageCounts?: Map<string, number> } = {}): Session | null {
    if (!isSafeSessionId(sid)) return null
    const path = this.pathFor(sid)
    if (!existsSync(path)) return null
    try {
      const { prefix, signature } = readMetadataJsonPrefixWithSignature(path)
      if (!prefix) return this.load(sid)
      const parsed = sanitizeSessionRow(JSON.parse(prefix) as Record<string, unknown>, this, basename(path))
      if (!parsed) return null
      for (const key of ['session_id', 'title', 'created_at', 'updated_at']) if (!(key in parsed)) return this.load(sid)
      const sidecarCount = parsed.message_count
      const modernCount = typeof sidecarCount === 'number' && Number.isInteger(sidecarCount) && sidecarCount >= 0 ? sidecarCount : null
      if (modernCount === null && !('anchor_scene_index' in parsed)) return this.load(sid)
      parsed.messages = []
      parsed.tool_calls = []
      const session = this.construct(parsed, (parsed.profile as string | null | undefined) ?? null)
      let indexCount: number | null = null
      if (modernCount === null) indexCount = (opts.indexMessageCounts ?? this.indexMessageCounts()).get(sid) ?? null
      const known = [indexCount, modernCount].filter((c): c is number => c !== null)
      session.metadataMessageCount = known.length ? Math.max(...known) : null
      session.loadedMetadataOnly = true
      session.sidecarLoadedSignature = signature
      return session
    } catch {
      return this.load(sid)
    }
  }

  /** Resolve a session through the cache with disk-freshness checks (Python `get_session`). Throws `SessionNotFound`. */
  get(sid: string, opts: { metadataOnly?: boolean; promote?: boolean; cacheOnMiss?: boolean } = {}): Session {
    const cached = this.sessions.get(sid)
    if (cached) {
      if (cached.session_id !== sid) {
        this.deps.log(`[webui] WARNING: evicting mismatched cached session: requested ${sid} but cached object is ${cached.session_id}`)
        this.sessions.delete(sid)
      } else {
        if (opts.promote ?? true) { this.sessions.delete(sid); this.sessions.set(sid, cached) }
        const lags = this.cachedLagsDisk(cached)
        // A persisted session whose file vanished was deleted underneath us: evict it so nothing recreates the sidecar.
        if (lags && !existsSync(this.pathFor(sid))) { this.sessions.delete(sid); throw new SessionNotFound(sid) }
        // A sidebar-only stub (metadata load) must be upgraded to the full transcript when messages are requested.
        if (!opts.metadataOnly && (cached.loadedMetadataOnly || lags)) {
          const fresh = this.load(sid)
          if (fresh) {
            this.sessions.set(sid, fresh)
            return fresh
          }
        }
        return cached
      }
    }
    const loaded = opts.metadataOnly ? this.loadMetadataOnly(sid) : this.load(sid)
    if (!loaded) throw new SessionNotFound(sid)
    if (opts.cacheOnMiss ?? true) this.touch(loaded)
    return loaded
  }

  /** Reload a metadata-only stub before mutating persisted fields (Python `_ensure_full_session_before_mutation`). */
  ensureFull(sid: string, session: Session): Session {
    if (!session.loadedMetadataOnly) return session
    const full = this.load(sid)
    if (!full) throw new SessionNotFound(sid)
    this.touch(full)
    return full
  }

  /** A cached full session is stale when its sidecar changed on disk and it carries no unsaved runtime state. */
  private cachedLagsDisk(cached: Session): boolean {
    if (cached.active_stream_id || cached.pending_user_message || cached.pending_started_at) return false
    const current = statSignature(this.pathFor(cached.session_id))
    // A session that was persisted and whose file has since vanished was deleted underneath us: it is stale, and the
    // reload's miss evicts it rather than letting a later mutation recreate the deleted sidecar.
    if (current === null) return cached.sidecarLoadedSignature !== null
    // An unknown read identity (the file changed underneath the load) must not be trusted: reload it.
    if (cached.sidecarLoadedSignature === null) return true
    return current !== cached.sidecarLoadedSignature
  }

  // ── persistence ──────────────────────────────────────────────────────────

  save(session: Session, opts: { touchUpdatedAt?: boolean; skipIndex?: boolean } = {}): void {
    if (!isSafeSessionId(session.session_id)) throw new Error(`Unsafe session_id ${JSON.stringify(session.session_id)}; refusing to write outside session store`)
    if (session.loadedMetadataOnly) {
      throw new Error(`Refusing to save metadata-only session ${JSON.stringify(session.session_id)}: would atomically overwrite on-disk messages with []. Reload with metadata_only=False before mutating state. See #1558.`)
    }
    if (opts.touchUpdatedAt ?? true) session.updated_at = this.deps.now()
    const payload = JSON.stringify(session.toDocument(), null, 2)
    const path = session.path = this.pathFor(session.session_id)
    mkdirSync(this.sessionDir, { recursive: true })
    try {
      if (existsSync(path)) {
        const incoming = session.messages.length
        let existingCount = readPersistedMessageCount(path)
        let existingText: string | null = null
        if (existingCount === null) {
          existingText = readFileSync(path, 'utf8')
          try {
            const existing = JSON.parse(existingText) as Record<string, unknown>
            existingCount = Array.isArray(existing.messages) ? existing.messages.length : 0
          } catch {
            existingCount = -1
          }
        }
        if (existingCount > 0 && incoming === 0 && (session.active_stream_id || session.pending_user_message)) {
          this.deps.log(`[webui] WARNING: refusing to overwrite session ${session.session_id} messages with empty active/pending snapshot (existing=${existingCount}, incoming=${incoming}, stream=${session.active_stream_id ?? ''})`)
          return
        }
        if (existingCount > incoming) {
          existingText ??= readFileSync(path, 'utf8')
          try { writeAtomic(`${path}.bak`, existingText) } catch { /* backup is best effort */ }
        }
      }
    } catch { /* stat failures never block the save */ }
    writeAtomic(path, payload)
    session.sidecarLoadedSignature = statSignature(path)
    this.invalidatePersistedIds()
    if (!(opts.skipIndex ?? false)) this.queueIndexUpdate([session])
    if (session.messages.length) this.clearDeletedTombstone(session.session_id)
  }

  // ── index ────────────────────────────────────────────────────────────────

  private cleanupStaleTmpFiles(): void {
    const cutoff = this.deps.now() - STALE_TMP_AGE_S
    try {
      for (const name of readdirSync(this.sessionDir)) {
        if (!name.includes('.tmp.')) continue
        const p = join(this.sessionDir, name)
        try { if (statSync(p).mtimeMs / 1000 < cutoff) unlinkSync(p) } catch { /* best effort */ }
      }
    } catch { /* dir may not exist */ }
  }

  invalidatePersistedIds(): void {
    this.persistedIdsCache = null
  }

  persistedIds(): Set<string> {
    let mtimeNs: bigint | null = null
    try { mtimeNs = statSync(this.sessionDir, { bigint: true }).mtimeNs } catch { mtimeNs = null }
    if (this.persistedIdsCache?.mtimeNs === mtimeNs && mtimeNs !== null) return this.persistedIdsCache.ids
    const ids = new Set<string>()
    try {
      for (const name of readdirSync(this.sessionDir)) if (name.endsWith('.json') && !name.startsWith('_')) ids.add(name.slice(0, -5))
    } catch { /* empty */ }
    this.persistedIdsCache = { mtimeNs, ids }
    return ids
  }

  hasPersistedSessionFiles(): boolean {
    return this.persistedIds().size > 0
  }

  private indexSignature(): string | null {
    return statSignature(this.indexFile)
  }

  /** Parsed `_index.json` rows via the stat-validated cache; throws on a corrupt index. */
  readIndexEntries(): Record<string, unknown>[] {
    const signature = this.indexSignature()
    if (this.parsedIndexCache && signature !== null && this.parsedIndexCache.signature === signature) return [...this.parsedIndexCache.entries]
    const entries = JSON.parse(readFileSync(this.indexFile, 'utf8')) as unknown
    if (!Array.isArray(entries)) throw new Error('session index must be a list')
    if (signature !== null && signature === this.indexSignature()) this.parsedIndexCache = { signature, entries: entries as Record<string, unknown>[] }
    return [...(entries as Record<string, unknown>[])]
  }

  indexMessageCounts(entries?: Record<string, unknown>[]): Map<string, number> {
    const out = new Map<string, number>()
    let rows = entries
    if (!rows) {
      try { rows = existsSync(this.indexFile) ? this.readIndexEntries() : [] } catch { rows = [] }
    }
    for (const row of rows) {
      const sid = str(row.session_id)
      const n = Number(row.message_count)
      if (sid && Number.isInteger(n) && n >= 0) out.set(sid, n)
    }
    return out
  }

  private writeIndexPayload(entries: Record<string, unknown>[]): void {
    writeAtomic(this.indexFile, JSON.stringify(entries))
    const signature = this.indexSignature()
    if (signature !== null) this.parsedIndexCache = { signature, entries }
  }

  private loadSessionFromPath(path: string): Session | null {
    try {
      const data = sanitizeSessionRow(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>, this, basename(path))
      if (!data) return null
      const [messages] = collapseAdjacentDuplicatePartials(data.messages)
      data.messages = messages
      return this.construct(data, (data.profile as string | null | undefined) ?? null)
    } catch {
      return null
    }
  }

  /** Rebuild or patch `_index.json` (Python `_write_session_index`). */
  writeIndex(updates?: (Session | Record<string, unknown>)[]): void {
    mkdirSync(this.sessionDir, { recursive: true })
    if (!updates || !existsSync(this.indexFile)) {
      this.cleanupStaleTmpFiles()
      const entryMap = new Map<string, Record<string, unknown>>()
      for (const name of readdirSync(this.sessionDir)) {
        if (!name.endsWith('.json') || name.startsWith('_')) continue
        const s = this.loadSessionFromPath(join(this.sessionDir, name))
        if (!s) continue
        const c = s.compact()
        const sid = str(c.session_id)
        if (!sid) continue
        const existing = entryMap.get(sid)
        if (!existing || Number(c.message_count ?? 0) > Number(existing.message_count ?? 0)) entryMap.set(sid, c)
      }
      const entries = [...entryMap.values()]
      for (const s of this.sessions.values()) if (!entryMap.has(s.session_id)) entries.push(s.compact())
      entries.sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0))
      this.writeIndexPayload(entries)
      return
    }
    try {
      const onDisk = this.persistedIds()
      let existing = this.readIndexEntries()
      const inMemory = new Set(this.sessions.keys())
      const updatedMap = new Map<string, Record<string, unknown>>()
      for (const update of updates) {
        if (update instanceof Session) updatedMap.set(update.session_id, update.compact())
        else if (typeof update.session_id === 'string' && update.session_id) updatedMap.set(update.session_id, update)
      }
      const filtered = existing.filter((e) => inMemory.has(String(e.session_id)) || onDisk.has(String(e.session_id)))
      let changed = filtered.length !== existing.length
      existing = filtered
      const positions = new Map(existing.map((e, i) => [String(e.session_id), i]))
      for (const [sid, entry] of updatedMap) {
        const position = positions.get(sid)
        if (position === undefined) {
          existing.push(entry)
          positions.set(sid, existing.length - 1)
          changed = true
        } else if (JSON.stringify(existing[position]) !== JSON.stringify(entry)) {
          existing[position] = entry
          changed = true
        }
      }
      const oldOrder = existing.map((e) => e.session_id).join('\u0000')
      existing.sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0))
      if (oldOrder !== existing.map((e) => e.session_id).join('\u0000')) changed = true
      if (!changed) return
      this.writeIndexPayload(existing)
    } catch {
      this.writeIndex()
    }
  }

  /** Coalesce index rewrites from concurrent saves (Python `_queue_session_index_update`). */
  queueIndexUpdate(sessions: Session[]): void {
    for (const s of sessions) this.indexPending.set(s.session_id, s.compact())
    this.flushIndexNow()
  }

  private flushIndexNow(): void {
    const pending = [...this.indexPending.values()]
    this.indexPending.clear()
    if (pending.length) this.writeIndex(pending)
  }

  pruneFromIndex(sid: string): void {
    if (!sid || !existsSync(this.indexFile)) return
    try {
      const existing = JSON.parse(readFileSync(this.indexFile, 'utf8')) as unknown
      if (!Array.isArray(existing)) throw new Error('session index must be a list')
      const pruned = (existing as Record<string, unknown>[]).filter((e) => e.session_id !== sid)
      if (pruned.length === existing.length) return
      this.writeIndexPayload(pruned)
    } catch {
      this.writeIndex()
    }
  }

  // ── tombstones ───────────────────────────────────────────────────────────

  private get deletedTombstoneFile(): string {
    return join(this.sessionDir, '_deleted_webui_sessions.json')
  }

  loadDeletedTombstone(): Set<string> {
    try {
      if (!existsSync(this.deletedTombstoneFile)) return new Set()
      const raw = JSON.parse(readFileSync(this.deletedTombstoneFile, 'utf8')) as Record<string, unknown>
      if (!raw || typeof raw !== 'object' || Number(raw.version) !== DELETED_TOMBSTONE_VERSION || !Array.isArray(raw.ids)) return new Set()
      return new Set(raw.ids.map((v) => String(v ?? '').trim()).filter(Boolean))
    } catch {
      return new Set()
    }
  }

  private saveDeletedTombstone(ids: Set<string>): void {
    let sorted = [...ids].sort()
    if (sorted.length > DELETED_TOMBSTONE_CAP) sorted = sorted.slice(-DELETED_TOMBSTONE_CAP)
    try {
      mkdirSync(this.sessionDir, { recursive: true })
      writeAtomic(this.deletedTombstoneFile, JSON.stringify({ version: DELETED_TOMBSTONE_VERSION, ids: sorted }, null, 2))
    } catch { /* best effort */ }
  }

  recordDeletedTombstone(sid: string): void {
    const ids = this.loadDeletedTombstone()
    if (ids.has(sid)) return
    ids.add(sid)
    this.saveDeletedTombstone(ids)
  }

  clearDeletedTombstone(sid: string): void {
    const ids = this.loadDeletedTombstone()
    if (!ids.has(sid)) return
    ids.delete(sid)
    if (ids.size) this.saveDeletedTombstone(ids)
    else rmSync(this.deletedTombstoneFile, { force: true })
  }

  /** The index marked this id as a deleted WebUI session (Python `_marks_deleted_webui_session`, tombstone half). */
  wasDeleted(sid: string): boolean {
    return this.loadDeletedTombstone().has(sid)
  }

  // ── eviction ─────────────────────────────────────────────────────────────

  private persistedMessageCount(sid: string): number | null {
    const path = this.pathFor(sid)
    if (!existsSync(path)) return null
    const count = readPersistedMessageCount(path)
    if (count !== null) return count
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      return Array.isArray(data.messages) ? data.messages.length : 0
    } catch {
      return null
    }
  }

  /** Python `_session_is_evictable`: never drop active, pending, or unsaved sessions. */
  isEvictable(s: Session | undefined): boolean {
    if (!s) return true
    if (s.active_stream_id || s.pending_user_message || s.pending_started_at) return false
    if (!s.session_id) return false
    if (s.loadedMetadataOnly) return true
    const inMemory = s.messages.length
    const diskCount = this.persistedMessageCount(s.session_id)
    if (diskCount === null) {
      if (inMemory > 0) return false
      if (Object.keys(s.composer_draft).length) return false
      if (existsSync(this.pathFor(s.session_id))) return false
      return this.deps.now() - s.created_at > UNSAVED_SHELL_GRACE_S
    }
    if (inMemory === 0) return true
    return diskCount >= inMemory
  }

  evictOverCap(cap?: number): number {
    let limit = cap ?? this.deps.cacheMax()
    if (!Number.isInteger(limit) || limit < 1) limit = 100
    let evicted = 0
    for (const sid of [...this.sessions.keys()]) {
      if (this.sessions.size <= limit) break
      if (this.isEvictable(this.sessions.get(sid))) {
        this.sessions.delete(sid)
        evicted += 1
      }
    }
    return evicted
  }

  // ── deletion ─────────────────────────────────────────────────────────────

  /** Remove the sidecar, backup, draft, index row, and tombstone the id. Returns false when the sidecar survived. */
  deleteFiles(sid: string, opts: { tombstone?: boolean } = {}): boolean {
    const path = this.pathFor(sid)
    try { rmSync(path, { force: true }) } catch { return false }
    if (existsSync(path)) return false
    this.sessions.delete(sid)
    this.invalidatePersistedIds()
    try { this.pruneFromIndex(sid) } catch { /* ignore */ }
    try { rmSync(`${path}.bak`, { force: true }) } catch { /* ignore */ }
    try { this.deps.drafts.delete(sid) } catch { /* ignore */ }
    // TAL-372: the session's background work records (`BackgroundTaskStore`) go with it.
    try { rmSync(join(this.sessionDir, '_background', `${sid}.json`), { force: true }) } catch { /* ignore */ }
    this.deps.onDeleted?.(sid)
    if (opts.tombstone ?? true) this.recordDeletedTombstone(sid)
    return true
  }

  /** Every persisted session as a fresh full load (Python full-scan paths). */
  scanAll(): Session[] {
    const out: Session[] = []
    let names: string[] = []
    try { names = readdirSync(this.sessionDir) } catch { return out }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue
      const s = this.load(name.slice(0, -5))
      if (s) out.push(s)
    }
    return out
  }
}

export class SessionBusy extends Error {
  constructor(readonly sid: string) {
    super(`Session busy: ${sid}`)
    this.name = 'SessionBusy'
  }
}

export { anchorSceneIndexFromRecords }
