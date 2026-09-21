/**
 * Route-level session operations (the Python `/api/session*` handlers): the
 * detail payload, list and search, and every mutation with its guards.
 * Runtime concerns owned by other domains arrive through `SessionServiceDeps`.
 */
import { str } from '../util.js'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { copyJson, redactSessionData, stripPublicInternalFields } from '../redact.js'
import type { DraftStore } from './drafts.js'
import { DraftVersionConflict, normalizeDraftVersion } from './drafts.js'
import type { SessionEventBus } from './events.js'
import { allSessions, buildSessionListPayload, lineageRootId, sessionListResponse, sessionSearchMessageText, sessionSearchPreview, type ListParams, type ListResponse, type Row, type RuntimeOverlay } from './list.js'
import { anchorSceneIntOrNull, hydrateAnchorActivityScenes, normalizeAnchorSceneMessageRef, readAnchorSceneRows, storeAnchorScene } from './anchor.js'
import { isSafeSessionId, lastMessageTimestamp, Session, titleFrom, type Message } from './session.js'
import { SessionBusy, SessionNotFound, statSignature, type SessionStore } from './store.js'
import { attachTodoState } from './todo.js'
import { messagesForLimitedPayload, messageWindowForDisplay, MAX_MSG_LIMIT, parseMsgLimit, toolCallsForMessageWindow } from './window.js'
import { redactText } from '../redact.js'
import type { WorkspaceRegistry } from '../workspace/workspaces.js'
import { buildShareSnapshot, type ShareStore } from './shares.js'
import type { ProjectStore } from '../projects.js'
import { loadGatewaySessionIdentityMap } from './list.js'
import { join } from 'node:path'

export class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HttpFailure'
  }
}

