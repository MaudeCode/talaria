import { markedStateDbGeneration } from './state-db-identity.js'
import { str } from '../util.js'
import { sanitizeSessionRow } from './list.js'
import type { DraftStore } from './drafts.js'
import type { SessionEventBus } from './events.js'
import { withBackgroundDisplayKinds } from './background-updates.js'
import { anchorSceneIndexFromRecords, collapseAdjacentDuplicatePartials, isSafeSessionId, Session, type SessionDefaults, type SessionInit, type Message } from './session.js'
import { RevisionConflict, type StorageBackend, type StorageIssue, type SessionChange, type MessageMatch } from './storage/backend.js'
import { sessionSearchMatches, sessionSearchMessageText } from './storage/search-text.js'
export class SessionNotFound extends Error {
  constructor(readonly sid: string) {
    super(`Session not found: ${sid}`)
    this.name = 'SessionNotFound'
  }
}

export interface SessionStoreDeps {
  storage: StorageBackend
  drafts: DraftStore
  events: SessionEventBus
  /** Defaults for a brand-new session (last workspace of the profile, effective default model). */
  defaults: (profile: string | null) => SessionDefaults | Promise<SessionDefaults>
  activeStreamIds: () => Set<string>
  now: () => number
  log: (line: string) => void
  cacheMax: () => number
  /** TAL-372: a deleted session's other in-memory state goes with it. */
  onDeleted?: (sid: string) => void | Promise<void>
}