export interface SessionServiceDeps {
  store: SessionStore
  drafts: DraftStore
  events: SessionEventBus
  workspaces: WorkspaceRegistry
  projects: ProjectStore
  shares: ShareStore
  now: () => number
  log: (line: string) => void
  activeProfile: () => string
  isolatedProfileMode: () => boolean
  profilesMatch: (a: string | null | undefined, b: string | null | undefined) => boolean
  redactEnabled: () => boolean
  pinnedSessionsLimit: () => number
  runtime: RuntimeOverlay & {
    /** A live worker stream that must block deletion / duplicate turns for this session. */
    activeRunStream: (sid: string) => string | null
    evictAgent: (sid: string) => void
    closeTerminal: (sid: string) => void
  }
  attachmentDir: (sid: string) => string
  hermesHome: string
  home: string
  /** Sync title-only metadata to state.db when `sync_to_insights` is on. */
  syncTitle: (session: Session) => void
  /** Context length lookup for a model (checkpoint 7 wires the catalog). */
  contextLengthFor: (model: string | null, provider: string | null) => number | null
  /** `(model, provider)` normalisation from a request (checkpoint 7 wires provider-qualified ids). */
  modelStateFromRequest: (model: unknown, requestedProvider: unknown, currentProvider: string | null) => [string | null, string | null]
  yolo: { isEnabled: (sid: string) => boolean; set: (sid: string, enabled: boolean) => void }
  /** state.db sidebar rows for a profile (Python `get_cli_sessions`); null when the projection is unavailable. */
  cliSessions: (profile: string, opts: { sourceFilter: string | null }) => Row[]
  profileHome: (profile: string) => string
}

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export class SessionService {
  constructor(readonly deps: SessionServiceDeps) {}

  private get store(): SessionStore { return this.deps.store }

  publish(reason: string, profile?: string | null, sessionId?: string | null): void {
    this.deps.events.publish(reason, { profile: profile ?? null, sessionId: sessionId ?? null })
  }

  visibleToActiveProfile(profile: string | null | undefined): boolean {
    return this.deps.profilesMatch(typeof profile === 'string' ? profile : null, this.deps.activeProfile())
  }

  /** Python `_session_id_visible_to_request_profile`. */
  sessionIdVisible(sid: unknown): boolean {
    if (typeof sid !== 'string' || !sid || !isSafeSessionId(sid)) return true
    let session: Session
    try {
      session = this.store.get(sid, { metadataOnly: true })
    } catch {
      return true
    }
    return this.visibleToActiveProfile(session.profile)
  }

  private isSubagentViewOnly(sid: string): boolean {
    try {
      const s = this.store.get(sid)
      return str(s.source_tag || s.raw_source || s.session_source).trim().toLowerCase() === 'subagent'
    } catch {
      return false
    }
  }

  /** Full session for mutation, refusing read-only imports (Python `_get_or_materialize_session`). */
  getForMutation(sid: string): Session {
    let s = this.store.get(sid)
    s = this.store.ensureFull(sid, s)
    if (s.read_only) throw new HttpFailure(403, 'Read-only imported sessions cannot be modified from WebUI')
    if (str(s.source_tag || s.raw_source).trim().toLowerCase() === 'subagent') throw new HttpFailure(403, 'Read-only subagent child session')
    return s
  }

  private get404(sid: string, opts: { metadataOnly?: boolean } = {}): Session {
    try {
      return this.store.get(sid, opts)
    } catch (error) {
      if (error instanceof SessionNotFound) throw new HttpFailure(404, 'Session not found')
      throw error
    }
  }

  private mutationTarget(sid: string, verb: string): Session {
    try {
      return this.getForMutation(sid)
    } catch (error) {
      if (error instanceof SessionNotFound) throw new HttpFailure(404, 'Session not found')
      if (error instanceof HttpFailure && error.status === 403) throw new HttpFailure(403, `Read-only imported sessions cannot be ${verb} from WebUI`)
      throw error
    }
  }

  private rejectSubagent(sid: string, verb: string): void {
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, `Subagent sessions are view-only and cannot be ${verb} from WebUI`)
  }

  /** `compact()` plus messages, redacted for the wire (Python `_public_session_projection`). */
  publicSession(s: Session, withMessages = true): Record<string, unknown> {
    const payload = s.compact()
    if (withMessages) payload.messages = s.messages
    return redactSessionData(payload, this.deps.redactEnabled())
  }

  // ── detail ──────────────────────────────────────────────────────────────

  private loadRevision(s: Session): string | null {
    return statSignature(this.store.pathFor(s.session_id))
  }

  /** Python `_handle_session_get` on the WebUI sidecar (state.db merge pending). */
  detail(sid: string, query: { messages?: string | null | undefined; msg_limit?: string | null | undefined; msg_before?: string | null | undefined; resolve_model?: string | null | undefined }): Record<string, unknown> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    const loadMessages = (query.messages ?? '1') !== '0'
    const msgLimit = parseMsgLimit(query.msg_limit ?? null)
    const msgBeforeRaw = query.msg_before
    const msgBefore = msgBeforeRaw ? (Number.isInteger(Number(msgBeforeRaw)) ? Number(msgBeforeRaw) : null) : null
    let s: Session
    try {
      s = this.store.get(sid, { metadataOnly: !loadMessages })
    } catch {
      throw new HttpFailure(404, 'Session not found')
    }
    const revisionBefore = this.loadRevision(s)
    if (!this.visibleToActiveProfile(s.profile)) {
      if (s.profile) throw new HttpFailure(409, 'Session belongs to a different profile', { code: 'session_profile_mismatch', session_id: sid, profile: s.profile })
      throw new HttpFailure(404, 'Session not found')
    }
    this.clearStaleStreamState(s)
    const all: unknown[] = loadMessages ? s.messages : []
    let truncated: unknown[] = []
    let offset = 0
    let summaryCount: number | null = null
    let summaryLast: number | null = null
    if (loadMessages) {
      ;[truncated, offset] = messageWindowForDisplay(all, msgLimit, msgBefore)
      if (msgLimit !== null) truncated = messagesForLimitedPayload(truncated)
      truncated = hydrateAnchorActivityScenes(truncated, s.anchor_activity_scenes, offset)
    } else {
      summaryCount = s.metadataMessageCount ?? s.messages.length
      summaryLast = lastMessageTimestamp(s.messages) ?? 0
    }
    const windowed = loadMessages && msgLimit !== null && (msgBefore !== null || truncated.length < all.length)
    let toolCalls: unknown[] = loadMessages ? s.tool_calls : []
    if (windowed) toolCalls = toolCallsForMessageWindow(toolCalls, offset, truncated.length)
    const mergedCount = summaryCount ?? all.length
    let mergedLast = summaryLast ?? 0
    if (summaryLast === null && all.length) {
      mergedLast = Math.max(...all.map((m) => (isDict(m) ? Number(m.timestamp ?? 0) || 0 : 0)))
    }
    const activeStreamIds = this.deps.runtime.activeStreamIds
    const raw: Record<string, unknown> = {
      ...s.compact({ includeRuntime: true, activeStreamIds }),
      messages: truncated,
      message_count: mergedCount,
      tool_calls: toolCalls,
      active_stream_id: s.active_stream_id,
      pending_user_message: s.pending_user_message,
      pending_attachments: loadMessages ? s.pending_attachments : [],
      pending_started_at: s.pending_started_at,
      pending_user_source: s.pending_user_source,
      context_length: Number(s.context_length ?? 0) || this.deps.contextLengthFor(s.model, s.model_provider) || 0,
      threshold_tokens: Number(s.threshold_tokens ?? 0) || 0,
      last_prompt_tokens: Number(s.last_prompt_tokens ?? 0) || 0,
    }
    if (loadMessages && all.length) attachTodoState(raw, all)
    if (mergedLast) {
      raw.last_message_at = Math.max(Number(raw.last_message_at ?? 0) || 0, mergedLast)
      raw.updated_at = Math.max(Number(raw.updated_at ?? 0) || 0, mergedLast)
    }
    const isTruncated = loadMessages && msgLimit !== null && offset > 0
    raw._messages_truncated = isTruncated
    raw._messages_offset = offset
    raw._msg_limit_max = MAX_MSG_LIMIT
    const revisionAfter = this.loadRevision(s)
    raw._load_revision = revisionBefore !== null && revisionBefore === revisionAfter ? hashRevision(revisionBefore) : `unstable-${randomUUID().replace(/-/g, '')}`
    if (str(raw.source_tag || raw.raw_source || raw.session_source).trim().toLowerCase() === 'subagent') {
      raw.is_cli_session = false
      raw.read_only = true
    }
    return redactSessionData(raw, this.deps.redactEnabled())
  }

  /** Clear persisted streaming flags when no live stream backs them (Python `_clear_stale_stream_state`, no journal recovery). */
  clearStaleStreamState(session: Session): boolean {
    const streamId = session.active_stream_id
    if (!streamId) return false
    if (this.deps.runtime.activeStreamIds.has(streamId)) return false
    if (this.deps.runtime.activeRunStream(session.session_id)) return false
    const pendingAge = session.pending_started_at ? this.deps.now() - session.pending_started_at : null
    if (session.pending_user_message && pendingAge !== null && pendingAge < 30) return false
    let target = session
    if (session.loadedMetadataOnly) {
      const full = this.store.load(session.session_id)
      if (!full) return false
      target = full
      if (!target.active_stream_id) {
        session.active_stream_id = null
        session.pending_user_message = null
        session.pending_attachments = []
        session.pending_started_at = null
        session.pending_user_source = null
        return false
      }
    }
    target.active_stream_id = null
    target.pending_user_message = null
    target.pending_attachments = []
    target.pending_started_at = null
    target.pending_user_source = null
    try { this.store.save(target, { touchUpdatedAt: false }) } catch { return false }
    if (target !== session) {
      session.active_stream_id = null
      session.pending_user_message = null
      session.pending_attachments = []
      session.pending_started_at = null
      session.pending_user_source = null
      this.store.touch(target)
    }
    return true
  }

  // ── list / search ────────────────────────────────────────────────────────

  list(params: Omit<ListParams, 'activeProfile' | 'isolatedProfileMode' | 'profilesMatch' | 'cliRows' | 'gatewayIdentity'>): { body: ListResponse; etag: string } {
    const activeProfile = this.deps.activeProfile()
    const wantState = params.showCliSessions || params.showCronSessions || params.showWebhookSessions || params.showKanbanSessions
    // Python reads every profile's state.db under all_profiles; this port projects the active profile only.
    const cliRows = wantState ? this.deps.cliSessions(activeProfile, { sourceFilter: params.sourceFilter ?? null }) : undefined
    const gatewayIdentity = loadGatewaySessionIdentityMap(join(this.deps.profileHome(activeProfile), 'sessions', 'sessions.json'))
    const payload = buildSessionListPayload(this.store, { ...params, ...(cliRows ? { cliRows } : {}), gatewayIdentity, activeProfile, isolatedProfileMode: this.deps.isolatedProfileMode(), profilesMatch: this.deps.profilesMatch })
    return sessionListResponse(payload, this.deps.runtime, this.deps.redactEnabled(), this.deps.now())
  }

  search(q: string, opts: { content: boolean; depth: number; allProfiles: boolean }): Record<string, unknown> {
    const activeProfile = this.deps.activeProfile()
    let sessions = allSessions(this.store)
    if (!opts.allProfiles) sessions = sessions.filter((r) => this.deps.profilesMatch(str(r.profile) || null, activeProfile))
    const redact = this.deps.redactEnabled()
    const redactRow = (item: Row) => {
      if (typeof item.title === 'string') item.title = redactText(item.title, redact)
      for (const f of ['display_title', '_state_db_title', 'parent_title']) if (typeof item[f] === 'string') item[f] = redactText(item[f], redact)
      return item
    }
    const query = q.toLowerCase().trim()
    if (!query) return { sessions: sessions.map((s) => redactRow({ ...s })), all_profiles: opts.allProfiles, active_profile: activeProfile }
    const results: Row[] = []
    for (const s of sessions) {
      if (str(s.title).toLowerCase().includes(query)) { results.push(redactRow({ ...s, match_type: 'title' })); continue }
      if (!opts.content) continue
      let sess: Session
      try { sess = this.store.get(str(s.session_id), { promote: false, cacheOnMiss: false }) } catch { continue }
      const msgs = opts.depth ? sess.messages.slice(0, opts.depth) : sess.messages
      for (const m of msgs) {
        const c = sessionSearchMessageText(m)
        if (c.toLowerCase().includes(query)) {
          const item: Row = { ...s, match_type: 'content' }
          const preview = sessionSearchPreview(c, query)
          if (preview) item.match_preview = redactText(preview, redact)
          results.push(redactRow(item))
          break
        }
      }
    }
    return { sessions: results, query, count: results.length, all_profiles: opts.allProfiles, active_profile: activeProfile }
  }

  // ── status / usage ───────────────────────────────────────────────────────

  status(sid: string): Record<string, unknown> {
    const s = this.get404(sid, { metadataOnly: true })
    this.clearStaleStreamState(s)
    const full = this.get404(sid)
    const inp = Math.trunc(full.input_tokens) || 0
    const out = Math.trunc(full.output_tokens) || 0
    const profile = full.profile || 'default'
    let hermesHome = ''
    try { hermesHome = this.deps.workspaces.deps.profileHome(profile) } catch { hermesHome = '' }
    const live = full.active_stream_id && this.deps.runtime.activeStreamIds.has(full.active_stream_id) ? full.active_stream_id : null
    return {
      session_id: full.session_id, title: full.title, model: full.model, profile, hermes_home: hermesHome, workspace: full.workspace, personality: full.personality,
      message_count: full.messages.length, created_at: full.created_at, updated_at: full.updated_at, agent_running: Boolean(full.active_stream_id), active_stream_id: live,
      input_tokens: inp, output_tokens: out, total_tokens: inp + out, estimated_cost: full.estimated_cost,
    }
  }

  usage(sid: string): Record<string, unknown> {
    const s = this.get404(sid)
    const inp = Math.trunc(s.input_tokens) || 0
    const out = Math.trunc(s.output_tokens) || 0
    return { input_tokens: inp, output_tokens: out, total_tokens: inp + out, estimated_cost: s.estimated_cost, model: s.model }
  }

  // ── creation ─────────────────────────────────────────────────────────────

  resolveNewSessionWorkspace(body: Record<string, unknown>, visiblePrevSessionId: string | null, profile: string | null): string | null {
    const candidate = body.workspace
    if (!candidate) return null
    const value = str(candidate)
    if (body.workspace_inherited_from_prev_session !== true || !visiblePrevSessionId) return this.deps.workspaces.resolveTrusted(value, profile)
    let previous: Session
    try { previous = this.store.get(visiblePrevSessionId, { metadataOnly: true }) } catch { return this.deps.workspaces.resolveTrusted(value, profile) }
    if (previous.workspace !== value) return this.deps.workspaces.resolveTrusted(value, profile)
    const [workspace] = this.deps.workspaces.resolveImplicitWithRecovery(value, (p) => this.deps.workspaces.profileDefaultWorkspaceForBoot(p), profile)
    return workspace
  }

  validateToolsetsShape(toolsets: unknown): string[] | null {
    if (toolsets === null || toolsets === undefined) return null
    if (!Array.isArray(toolsets) || !toolsets.length) throw new HttpFailure(400, 'toolsets must be a non-empty list or null')
    if (!toolsets.every((t) => typeof t === 'string' && t)) throw new HttpFailure(400, 'each toolset must be a non-empty string')
    return toolsets as string[]
  }

  create(body: Record<string, unknown>, opts: { worktree?: { path: string; branch: string; repo_root: string; created_at: number } | null } = {}): Session {
    const profile = (typeof body.profile === 'string' && body.profile) || null
    let prevSessionId = typeof body.prev_session_id === 'string' && body.prev_session_id ? body.prev_session_id : null
    if (prevSessionId && !this.sessionIdVisible(prevSessionId)) prevSessionId = null
    let workspace: string | null
    try {
      workspace = this.resolveNewSessionWorkspace(body, prevSessionId, profile)
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const [model, provider] = this.deps.modelStateFromRequest(body.model, body.model_provider, null)
    const toolsets = this.validateToolsetsShape(body.enabled_toolsets)
    const s = this.store.newSession({ workspace, model, modelProvider: provider, profile, projectId: typeof body.project_id === 'string' && body.project_id ? body.project_id : null, worktree: opts.worktree ?? null, enabledToolsets: toolsets })
    if (opts.worktree) this.publish('session_new', s.profile, s.session_id)
    return s
  }

  // ── simple metadata mutations ────────────────────────────────────────────

  async rename(sid: string, rawTitle: unknown): Promise<Record<string, unknown>> {
    const s = this.mutationTarget(sid, 'renamed')
    await this.store.withLock(sid, () => {
      applySessionTitleRename(s, rawTitle)
      this.store.save(s)
    })
    this.deps.syncTitle(s)
    this.publish('session_rename', s.profile, s.session_id)
    return { session: s.compact() }
  }

  async pin(sid: string, pinRequested: boolean): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    let s = this.get404(sid)
    s = this.store.ensureFull(sid, s)
    if (pinRequested && !s.pinned) {
      const rows = allSessions(this.store)
      const byId = new Map(rows.filter((r) => r.session_id).map((r) => [str(r.session_id), r]))
      byId.set(s.session_id, s.compact())
      const targetLineage = lineageRootId(s.compact(), byId)
      const pinnedLineages = new Set(rows.filter((r) => r.pinned && !r.pre_compression_snapshot).map((r) => lineageRootId(r, byId)))
      pinnedLineages.delete(targetLineage)
      const limit = this.deps.pinnedSessionsLimit()
      if (pinnedLineages.size >= limit) throw new HttpFailure(400, `Up to ${limit} sessions can be pinned. Unpin one before pinning another.`)
    }
    await this.store.withLock(sid, () => {
      s.pinned = pinRequested
      this.store.save(s)
    })
    this.publish('session_pin', s.profile, s.session_id)
    return { ok: true, session: s.compact() }
  }

  async archive(sid: string, archived: boolean): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'archived')
    let s = this.get404(sid)
    s = this.store.ensureFull(sid, s)
    await this.store.withLock(sid, () => {
      s.archived = archived
      if (archived) s.pinned = false
      this.store.save(s, { touchUpdatedAt: false })
    })
    this.publish('session_archive', s.profile, s.session_id)
    return { ok: true, session: s.compact(), ...worktreeRetainedPayload(s) }
  }

  async move(sid: string, targetProjectId: string | null): Promise<Record<string, unknown>> {
    const s = this.mutationTarget(sid, 'moved')
    if (targetProjectId) {
      const sessionProfile = s.profile || this.deps.activeProfile()
      const target = this.deps.projects.load().find((p) => p.project_id === targetProjectId)
      if (!target || !this.deps.profilesMatch(target.profile ?? null, sessionProfile)) throw new HttpFailure(404, 'Project not found')
    }
    try {
      await this.store.withLock(sid, () => {
        s.project_id = targetProjectId
        this.store.save(s)
      }, { timeoutMs: 5000 })
    } catch (error) {
      if (error instanceof SessionBusy) throw new HttpFailure(503, 'Session is busy (streaming). Please try again in a moment.')
      throw error
    }
    this.publish('session_move', s.profile, s.session_id)
    return { ok: true, session: s.compact() }
  }

  async update(sid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const s = this.mutationTarget(sid, 'updated')
    const oldWs = s.workspace
    const oldModel = s.model
    const oldProvider = s.model_provider
    let newWs: string
    try {
      newWs = this.deps.workspaces.resolveTrusted(typeof body.workspace === 'string' ? body.workspace : s.workspace, s.profile)
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    await this.store.withLock(sid, () => {
      s.workspace = newWs
      if ('model' in body || 'model_provider' in body) {
        const [model, provider] = this.deps.modelStateFromRequest('model' in body ? body.model : s.model, 'model_provider' in body ? body.model_provider : undefined, s.model_provider)
        if (model !== null) s.model = model
        s.model_provider = provider
        if (str(oldModel) !== str(s.model) || str(oldProvider) !== str(s.model_provider)) {
          s.context_length = this.deps.contextLengthFor(s.model, s.model_provider)
          s.threshold_tokens = 0
          s.last_prompt_tokens = 0
          this.deps.runtime.evictAgent(sid)
        }
      }
      this.store.save(s)
    })
    if (str(oldWs) !== str(newWs)) this.deps.runtime.closeTerminal(sid)
    this.deps.workspaces.setLastWorkspace(newWs, s.profile)
    return { session: this.publicSession(s) }
  }

  async setToolsets(sid: string, toolsets: unknown): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    const cleaned = this.validateToolsetsShape(toolsets)
    const s = this.get404(sid)
    await this.store.withLock(sid, () => {
      s.enabled_toolsets = cleaned
      this.store.save(s)
    })
    return { ok: true, enabled_toolsets: s.enabled_toolsets }
  }

  /** Python `/api/personality/set` persistence: the name only; the prompt is resolved by the caller. */
  async setPersonality(sid: string, name: string | null): Promise<string | null> {
    this.rejectSubagent(sid, 'modified')
    const s = this.mutationTarget(sid, 'modified')
    await this.store.withLock(sid, () => {
      s.personality = name
      this.store.save(s)
    })
    return typeof s.personality === 'string' ? s.personality : null
  }

  // ── transcript mutations ─────────────────────────────────────────────────

  async truncate(sid: string, keepRaw: unknown): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    if (keepRaw === null || keepRaw === undefined) throw new HttpFailure(400, 'Missing required field(s): keep_count')
    const s = this.get404(sid)
    const keep = Number(keepRaw)
    if (!Number.isInteger(keep)) throw new HttpFailure(400, 'keep_count must be an integer')
    if (keep < 0) throw new HttpFailure(400, 'keep_count must be non-negative')
    await this.store.withLock(sid, () => {
      truncateSessionAtKeep(s, keep)
      this.store.save(s)
    })
    this.deps.runtime.evictAgent(sid)
    return { ok: true, session: this.publicSession(s) }
  }

  async clear(sid: string): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    const s = this.get404(sid)
    await this.store.withLock(sid, () => {
      const hadMessages = s.messages.length > 0
      truncateSessionAtKeep(s, 0)
      s.tool_calls = []
      if (s.parent_session_id) {
        let parentIsSnapshot = false
        try { parentIsSnapshot = this.store.get(s.parent_session_id, { metadataOnly: true }).pre_compression_snapshot } catch { parentIsSnapshot = false }
        if (parentIsSnapshot) {
          s.parent_session_id = null
          s.compression_anchor_visible_idx = null
          s.compression_anchor_message_key = null
        }
      }
      s.active_stream_id = null
      s.pending_user_message = null
      s.pending_attachments = []
      s.pending_started_at = null
      s.pending_user_source = null
      s.clear_generation = hadMessages ? randomUUID().replace(/-/g, '') : null
      applySessionTitleRename(s, 'Untitled')
      this.store.save(s)
      if (hadMessages) { try { rmSync(`${this.store.pathFor(sid)}.bak`, { force: true }) } catch { /* ignore */ } }
    })
    this.deps.runtime.evictAgent(sid)
    return { ok: true, session: s.compact() }
  }

  async retry(sid: string): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    return this.store.withLock(sid, () => {
      const s = this.get404(sid)
      const history = s.messages
      const lastUser = findLastUserIndex(history)
      if (lastUser === null) return { error: 'No previous message to retry.' }
      const lastUserText = extractText(history[lastUser]?.content)
      const removed = history.length - lastUser
      shrinkTo(s, lastUser)
      this.store.save(s)
      return { ok: true, last_user_text: lastUserText, removed_count: removed }
    })
  }

  async undo(sid: string): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    return this.store.withLock(sid, () => {
      const s = this.get404(sid)
      const history = s.messages
      const lastUser = findLastUserIndex(history)
      if (lastUser === null) return { error: 'Nothing to undo.' }
      const removedText = extractText(history[lastUser]?.content)
      const removed = history.length - lastUser
      shrinkTo(s, lastUser)
      this.store.save(s)
      const preview = removedText.length > 40 ? `${removedText.slice(0, 40)}...` : removedText
      return { ok: true, removed_count: removed, removed_preview: preview }
    })
  }

  duplicate(sid: string): Record<string, unknown> {
    this.rejectSubagent(sid, 'duplicated')
    const session = this.store.load(sid)
    if (!session) throw new HttpFailure(404, 'Session not found')
    const now = this.deps.now()
    const copied = new Session(
      {
        title: `${session.title || 'Untitled'} (copy)`, workspace: session.workspace, model: session.model, model_provider: session.model_provider,
        messages: copyJson(session.messages), tool_calls: copyJson(session.tool_calls), pinned: false, archived: false, project_id: session.project_id, profile: session.profile,
        input_tokens: session.input_tokens, output_tokens: session.output_tokens, estimated_cost: session.estimated_cost, cache_read_tokens: session.cache_read_tokens, cache_write_tokens: session.cache_write_tokens,
        personality: session.personality, enabled_toolsets: session.enabled_toolsets, context_length: session.context_length, threshold_tokens: session.threshold_tokens,
        truncation_watermark: session.truncation_watermark, truncation_boundary: session.truncation_boundary, context_messages: copyJson(session.context_messages),
        gateway_routing: copyJson(session.gateway_routing), gateway_routing_history: copyJson(session.gateway_routing_history), llm_title_generated: session.llm_title_generated,
        manual_title: session.manual_title, composer_draft: copyJson(session.composer_draft), context_engine: session.context_engine, context_engine_state: copyJson(session.context_engine_state),
        created_at: now, updated_at: now,
      },
      { workspace: session.workspace, model: session.model },
    )
    this.store.touch(copied)
    this.store.save(copied)
    this.publish('session_duplicate', copied.profile, copied.session_id)
    return { session: this.publicSession(copied) }
  }

  branch(sid: string, body: Record<string, unknown>): Record<string, unknown> {
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot be branched from WebUI')
    let source: Session
    try { source = this.store.get(sid) } catch { throw new HttpFailure(404, 'Session not found') }
    if (source.read_only) {
      if (str(source.source_tag || source.raw_source).trim().toLowerCase() !== 'cron') throw new HttpFailure(403, 'Read-only sessions cannot be branched from WebUI')
      source.branchSourceReadonly = true
    }
    let keepCount: number | null = null
    if (body.keep_count !== null && body.keep_count !== undefined) {
      keepCount = Number(body.keep_count)
      if (!Number.isInteger(keepCount)) throw new HttpFailure(400, 'keep_count must be an integer')
      if (keepCount < 0) throw new HttpFailure(400, 'keep_count must be non-negative')
    }
    const customTitle = body.title ? str(body.title).trim().slice(0, 80) || null : null
    if (!source.branchSourceReadonly) { try { this.store.save(source) } catch { /* ignore */ } }
    const sourceMessages = source.messages
    const forked = keepCount !== null ? sourceMessages.slice(0, keepCount) : [...sourceMessages]
    const title = customTitle ?? `${source.title || 'Untitled'} (fork)`
    const forkKeep = keepCount ?? sourceMessages.length
    const forkedContext = copyJson(truncateContextForDisplayKeep(source.context_messages, sourceMessages, forkKeep))
    const branch = new Session(
      {
        workspace: source.workspace, model: source.model, model_provider: source.model_provider, profile: source.profile, title, messages: forked, project_id: source.project_id,
        personality: source.personality, enabled_toolsets: source.enabled_toolsets, context_length: source.context_length, threshold_tokens: source.threshold_tokens,
        context_messages: forkedContext, gateway_routing: copyJson(source.gateway_routing), context_engine: source.context_engine, context_engine_state: copyJson(source.context_engine_state),
        parent_session_id: source.session_id, session_source: 'fork',
      },
      { workspace: source.workspace, model: source.model },
    )
    this.store.touch(branch)
    if (forked.length) {
      this.store.save(branch)
      this.publish('session_branch', branch.profile, branch.session_id)
    }
    return { session_id: branch.session_id, title, parent_session_id: source.session_id }
  }

  async delete(sid: string): Promise<Record<string, unknown>> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    if (!isSafeSessionId(sid)) throw new HttpFailure(400, 'Invalid session_id')
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot be deleted from WebUI')
    const retained = (() => { try { return worktreeRetainedPayload(this.store.get(sid, { metadataOnly: true })) } catch { return {} } })()
    let eventProfile: string | null = null
    try { eventProfile = this.store.get(sid, { metadataOnly: true }).profile } catch { eventProfile = null }
    const blocking = (): string | null => {
      const live = this.deps.runtime.activeRunStream(sid)
      if (live) return live
      try {
        const snapshot = this.store.get(sid, { metadataOnly: true })
        const candidate = str(snapshot.active_stream_id).trim()
        if (candidate && this.deps.runtime.activeStreamIds.has(candidate)) return candidate
      } catch { /* absent */ }
      return null
    }
    if (blocking()) throw new HttpFailure(409, 'Session has an active run; stop it before deleting')
    try {
      await this.store.withLock(sid, () => {
        if (blocking()) throw new HttpFailure(409, 'Session has an active run; stop it before deleting')
        if (!this.store.deleteFiles(sid)) throw new HttpFailure(500, 'Failed to delete session data')
      }, { timeoutMs: 5000 })
    } catch (error) {
      if (error instanceof SessionBusy) throw new HttpFailure(503, 'Session busy, try again')
      throw error
    }
    this.deps.runtime.evictAgent(sid)
    try { rmSync(this.deps.attachmentDir(sid), { recursive: true, force: true }) } catch { /* ignore */ }
    this.deps.runtime.closeTerminal(sid)
    this.publish('session_delete', eventProfile)
    return { ok: true, state_db_cleanup_failed: false, ...retained }
  }

  cleanup(zeroOnly: boolean): Record<string, unknown> {
    let cleaned = 0
    const removed = new Set<string>()
    for (const s of this.store.scanAll()) {
      const shouldDelete = zeroOnly ? s.messages.length === 0 : s.title === 'Untitled' && s.messages.length === 0
      if (!shouldDelete) continue
      this.store.sessions.delete(s.session_id)
      rmSync(this.store.pathFor(s.session_id), { force: true })
      cleaned += 1
      removed.add(s.session_id)
    }
    this.store.invalidatePersistedIds()
    let rewroteIndex = false
    try {
      const rows = this.store.readIndexEntries()
      const live = this.store.persistedIds()
      const survivors = rows.filter((entry) => {
        const id = str(entry.session_id)
        if (!id || live.has(id) || this.store.sessions.has(id)) return true
        if (removed.has(id)) return false
        cleaned += 1
        return false
      })
      if (survivors.length < rows.length) {
        this.store.writeIndex()
        rewroteIndex = true
      }
    } catch { /* corrupt index is rebuilt below */ }
    if (removed.size && !rewroteIndex) { try { this.store.writeIndex() } catch { /* ignore */ } }
    return { ok: true, cleaned }
  }

  import(body: Record<string, unknown>): Record<string, unknown> {
    const messages = stripPublicInternalFields(body.messages, { messageRecords: true })
    if (!Array.isArray(messages)) throw new HttpFailure(400, 'JSON must contain a "messages" array')
    const rawToolCalls = body.tool_calls ?? []
    if (!Array.isArray(rawToolCalls)) throw new HttpFailure(400, 'JSON "tool_calls" must be an array')
    let workspace: string
    try {
      workspace = this.deps.workspaces.resolveTrusted(typeof body.workspace === 'string' ? body.workspace : null)
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const defaults = this.store.deps.defaults(this.deps.activeProfile())
    const s = new Session(
      { title: typeof body.title === 'string' ? body.title : 'Imported session', workspace, model: typeof body.model === 'string' ? body.model : defaults.model, messages: messages as Message[], tool_calls: stripPublicInternalFields(rawToolCalls) as Record<string, unknown>[], profile: this.deps.activeProfile() },
      defaults,
    )
    s.pinned = Boolean(body.pinned)
    this.store.touch(s)
    this.store.save(s)
    this.publish('session_import')
    return { ok: true, session: this.publicSession(s) }
  }

  // ── drafts ───────────────────────────────────────────────────────────────

  readDraft(sid: string): Record<string, unknown> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    let hasSidecar: boolean
    try { hasSidecar = this.deps.drafts.exists(sid) } catch { throw new HttpFailure(400, 'Invalid session_id') }
    if (hasSidecar) {
      const cached = this.store.sessions.get(sid)
      if (!cached && !existsSessionFile(this.store, sid)) throw new HttpFailure(404, 'Session not found')
      const [draft, version] = this.deps.drafts.readState(sid)
      if (cached) cached.composer_draft = draft
      return { draft, draft_version: version }
    }
    const s = this.get404(sid, { metadataOnly: true })
    const [draft, version] = this.deps.drafts.readState(sid, s.composer_draft)
    return { draft, draft_version: version }
  }

  async writeDraft(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sid = str(body.session_id)
    if (!sid) throw new HttpFailure(400, 'Missing required field(s): session_id')
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot store a draft from WebUI')
    let text = body.text
    let files = body.files
    if (text !== null && text !== undefined && typeof text !== 'string') text = ''
    if (typeof text === 'string' && text.length > 50_000) text = text.slice(0, 50_000)
    if (files !== null && files !== undefined && !Array.isArray(files)) files = []
    if (Array.isArray(files) && files.length > 50) files = files.slice(0, 50)
    try { this.deps.drafts.path(sid) } catch { throw new HttpFailure(400, 'Invalid session_id') }
    let draftVersion: string | null
    try {
      draftVersion = normalizeDraftVersion(body.draft_version)
    } catch {
      throw new HttpFailure(400, 'Invalid draft_version')
    }
    if (draftVersion !== null) {
      const maxVersion = BigInt(Math.trunc((this.deps.now() + 300) * 1_000_000)) + 999n
      if (BigInt(draftVersion) > maxVersion) throw new HttpFailure(400, 'draft_version is too far in the future')
    }
    return this.store.withLock(sid, () => {
      let s = this.store.sessions.get(sid) ?? null
      if (s && s.session_id !== sid) s = null
      const sessionExists = existsSessionFile(this.store, sid)
      if (!s) {
        if (!sessionExists) throw new HttpFailure(404, 'Session not found')
        if (!this.deps.drafts.exists(sid)) s = this.get404(sid, { metadataOnly: true })
      }
      const [currentDraft, currentVersion] = this.deps.drafts.readState(sid, s?.composer_draft)
      const next = { ...currentDraft }
      if (text !== null && text !== undefined) next.text = text as string
      if (files !== null && files !== undefined) next.files = files as unknown[]
      let versionCmp: number | null = null
      if (currentVersion !== null) {
        versionCmp = draftVersion === null ? -1 : Number(BigInt(draftVersion) - BigInt(currentVersion) > 0n) - Number(BigInt(draftVersion) - BigInt(currentVersion) < 0n)
        if (versionCmp < 0 || (versionCmp === 0 && JSON.stringify(next) !== JSON.stringify(currentDraft))) {
          throw new HttpFailure(409, 'Composer draft changed in another request', { draft: currentDraft, draft_version: currentVersion })
        }
      }
      let unchanged = false
      let saved = currentDraft
      if (JSON.stringify(next) === JSON.stringify(currentDraft) && (draftVersion === null || versionCmp === 0)) unchanged = true
      else {
        const cachedOwnerIsCurrent = s !== null && this.store.sessions.get(sid) === s
        if (!sessionExists && !cachedOwnerIsCurrent) throw new HttpFailure(404, 'Session not found')
        if (!sessionExists && s) {
          s.composer_draft = next
          this.store.save(s, { touchUpdatedAt: false })
        }
        try {
          saved = this.deps.drafts.write(sid, next, draftVersion)
        } catch (error) {
          if (error instanceof DraftVersionConflict) throw new HttpFailure(409, error.message, { draft: error.currentDraft, draft_version: error.currentVersion })
          throw error
        }
        if (s) s.composer_draft = saved
      }
      const payload: Record<string, unknown> = { ok: true, draft: saved, draft_version: draftVersion ?? currentVersion }
      if (unchanged) payload.unchanged = true
      return payload
    })
  }

  // ── anchor scenes ────────────────────────────────────────────────────────

  async saveAnchorScene(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sid = str(body.session_id).trim()
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    if (body.scene === undefined) throw new HttpFailure(400, 'Missing required field(s): scene')
    let s: Session
    try {
      s = this.getForMutation(sid)
    } catch (error) {
      if (error instanceof SessionNotFound) throw new HttpFailure(404, 'Session not found')
      if (error instanceof HttpFailure && error.status === 403) throw new HttpFailure(403, 'Read-only imported sessions cannot persist anchor scenes')
      throw error
    }
    if (!this.visibleToActiveProfile(s.profile)) throw new HttpFailure(404, 'Session not found')
    return this.store.withLock(sid, () => {
      let placement
      try {
        placement = storeAnchorScene(s, body, this.deps.now())
      } catch (error) {
        throw new HttpFailure(400, (error as Error).message)
      }
      if (!placement) throw new HttpFailure(404, 'Assistant message not found')
      this.store.save(s, { touchUpdatedAt: false, skipIndex: true })
      return { ok: true, ...placement }
    })
  }

  readAnchorScene(query: Record<string, string | null | undefined>): Record<string, unknown> {
    const sid = str(query.session_id).trim()
    const messageRef = normalizeAnchorSceneMessageRef(query.message_ref)
    const messageIndex = anchorSceneIntOrNull(query.message_index)
    if (!sid || (!messageRef && messageIndex === null)) throw new HttpFailure(400, 'session_id and message_ref or message_index are required')
    let session: Session
    try {
      session = this.store.get(sid)
      if (session.loadedMetadataOnly) session = this.store.load(sid) ?? session
    } catch {
      throw new HttpFailure(404, 'Session not found')
    }
    if (!this.visibleToActiveProfile(session.profile)) throw new HttpFailure(404, 'Session not found')
    const result = readAnchorSceneRows(session, { messageRef, messageIndex, before: anchorSceneIntOrNull(query.before), limit: anchorSceneIntOrNull(query.limit) })
    if (!result) throw new HttpFailure(404, 'Anchor activity scene not found')
    return result
  }

  // ── shares ───────────────────────────────────────────────────────────────

  createShare(sid: string): Record<string, unknown> {
    let s = this.get404(sid)
    if (!this.visibleToActiveProfile(s.profile)) throw new HttpFailure(404, 'Session not found')
    s = this.store.ensureFull(sid, s)
    let snapshot
    try {
      snapshot = buildShareSnapshot(s, s.messages, { hermesHome: this.deps.hermesHome, attachmentRoot: this.deps.attachmentDir('').replace(/\/[^/]*$/, ''), home: this.deps.home })
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const meta = this.deps.shares.createOrRefresh(s, snapshot)
    s.share_token = meta.share_token
    s.share_created_at = meta.share_created_at
    this.store.save(s, { touchUpdatedAt: false })
    this.publish('session_share_create', s.profile, sid)
    return {
      ok: true,
      share: { token: meta.share_token, url: `/share/${meta.share_token}`, title: meta.share_title, message_count: meta.share_message_count, created_at: meta.share_created_at, updated_at: meta.share_updated_at },
      session: this.publicSession(s),
    }
  }

  revokeShare(sid: string): Record<string, unknown> {
    let s = this.get404(sid)
    if (!this.visibleToActiveProfile(s.profile)) throw new HttpFailure(404, 'Session not found')
    s = this.store.ensureFull(sid, s)
    this.deps.shares.revoke(s)
    s.share_token = null
    s.share_created_at = null
    this.store.save(s, { touchUpdatedAt: false })
    this.publish('session_share_revoke', s.profile, sid)
    return { ok: true, session: this.publicSession(s) }
  }

  loadShare(token: string): Record<string, unknown> {
    const share = this.deps.shares.load(token)
    if (!share) throw new HttpFailure(404, 'Shared conversation not found')
    return { share }
  }

  // ── yolo ─────────────────────────────────────────────────────────────────

  yolo(sid: string): Record<string, unknown> {
    if (!sid) throw new HttpFailure(400, 'Missing session_id')
    return { yolo_enabled: this.deps.yolo.isEnabled(sid) }
  }

  setYolo(sid: string, enabled: boolean): Record<string, unknown> {
    if (!sid) throw new HttpFailure(400, 'Missing required field(s): session_id')
    this.deps.yolo.set(sid, enabled)
    return { ok: true, yolo_enabled: this.deps.yolo.isEnabled(sid) }
  }
}

function existsSessionFile(store: SessionStore, sid: string): boolean {
  return store.persistedIds().has(sid)
}

import { createHash } from 'node:crypto'
function hashRevision(signature: string): string {
  return createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 32)
}

export const AUTO_TITLE_LABELS = new Set(['untitled', 'new chat'])

/** Python `apply_session_title_rename`. */
export function applySessionTitleRename(session: Session, rawTitle: unknown): string {
  let title = str(rawTitle).trim().slice(0, 80)
  if (!title) title = 'Untitled'
  session.title = title
  session.manual_title = !AUTO_TITLE_LABELS.has(title.trim().toLowerCase())
  session.llm_title_generated = false
  return title
}

export function markSessionTitleGenerated(session: Session): void {
  session.llm_title_generated = true
  session.manual_title = false
}

function findLastUserIndex(history: unknown[]): number | null {
  for (let i = history.length - 1; i >= 0; i -= 1) if (isDict(history[i]) && (history[i] as Message).role === 'user') return i
  return null
}

function truncationWatermarkFor(messages: unknown[]): number {
  if (!messages.length) return 0.0
  const last = messages[messages.length - 1]
  const ts = isDict(last) ? Number(last.timestamp ?? 0) : 0
  return Number.isFinite(ts) ? ts : 0.0
}