const UNSAVED_SHELL_GRACE_S = 1800
export class SessionStore {
  readonly sessions = new Map<string, Session>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly resolutions = new Map<string, Promise<void>>()
  private readonly persistedMessages = new WeakMap<Session, string[]>()
  private indexWriter: Promise<void> = Promise.resolve()
  private readonly indexPending = new Map<string, Record<string, unknown>>()
  private indexFlush: Promise<void> | null = null
  private indexFailure: Error | null = null
  constructor(readonly deps: SessionStoreDeps) {}
  private get backend() { return this.deps.storage.sessions }
  async exists(sid: string): Promise<boolean> { return this.backend.exists(sid) }
  async revision(sid: string): Promise<string | null> { return this.backend.revision(sid) }
  readMessages(sid: string, range: { start: number; end: number }): Promise<Message[]> { return this.backend.readMessages(sid, range) }
  /** Readers retry rows a failed batch left queued; a still-failing index reads as unreadable, never as current. */
  async index() {
    await this.queueIndexUpdate([])
    // The joined flush may itself have failed; retry what it left queued once.
    if (this.indexPending.size) await this.queueIndexUpdate([])
    if (this.indexFailure && this.indexPending.size) throw this.indexFailure
    return this.backend.index()
  }
  async hasIndex(): Promise<boolean> { return this.backend.hasIndex() }
  get shrinkBackup() { return this.backend.shrinkBackup }
  async diagnose(): Promise<StorageIssue[]> { return this.backend.diagnose() }
  async repair(issue: StorageIssue): Promise<boolean> {
    const repaired = await this.backend.repair(issue)
    if (repaired) this.sessions.delete(issue.session_id)
    return repaired
  }
  async close(): Promise<void> {
    try {
      await Promise.allSettled(this.resolutions.values())
      await Promise.allSettled(this.writes.values())
      await this.indexFlush
      await this.indexWriter
    } finally { await this.deps.storage.close() }
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

  private async construct(init: SessionInit, profile: string | null): Promise<Session> {
    const session = new Session(init, (await this.deps.defaults(profile)))
    // New-session defaults must not replace the title supplied by the read projection.
    if (typeof init.title === 'string') session.title = init.title
    return session
  }

  /** In-memory only until the first message is persisted (Python `new_session`). */
  async newSession(opts: { workspace?: string | null; model?: string | null; modelProvider?: string | null; profile?: string | null; projectId?: string | null; worktree?: { path: string; branch: string; repo_root: string; created_at: number } | null; enabledToolsets?: string[] | null } = {}): Promise<Session> {
    const profile = opts.profile ?? null
    const defaults = (await this.deps.defaults(profile))
    const wt = opts.worktree ?? null
    const s = new Session(
      {
        workspace: (wt ? wt.path : opts.workspace) || defaults.workspace,
        model: opts.model ?? defaults.model,
        model_provider: opts.model ? opts.modelProvider ?? null : opts.modelProvider ?? defaults.modelProvider ?? null,
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
    await this.clearDeletedTombstone(s.session_id)
    await this.touch(s)
    if (wt) (await this.save(s))
    return s
  }

  /** Insert or refresh a session in the LRU and evict over the cap. */
  async touch(session: Session): Promise<void> {
    this.sessions.delete(session.session_id)
    this.sessions.set(session.session_id, session)
    await this.evictOverCap()
  }

  async load(sid: string, opts: { drafts?: boolean; repairDuplicates?: boolean } = {}): Promise<Session | null> {
    if (!isSafeSessionId(sid)) return null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await this.backend.readDocument(sid)
      if (!stored) return null
      const data = sanitizeSessionRow(stored.doc, this, sid)
      if (data?.session_id !== sid) return null
      const messages = await this.readMessages(sid, { start: 0, end: Infinity })
      if (stored.revision === null || stored.revision !== await this.revision(sid)) continue
      const [rows, collapsed] = collapseAdjacentDuplicatePartials(messages)
      data.messages = rows
      const session = (await this.construct(data, (data.profile as string | null | undefined) ?? null))
      session.sidecarLoadedSignature = stored.revision
      this.persistedMessages.set(session, messages.map((row) => JSON.stringify(row)))
      if (collapsed && (opts.repairDuplicates ?? true)) { try { await this.save(session, { touchUpdatedAt: false, skipIndex: true }) } catch { /* best effort */ } }
      try { if (opts.drafts ?? true) session.composer_draft = (await this.deps.drafts.read(sid, session.composer_draft)) } catch { /* ignore */ }
      return session
    }
    throw new RevisionConflict(sid)
  }

  async loadMetadataOnly(sid: string, opts: { indexMessageCounts?: Map<string, number> } = {}): Promise<Session | null> {
    if (!isSafeSessionId(sid)) return null
    try {
      const stored = await this.backend.readDocument(sid, { metadataOnly: true })
      if (!stored) return null
      if (!stored.metadataOnly) return (await this.load(sid))
      const parsed = sanitizeSessionRow(stored.doc, this, sid)
      if (parsed?.session_id !== sid) return null
      parsed.messages = []
      parsed.tool_calls = []
      const session = (await this.construct(parsed, (parsed.profile as string | null | undefined) ?? null))
      session.metadataMessageCount = stored.messageCount ?? (opts.indexMessageCounts ?? await this.indexMessageCounts()).get(sid) ?? null
      session.loadedMetadataOnly = true
      session.sidecarLoadedSignature = stored.revision
      return session
    } catch { return (await this.load(sid)) }
  }

  get(sid: string, opts: { metadataOnly?: boolean; promote?: boolean; cacheOnMiss?: boolean } = {}): Promise<Session> {
    return this.serializeSession(sid, () => this.getNow(sid, opts), this.resolutions)
  }

  private async getNow(sid: string, opts: { metadataOnly?: boolean; promote?: boolean; cacheOnMiss?: boolean }): Promise<Session> {
    // A local commit updates the resident revision before a reader can mistake it for an external edit.
    await this.writes.get(sid)?.catch(() => { /* reload the committed value after a failed save */ })
    const cached = this.sessions.get(sid)
    if (cached) {
      if (cached.session_id !== sid) {
        this.deps.log(`[webui] WARNING: evicting mismatched cached session: requested ${sid} but cached object is ${cached.session_id}`)
        this.sessions.delete(sid)
      } else {
        if (opts.promote ?? true) { this.sessions.delete(sid); this.sessions.set(sid, cached) }
        const lags = await this.cachedLagsStorage(cached)
        if (lags && !await this.exists(sid)) { this.sessions.delete(sid); throw new SessionNotFound(sid) }
        if (!opts.metadataOnly && (cached.loadedMetadataOnly || lags)) {
          const fresh = await this.load(sid)
          if (fresh) { this.sessions.set(sid, fresh); return fresh }
        }
        return cached
      }
    }
    const loaded = opts.metadataOnly ? await this.loadMetadataOnly(sid) : await this.load(sid)
    if (!loaded) throw new SessionNotFound(sid)
    if (opts.cacheOnMiss ?? true) await this.touch(loaded)
    return loaded
  }

  async ensureFull(sid: string, session: Session): Promise<Session> {
    if (!session.loadedMetadataOnly) return session
    const full = await this.load(sid)
    if (!full) throw new SessionNotFound(sid)
    await this.touch(full)
    return full
  }

  private async cachedLagsStorage(cached: Session): Promise<boolean> {
    if (cached.active_stream_id || cached.pending_user_message || cached.pending_started_at) return false
    return await this.revision(cached.session_id) !== cached.sidecarLoadedSignature
  }

  save(session: Session, opts: { touchUpdatedAt?: boolean; skipIndex?: boolean } = {}): Promise<void> {
    return this.serializeSession(session.session_id, () => this.saveNow(session, opts))
  }

  private serializeSession<T>(sid: string, fn: () => Promise<T>, queue = this.writes): Promise<T> {
    const result = (queue.get(sid) ?? Promise.resolve()).then(fn)
    const settled = result.then(() => { /* only ordering is retained */ }, () => { /* a failed write must not poison the next */ })
    queue.set(sid, settled)
    return result.finally(() => { if (queue.get(sid) === settled) queue.delete(sid) })
  }

  private async saveNow(session: Session, opts: { touchUpdatedAt?: boolean; skipIndex?: boolean }): Promise<void> {
    const sid = session.session_id
    if (!isSafeSessionId(sid)) throw new Error(`Unsafe session_id ${JSON.stringify(sid)}; refusing to write outside session store`)
    if (session.loadedMetadataOnly) throw new Error(`Refusing to save metadata-only session ${JSON.stringify(sid)}: would overwrite messages with []. Reload before mutating state.`)
    const markerCurrent = session.state_db_seen_stamp === session.updated_at
    if (opts.touchUpdatedAt ?? true) session.updated_at = this.deps.now()
    if (markerCurrent) session.state_db_seen_stamp = session.updated_at
    session.messages = withBackgroundDisplayKinds(session.messages, session)
    const prefix = session.prefixIndex
    let appendOnly = Boolean(prefix && session.messages.length >= prefix.length && prefix.generation === markedStateDbGeneration(session) && prefix.matchesToolCalls(session.tool_calls))
    const doc = structuredClone(session.toDocument())
    const rows = doc.messages as Message[]
    delete doc.messages
    // One serialization per row serves both the prefix check and the diff; the backend serializes the document once.
    const snapshot = rows.map((row) => JSON.stringify(row))
    if (appendOnly) for (let i = 0; i < prefix!.length; i += 1) if (!prefix!.matchesRow(i, snapshot[i]!)) { appendOnly = false; break }
    const indexEntry = session.compact()
    const previous = this.persistedMessages.get(session)
    let messages: SessionChange['messages'] = { kind: 'replace', rows }
    if (previous) {
      let from = 0
      while (from < previous.length && from < snapshot.length && previous[from] === snapshot[from]) from += 1
      if (from === previous.length) messages = from === snapshot.length ? { kind: 'unchanged' } : { kind: 'append', rows: rows.slice(from) }
      else if (snapshot.length >= previous.length) {
        let tail = 0
        while (tail < previous.length - from && tail < snapshot.length - from && previous[previous.length - 1 - tail] === snapshot[snapshot.length - 1 - tail]) tail += 1
        messages = { kind: 'splice', from, deleteCount: previous.length - from - tail, rows: rows.slice(from, rows.length - tail) }
      }
    }
    const expected = session.sidecarLoadedSignature
    if (!rows.length && (session.active_stream_id || session.pending_user_message)) {
      const stored = await this.backend.readDocument(sid, { metadataOnly: true })
      if ((stored?.messageCount ?? 0) > 0) {
        this.deps.log(`[webui] WARNING: refusing to overwrite session ${sid} messages with empty active/pending snapshot`)
        return
      }
    }
    try { session.sidecarLoadedSignature = await this.backend.write(sid, { doc, messages, all: rows }, expected) }
    catch (error) {
      if (error instanceof RevisionConflict) {
        this.sessions.delete(sid)
        const fresh = await this.load(sid, { repairDuplicates: false })
        if (fresh) this.sessions.set(sid, fresh)
      }
      throw error
    }
    this.persistedMessages.set(session, snapshot)
    if (appendOnly) prefix!.savedAppend(rows, session.sidecarLoadedSignature)
    else delete session.prefixIndex
    // The document is committed; the batched index flush must not delay the caller (the turn's `done`).
    if (!(opts.skipIndex ?? false)) void this.queueIndexUpdate([indexEntry])
    if (rows.length) await this.clearDeletedTombstone(sid)
  }

  async searchMessages(sids: readonly string[], terms: readonly string[], depth: number): Promise<Map<string, MessageMatch>> {
    const matches = new Map<string, MessageMatch>()
    const remaining: string[] = []
    for (const sid of sids) {
      const cached = this.sessions.get(sid)
      if (!cached || cached.loadedMetadataOnly || await this.cachedLagsStorage(cached)) { remaining.push(sid); continue }
      const rows = depth ? cached.messages.slice(0, depth) : cached.messages
      const idx = rows.findIndex((row) => sessionSearchMatches(sessionSearchMessageText(row), terms))
      if (idx >= 0) matches.set(sid, { idx, text: sessionSearchMessageText(rows[idx]) })
    }
    for (const [sid, match] of await this.backend.searchMessages(remaining, terms, depth)) matches.set(sid, match)
    return matches
  }

  async persistedIds(): Promise<Set<string>> { return this.backend.ids() }
  async hasPersistedSessionFiles(): Promise<boolean> { return (await this.persistedIds()).size > 0 }
  async readIndexEntries(): Promise<Record<string, unknown>[]> { return (await this.index()).entries }
  async indexMessageCounts(entries?: Record<string, unknown>[]): Promise<Map<string, number>> {
    let rows = entries
    if (!rows) { try { rows = await this.readIndexEntries() } catch { rows = [] } }
    const out = new Map<string, number>()
    for (const row of rows) {
      const sid = str(row.session_id), n = Number(row.message_count)
      if (sid && Number.isInteger(n) && n >= 0) out.set(sid, n)
    }
    return out
  }

  private async serializeIndex(fn: () => Promise<void>): Promise<void> {
    const pending = this.indexWriter.then(fn, fn)
    this.indexWriter = pending.catch(() => { /* the next operation must still run */ })
    return pending
  }
  private async rebuildIndexNow(opts: { diskOnly?: boolean } = {}): Promise<void> {
    const map = new Map<string, Record<string, unknown>>()
    for (const sid of await this.persistedIds()) {
      try {
        const session = await this.load(sid, { drafts: false, repairDuplicates: false })
        if (session) map.set(session.session_id, session.compact())
      } catch { /* corrupt sessions are omitted */ }
    }
    if (!opts.diskOnly) for (const s of this.sessions.values()) if (!map.has(s.session_id)) map.set(s.session_id, s.compact())
    await this.backend.writeIndex([...map.values()].sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)))
  }
  async rebuildIndex(opts: { diskOnly?: boolean } = {}): Promise<void> { await this.serializeIndex(async () => { await this.rebuildIndexNow(opts); }); }
  async writeIndex(updates?: (Session | Record<string, unknown>)[]): Promise<void> {
    const snapshots = updates?.map((s) => s instanceof Session ? s.compact() : s)
    await this.serializeIndex(async () => {
      if (!snapshots || !await this.backend.hasIndex()) { await this.rebuildIndexNow(); return }
      let rows: Record<string, unknown>[]
      try { rows = (await this.backend.index()).entries } catch { await this.rebuildIndexNow(); return }
      const ids = await this.persistedIds()
      const live = (sid: string) => ids.has(sid) || this.sessions.has(sid)
      const kept = rows.filter((r) => live(str(r.session_id)))
      // Only the pruned and upserted entries can differ, so compare those instead of serializing the whole index.
      let changed = kept.length !== rows.length
      rows = kept
      const order = rows.map((r) => str(r.session_id))
      const positions = new Map(rows.map((r, i) => [str(r.session_id), i]))
      for (const row of snapshots) {
        const sid = str(row.session_id)
        // A queued row can outlive its session (deleted while a failed batch waited for a retry).
        if (!sid || !live(sid)) continue
        const i = positions.get(sid)
        if (i === undefined) { positions.set(sid, rows.length); rows.push(row); changed = true }
        else {
          changed ||= JSON.stringify(rows[i]) !== JSON.stringify(row)
          rows[i] = row
        }
      }
      rows.sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0))
      changed ||= rows.some((r, i) => str(r.session_id) !== order[i])
      if (changed) await this.backend.writeIndex(rows)
    });
  }
  queueIndexUpdate(updates: (Session | Record<string, unknown>)[]): Promise<void> {
    for (const update of updates) {
      const row = update instanceof Session ? update.compact() : update
      const sid = str(row.session_id)
      if (sid) this.indexPending.set(sid, row)
    }
    this.indexFlush ??= Promise.resolve().then(async () => {
      try {
        while (this.indexPending.size) {
          const batch = new Map(this.indexPending)
          this.indexPending.clear()
          try { await this.writeIndex([...batch.values()]); this.indexFailure = null }
          catch (error) {
            // Nobody awaits the flush, so a failed batch stays queued for the next save or index read instead of being lost.
            for (const [sid, row] of batch) if (!this.indexPending.has(sid)) this.indexPending.set(sid, row)
            this.indexFailure = error instanceof Error ? error : new Error(String(error))
            this.deps.log(`[webui] WARNING: session index update failed: ${this.indexFailure.message}`)
            break
          }
        }
      } finally { this.indexFlush = null }
    })
    return this.indexFlush
  }
  async pruneFromIndex(sid: string): Promise<void> {
    await this.serializeIndex(async () => {
      if (!sid || !await this.backend.hasIndex()) return
      try {
        const rows = (await this.backend.index()).entries
        const pruned = rows.filter((r) => r.session_id !== sid)
        if (pruned.length !== rows.length) await this.backend.writeIndex(pruned)
      } catch { await this.rebuildIndexNow() }
    });
  }
  async loadDeletedTombstone(): Promise<Set<string>> { return this.backend.tombstones.all() }
  async recordDeletedTombstone(sid: string): Promise<void> { return this.backend.tombstones.add(sid) }
  async clearDeletedTombstone(sid: string): Promise<void> { return this.backend.tombstones.remove(sid) }
  async wasDeleted(sid: string): Promise<boolean> { return this.backend.tombstones.has(sid) }

  async isEvictable(s: Session | undefined): Promise<boolean> {
    if (!s) return true
    if (s.active_stream_id || s.pending_user_message || s.pending_started_at || !s.session_id) return false
    if (s.loadedMetadataOnly) return true
    let count: number | null = null
    try { count = (await this.backend.readDocument(s.session_id, { metadataOnly: true }))?.messageCount ?? null } catch { /* corrupt */ }
    if (count === null) {
      if (s.messages.length || Object.keys(s.composer_draft).length || await this.exists(s.session_id)) return false
      return this.deps.now() - s.created_at > UNSAVED_SHELL_GRACE_S
    }
    return count >= s.messages.length
  }
  async evictOverCap(cap?: number): Promise<number> {
    let limit = cap ?? this.deps.cacheMax()
    if (!Number.isInteger(limit) || limit < 1) limit = 100
    let evicted = 0
    for (const sid of [...this.sessions.keys()]) {
      if (this.sessions.size <= limit) break
      const session = this.sessions.get(sid)
      if (await this.isEvictable(session) && this.sessions.get(sid) === session && !session?.active_stream_id && !session?.pending_user_message && !session?.pending_started_at) {
        this.sessions.delete(sid)
        evicted += 1
      }
    }
    return evicted
  }
  delete(sid: string, opts: { tombstone?: boolean } = {}): Promise<boolean> {
    return this.serializeSession(sid, async () => {
      if (!await this.backend.delete(sid, { tombstone: opts.tombstone ?? true })) return false
      this.sessions.delete(sid)
      try { await this.pruneFromIndex(sid) } catch { /* ignore */ }
      try { (await this.deps.drafts.delete(sid)) } catch { /* ignore */ }
      await this.deps.onDeleted?.(sid)
      return true
    })
  }
  async scanAll(): Promise<Session[]> {
    const out: Session[] = []
    for (const sid of await this.persistedIds()) { const s = await this.load(sid); if (s) out.push(s) }
    return out
  }
}

export class SessionBusy extends Error {
  constructor(readonly sid: string) { super(`Session busy: ${sid}`); this.name = 'SessionBusy' }
}
export { anchorSceneIndexFromRecords }