function stampIntentionalShrink(session: Session, oldCount: number, newCount: number): boolean {
  if (newCount >= oldCount) return false
  session.intentional_shrink_generation = randomUUID().replace(/-/g, '')
  return true
}

/** Align model context with the display prefix (Python `truncate_context_for_display_keep`, simplified to the row-count contract). */
export function truncateContextForDisplayKeep(context: Message[] | null | undefined, full: unknown[], keep: number): Message[] {
  if (keep <= 0) return []
  const rows = context ?? []
  if (!rows.length) return []
  if (keep >= full.length) return [...rows]
  // ponytail: context rows map 1:1 onto display rows for WebUI-authored transcripts; fuzzy alignment stays in Python until compression lands.
  return rows.slice(0, Math.min(rows.length, keep))
}

export function truncateSessionAtKeep(session: Session, keep: number): [number, number] {
  const full = [...session.messages]
  const oldMsgCount = full.length
  const oldCtxCount = session.context_messages.length
  session.messages = full.slice(0, keep)
  stampIntentionalShrink(session, oldMsgCount, session.messages.length)
  session.context_messages = truncateContextForDisplayKeep(session.context_messages, full, keep)
  session.truncation_watermark = truncationWatermarkFor(session.messages)
  session.truncation_boundary = session.truncation_watermark
  return [oldMsgCount, oldCtxCount]
}

function shrinkTo(session: Session, lastUserIdx: number): void {
  const history = session.messages
  session.messages = history.slice(0, lastUserIdx)
  stampIntentionalShrink(session, history.length, session.messages.length)
  session.truncation_watermark = truncationWatermarkFor(session.messages)
  session.truncation_boundary = session.truncation_watermark
  if (session.context_messages.length) {
    const ctxLast = findLastUserIndex(session.context_messages)
    if (ctxLast !== null) session.context_messages = session.context_messages.slice(0, ctxLast)
  }
}

/** Python `_extract_text`: flatten content to the user-typed text. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const p of content) {
      if (!isDict(p)) continue
      const type = str(p.type).toLowerCase()
      if (!['', 'text', 'input_text', 'output_text'].includes(type)) continue
      parts.push(str(p.text || p.content || p.input_text || p.output_text))
    }
    return parts.join(' ')
  }
  return str(content)
}

export function worktreeRetainedPayload(session: Session | null): Record<string, unknown> {
  const path = session?.worktree_path
  if (!path) return {}
  const payload: Record<string, unknown> = { worktree_retained: true, worktree_path: path }
  if (session?.worktree_branch) payload.worktree_branch = session.worktree_branch
  if (session?.worktree_repo_root) payload.worktree_repo_root = session.worktree_repo_root
  return payload
}

export { titleFrom }
