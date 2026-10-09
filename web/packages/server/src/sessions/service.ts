/**
 * Route-level session operations (the Python `/api/session*` handlers): the
 * detail payload, list and search, and every mutation with its guards.
 * Runtime concerns owned by other domains arrive through `SessionServiceDeps`.
 */
import type { PendingSteer, RecoveryAudit, RecoveryRepair } from '@maudecode/talaria-web-contracts'
import type { RunJournal } from './journal.js'
import { str } from '../util.js'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildActiveTurnToken, copyJson, redactSessionData, redactValue, stripPublicInternalFields, withSceneToolDisplay } from '../redact.js'
import type { DraftStore } from './drafts.js'
import { DraftVersionConflict, normalizeDraftVersion } from './drafts.js'
import type { SessionEventBus } from './events.js'
import { allSessions, buildSessionListPayload, CLI_IDENTITY_FIELDS, isClaimableCliSource, isMessagingSessionRecord, withOwnerLocks, withSessionWireFlags, lineageRootId, mergeCliSidebarMetadata, sessionListResponse, sessionSearchMatches, sessionSearchMessageText, sessionSearchPreview, sessionSearchTerms, type ListParams, type ListResponse, type Row, type RuntimeOverlay } from './list.js'
import { anchorSceneIntOrNull, fullToolResult, hydrateAnchorActivityScenes, normalizeAnchorSceneMessageRef, readAnchorSceneRows, storeAnchorScene, withTurnIds } from './anchor.js'
import { COMPRESSION_RECOVERY_ACTION_START_FOCUSED, compressionRecoveryPayload, isSafeSessionId, lastMessageTimestamp, Session, sharePath, stripAttachedFilesMarker, titleFrom, type Message } from './session.js'
import { SessionBusy, SessionNotFound, statSignature, type SessionStore } from './store.js'
import { UNSETTLED_TODO_KEY, attachTodoState } from './todo.js'
import { isClaudeCodeSessionId, type ClaudeCodeSessionSource } from './claude-code.js'
import { auditSessionRecovery, repairSafeSessionRecovery, type RecoveryDeps } from './recovery.js'
import { CONVERSATION_ROUND_THRESHOLD, countConversationRounds, stateDbCompressionLineage, stateDbTailToolContent, stateDbLineageReport, stateDbSessionMessages, stateDbSessionRead, stateDbSessionRow, stateDbSessionSources, stateDbTimestampSeconds, type StateDbRead } from './state-db.js'
import { completionIncomplete, fallbackHandoffSummary, HANDOFF_SYSTEM_PROMPT, handoffMarker, handoffPayload, handoffTranscript, messageHandoffPayload, sameHandoff } from './handoff.js'
import { anchorMessageKey, anchorSummary, CompressionJobs, compressionReference, visibleMessagesForAnchor, type CompressionJob } from './compress.js'
import { SidecarError, type SidecarLike } from '../sidecar/client.js'
import { agentSteerText, attachedFilesPrompt, attachmentObjects, dedupeContext, isContextCompressionMarker, journalOutputRows, looksLikeCurrentUserTurn, stoppedTurnContext, workspaceContextPrefix, mergeSessionMessagesAppendOnly, messageIdentity, pendingUserRow, reasoningFieldsText, sanitizeMessagesForApi, stateDbSeenId, stripWorkspacePrefix, withAttachmentObjects, withBodyExcerpts, withDisplayMedia, withMarkerKinds, withSceneRowMedia, withPendingUserTurn, withToolCallOutcomes, withoutRunningTurnOutput, type ToolResultView } from './merge.js'
import { withBackgroundUpdates } from './background-updates.js'
import { withBackgroundLinks, type Receipt } from './background-tasks.js'
import { messagesForLimitedPayload, messageWindowForDisplay, MAX_MSG_LIMIT, parseMsgLimit, toolCallsForMessageWindow } from './window.js'
import { redactText } from '../redact.js'
import { workspaceDisplayName, type WorkspaceEntry, type WorkspaceRegistry } from '../workspace/workspaces.js'
import { buildShareSnapshot, type ShareStore } from './shares.js'
import { mediaAnchorRoot, mediaRefPath, mediaTarget, type MediaAccessDeps } from '../workspace/media.js'
import { projectMediaRefs, type MediaProjection } from '../workspace/media-refs.js'
import type { ProjectStore } from '../projects.js'
import { loadGatewaySessionIdentityMap } from './list.js'
import { join } from 'node:path'

export class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HttpFailure'
  }
}

/**
 * Python `_agent_runtime_barrier_response`: a stale local Agent checkout is refused with a typed 409 before the caller
 * mutates anything. Any other failure of the check is not a verdict and lets the caller proceed.
 */
export async function ensureAgentRuntimeCurrent(sidecar: SidecarLike | null): Promise<void> {
  if (!sidecar) return
  try {
    await sidecar.call('runtime.ensure_current', {})
  } catch (error) {
    if (error instanceof SidecarError && error.condition === 'agent_runtime_stale') throw staleRuntimeFailure(error)
  }
}

function staleRuntimeFailure(error: SidecarError): HttpFailure {
  return new HttpFailure(409, error.message, { type: 'agent_runtime_stale', retryable: true, restart_scheduled: false, ...(error.data.agent_update_state !== undefined ? { agent_update_state: error.data.agent_update_state } : {}) })
}

export interface SessionServiceDeps {
  /** TAL-259: epoch seconds of the state directory's `recovery_stamping_since` marker. */
  recoveryStampingSince: () => number
  /** TAL-255: the Agent sidecar for manual compression (`chat.compress`); null while it is down. */
  sidecar?: () => SidecarLike | null
  /** Detached sidecar work for a profile: deletion waits for the returned release, so the home outlives the work. */
  profileActivity?: (profile: string | null) => () => void
  /** A profile whose deletion has started takes no new detached work. */
  profileDeleting?: (profile: string | null) => boolean
  /** TAL-372: the session's background work receipts, for the delegation rows that started them. */
  backgroundReceipts?: (sid: string) => Receipt[]
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
  /** The agent's display name for a session's profile (`assistant_name`). */
  assistantName: (profile: string | null) => string
  redactEnabled: () => boolean
  pinnedSessionsLimit: () => number
  runtime: RuntimeOverlay & {
    /** A live worker stream that must block deletion / duplicate turns for this session. */
    activeRunStream: (sid: string) => string | null
    /** A live run whose journal missed a frame, so a replay cannot restore its whole output. */
    journalDegraded: (streamId: string) => boolean
    /** TAL-424: the live stream's pending steers, as clients show them. */
    pendingSteers?: (streamId: string) => PendingSteer[]
    /** Drop the session's cached agent; `endSession` (delete/clear) also ends its approval grants and parked approvals. */
    evictAgent: (sid: string, endSession?: boolean) => void
    closeTerminal: (sid: string) => void
    /** Python `delete_cli_session`: remove the session's rows from the profile's state.db; resolves false on failure. */
    deleteCliSession: (profile: string | null, sid: string) => Promise<boolean>
  }
  attachmentDir: (sid: string) => string
  /** A deleted session can never be viewed, so its finished runs are cleared from the relay. */
  clearRelayCompletions?: (sid: string, profile: string | null) => void
  /** Run journals are removed with their session (Python `delete_run_journal`). */
  journal?: RunJournal
  hermesHome: string
  home: string
  /** Sync title-only metadata to state.db when `sync_to_insights` is on. */
  syncTitle: (session: Session) => Promise<void>
  /** Context length lookup for a model (checkpoint 7 wires the catalog). */
  contextLengthFor: (model: string | null, provider: string | null) => number | null
  /** TAL-301: the catalog entry id a stored `(model, provider)` pair selects (null when none or not yet known). */
  modelOptionFor?: (model: string | null, provider: string | null) => string | null
  /** Builds the catalog `modelOptionFor` reads, so a first detail load already carries `model_option_id`. */
  warmModelOptions?: () => Promise<void>
  /** Authoritative lookup through the sidecar (`models.context_length`), cached; used where the caller can await. */
  resolveContextLength?: (model: string | null, provider: string | null, profile: string | null) => Promise<number | null>
  /** `(model, provider)` normalisation from a request (checkpoint 7 wires provider-qualified ids). */
  modelStateFromRequest: (model: unknown, requestedProvider: unknown, currentProvider: string | null) => [string | null, string | null]
  /** TAL-542: the pair a stale session model starts on, from the profile's catalog; `null` keeps it. */
  repairSessionModel?: (profile: string | null, model: string, provider: string | null) => [string, string] | null
  /** TAL-542: builds the catalog `repairSessionModel` reads unless a fresh enough one exists. */
  warmSessionModelRepair?: (profile?: string | null) => Promise<void>
  yolo: { isEnabled: (sid: string) => boolean; set: (sid: string, enabled: boolean) => void }
  /** state.db sidebar rows for a profile (Python `get_cli_sessions`); null when the projection is unavailable. */
  /** `truncated`: source kinds whose rows stopped at the per-kind window on this read (TAL-482). */
  cliSessions: (profile: string, opts: { sourceFilter: string | null }) => { rows: Row[]; truncated: ReadonlySet<string> }
  /** TAL-551: read-only Claude Code transcripts, listed with the CLI rows when both toggles are on. */
  claudeCode?: ClaudeCodeSessionSource
  profileHome: (profile: string) => string
  /** Python `commit_session_memory` (fire-and-forget): the cached Agent flushes memory for a session the user left. */
  commitSessionMemory?: (sid: string) => void
  /** TAL-186: the `/api/media` allow-list the transcript media projection rewrites against; without it nothing local is rewritten. */
  media?: { access: MediaAccessDeps; localIo: (profile: string | null) => boolean }
}

/** TAL-536: the most of a dead run's journal stale-stream cleanup reads (Python's recovery window). */
const RECOVERY_JOURNAL_MAX_BYTES = 8 * 1024 * 1024
const RECOVERY_JOURNAL_MAX_ROWS = 65536
const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export class SessionService {
  /** TAL-255: one manual compression worker per session, shared by every compress route. */
  private readonly compressionJobs: CompressionJobs

  constructor(readonly deps: SessionServiceDeps) {
    this.compressionJobs = new CompressionJobs()
  }

  private get store(): SessionStore { return this.deps.store }

  /**
   * TAL-186: rewrites a session's media references to their URLs. A local path is rewritten only when `/api/media`
   * serves it for this session, under the same resolution, so every rewritten reference loads.
   */
  mediaProjector(s: Session): (text: string) => MediaProjection | null {
    const media = this.deps.media
    const served = new Map<string, string | null>()
    const localUrl = (path: string): string | null => {
      if (!media?.localIo(s.profile)) return null
      if (served.has(path)) return served.get(path) ?? null
      let url: string | null = null
      try {
        const target = mediaTarget(mediaRefPath(path))
        if (mediaAnchorRoot(target, s, media.access)) url = `./api/media?${new URLSearchParams({ path: target, session_id: s.session_id }).toString()}`
      } catch { /* an invalid path stays text */ }
      served.set(path, url)
      return url
    }
    const workspace = s.workspace.trim() || null
    // A scene's final answer usually repeats its row's text: each distinct text is parsed once.
    const projected = new Map<string, MediaProjection | null>()
    return (text) => {
      if (!projected.has(text)) projected.set(text, projectMediaRefs(text, { workspace, localUrl }))
      return projected.get(text) ?? null
    }
  }

  publish(reason: string, profile?: string | null, sessionId?: string | null): void {
    this.deps.events.publish(reason, { profile: profile ?? null, sessionId: sessionId ?? null })
  }

  visibleToActiveProfile(profile: string | null | undefined): boolean {
    return this.deps.profilesMatch(typeof profile === 'string' ? profile : null, this.deps.activeProfile())
  }

  /**
   * Python `_session_id_visible_to_request_profile`, applied to the id as handlers see it (trimmed): a padded id must
   * not slip past the profile check into a handler that trims and trusts it. A non-empty id that is still unsafe after
   * trimming can name no session and is refused here instead of falling through.
   */
  sessionIdVisible(raw: unknown): boolean {
    if (typeof raw !== 'string' || !raw.trim()) return true
    const sid = raw.trim()
    if (!isSafeSessionId(sid)) return false
    let session: Session
    try {
      session = this.store.get(sid, { metadataOnly: true })
    } catch {
      return true
    }
    return this.visibleToActiveProfile(session.profile)
  }

  /** Python `_lookup_cli_session_metadata(...).get('read_only')` plus the persisted sidecar flag and a not-claimable foreign owner. */
  private isReadOnlyImport(sid: string): boolean {
    try {
      const s = this.store.get(sid, { metadataOnly: true })
      if (this.isReadOnly(s)) return true
    } catch {
      // No sidecar: a foreign state.db transcript whose owner refuses claiming is read-only too.
      const { session, reason } = this.claimOrSynthesizeCliSession(sid)
      if (session && reason === 'not_claimable') return true
    }
    const meta = this.lookupCliMeta(sid)
    return meta !== null && Boolean(meta.read_only)
  }

  /** Python `_session_is_subagent_view_only`: a delegated child by any signal — the persisted sidecar or the state.db row. */
  isSubagentViewOnly(sid: string): boolean {
    try {
      const s = this.store.get(sid)
      if (str(s.source_tag || s.raw_source || s.session_source).trim().toLowerCase() === 'subagent') return true
    } catch { /* no sidecar */ }
    const meta = this.lookupCliMeta(sid)
    return meta !== null && str(meta.source_tag || meta.raw_source || meta.source).trim().toLowerCase() === 'subagent'
  }

  /** TAL-358: batched `sessions.source` owners from the active profile's state.db. */
  readonly stateDbSources = (ids: string[]): Map<string, string> | null => stateDbSessionSources(join(this.deps.profileHome(this.deps.activeProfile()), 'state.db'), ids)

  /** The persisted flag folded with the state.db owner lock (TAL-358): the one read-only rule for mutation gates and the wire. */
  isReadOnly(s: Session): boolean {
    if (s.read_only) return true
    const [row] = withOwnerLocks([{ session_id: s.session_id, source_tag: s.source_tag, raw_source: s.raw_source, session_source: s.session_source }], this.stateDbSources)
    return Boolean(row?.read_only)
  }

  /** Full session for mutation, refusing read-only imports (Python `_get_or_materialize_session`). */
  getForMutation(sid: string): Session {
    let s = this.get404(sid)
    s = this.store.ensureFull(sid, s)
    if (this.isReadOnly(s)) throw new HttpFailure(403, 'Read-only imported sessions cannot be modified from WebUI')
    if (str(s.source_tag || s.raw_source).trim().toLowerCase() === 'subagent') throw new HttpFailure(403, 'Read-only subagent child session')
    return s
  }

  private get404(sid: string, opts: { metadataOnly?: boolean } = {}): Session {
    try {
      return this.store.get(sid, opts)
    } catch (error) {
      if (error instanceof SessionNotFound) {
        // Python `_get_or_materialize_session`: a claimable foreign (CLI/TUI/Desktop) session gains a WebUI sidecar
        // on its first mutation; a read-only foreign source answers 403 from `getForMutation`, a missing one 404.
        const synth = this.claimOrSynthesizeCliSession(sid)
        if (synth.session && synth.reason === 'materialized') { this.store.save(synth.session); return synth.session }
        if (synth.session) return synth.session
        throw new HttpFailure(404, 'Session not found')
      }
      throw error
    }
  }

  /** The Agent's state.db rows for this session (empty for subagent views, which never merge). */
  stateDbRows(s: Session): Message[] {
    return this.stateDbRead(s).rows
  }

  /** `stateDbRows` and whether the read succeeded on a state.db whose messages carry ids (TAL-493). */
  stateDbRead(s: Session): StateDbRead {
    if (str(s.source_tag || s.raw_source || s.session_source).trim().toLowerCase() === 'subagent') return { rows: [], idCapable: false, ok: false }
    // TAL-529: after a compression rotation the Agent writes to the continuation, so the read follows the recorded lineage.
    const lineage = s.state_db_lineage?.[0] === s.session_id ? s.state_db_lineage : null
    return stateDbSessionRead(this.stateDbPath(s.profile), s.session_id, { stitch: false, lineage })
  }

  private stateDbPath(profile: string | null | undefined): string {
    return join(this.deps.profileHome(profile ?? this.deps.activeProfile()), 'state.db')
  }

  /**
   * Python `_merged_session_messages_for_display`: the sidecar transcript merged append-only with the Agent's state.db
   * rows (a WebUI conversation continued from the CLI shows the CLI turns). This is the coordinate space `GET
   * /api/session` exposes, so branching and the next model history slice/extend the same list.
   */
  mergedTranscript(s: Session, local: Message[] = s.messages, stateRows: Message[] = this.stateDbRows(s)): Message[] {
    if (!stateRows.length) return local
    return mergeSessionMessagesAppendOnly(local, stateRows, { truncationWatermark: s.truncation_watermark, compressedWatermark: s.truncation_watermark_compressed, stateDbSeenId: currentStateDbSeenId(s, stateRows) })
  }

  /**
   * TAL-493: record the highest state.db id this boundary or settled turn read, under the session lock in the same save,
   * so the merge never replays a covered row and appends every row committed after the read. Call it after the boundary
   * fields are set: the marker holds only while they and the row it names stay as recorded.
   */
  markStateDbSeen(s: Session, read: StateDbRead = this.stateDbRead(s), opts: { boundary?: boolean } = {}): void {
    // A failed read says nothing. A settlement keeps the marker; a boundary drops it (fail closed): it may cut rows the
    // marker still admits without moving a field, and the timestamp rules honour its watermark.
    if (!read.ok) {
      if (opts.boundary) { s.state_db_seen_id = null; s.state_db_seen_boundary = null; s.state_db_seen_stamp = null }
      return
    }
    // A successful read with no rows yet is a baseline: every row the session gets later is new.
    s.state_db_seen_id = stateDbSeenId(read.rows) ?? (read.idCapable ? 0 : null)
    s.state_db_seen_boundary = stateDbMarkKey(s, read.rows, s.state_db_seen_id)
    s.state_db_seen_stamp = s.updated_at
  }

  /**
   * TAL-493: a turn's settlement. Each state.db row the merge shows now is matched to what the turn holds: a row already
   * in the context it started from (by id), or one row the Agent added this turn (`agentRows` past that context, matched
   * one to one by full text). An unmatched row is a CLI or gateway row committed while the turn ran: it joins the
   * transcript and the model context before the marker passes it. Without the Agent's rows (`agentRows` empty), rows past
   * `startId` (the highest id the turn read when it started) are its own unreported work: covered, never shown. Rows the
   * turn started from but the transcript lacks (a CLI continuation read into its context) are kept before the turn.
   */
  settleStateDb(s: Session, turn: { turnId: string; previousContext: Message[]; agentRows?: Message[] | null; startId?: number | null }): void {
    const read = this.stateDbRead(s)
    const startedWith = new Set(turn.previousContext.flatMap((m) => (typeof m._state_db_row_id === 'number' ? [m._state_db_row_id] : [])))
    const earlier = mergeSessionMessagesAppendOnly(s.messages, read.rows.filter((m) => typeof m._state_db_row_id === 'number' && startedWith.has(m._state_db_row_id)), { stateDbSeenId: -1 }).slice(s.messages.length)
    const added = new Map<string, number>()
    for (const m of withoutRows(turn.agentRows ?? [], turn.previousContext)) added.set(settledIdentity(m), (added.get(settledIdentity(m)) ?? 0) + 1)
    const ownWorkAfter = turn.agentRows?.length ? null : turn.startId ?? null
    // Without a current marker, the turn's own starting read is the baseline: rows committed after it are judged here.
    const seenId = currentStateDbSeenId(s, read.rows) ?? turn.startId ?? null
    const shown = read.rows.length ? mergeSessionMessagesAppendOnly(s.messages, read.rows, { truncationWatermark: s.truncation_watermark, compressedWatermark: s.truncation_watermark_compressed, stateDbSeenId: seenId }) : s.messages
    const fresh = new Set(shown.slice(s.messages.length))
    // The turn's own rows the merge already matched to their local copies use up their share before any shown row can.
    if (seenId !== null) {
      for (const m of read.rows) {
        const id = m._state_db_row_id
        if (typeof id !== 'number' || id <= seenId || startedWith.has(id) || fresh.has(m)) continue
        const left = added.get(settledIdentity(m)) ?? 0
        if (left > 0) added.set(settledIdentity(m), left - 1)
      }
    }
    const missed = [...fresh].filter((m) => {
      const id = m._state_db_row_id
      if (typeof id === 'number' && startedWith.has(id)) return false
      const key = settledIdentity(m)
      const left = added.get(key) ?? 0
      if (left > 0) { added.set(key, left - 1); return false }
      return !(ownWorkAfter !== null && typeof id === 'number' && id > ownWorkAfter)
    })
    if (earlier.length) {
      const at = s.messages.findIndex((m) => m._turn_id === turn.turnId)
      s.messages.splice(at < 0 ? s.messages.length : at, 0, ...copyJson(earlier))
    }
    if (missed.length) {
      s.messages.push(...copyJson(missed))
      if (s.context_messages.length) s.context_messages.push(...copyJson(missed))
    }
    this.markStateDbSeen(s, read)
    // TAL-529: a compression rotation moved the Agent to a continuation, whose first rows restate the compressed context.
    // The read follows the new lineage from here, and everything it holds now is covered.
    // ponytail: a CLI row committed to the continuation before this settlement is covered with them; telling them apart
    // needs the Agent to mark the rows it writes at rotation.
    const lineage = stateDbCompressionLineage(this.stateDbPath(s.profile), s.session_id)
    if (JSON.stringify(lineage) !== JSON.stringify(s.state_db_lineage ?? [s.session_id])) {
      s.state_db_lineage = lineage.length > 1 ? lineage : null
      this.markStateDbSeen(s)
    }
  }

  /**
   * Python `reconciled_state_db_messages_for_session(prefer_context=True)`: the model history is the owner context
   * extended append-only with the Agent's state.db rows (a CLI continuation of this session reaches the model), except
   * for a compressed context whose anchor cannot be verified — that stays context-only.
   */
  modelContext(s: Session, stateRows?: Message[]): Message[] {
    const local: Message[] = s.context_messages.length ? s.context_messages : s.messages.filter((m) => !m._error && !m._partial)
    return local.some((m) => isContextCompressionMarker(m)) ? local : this.mergedTranscript(s, local, stateRows ?? this.stateDbRows(s))
  }

  /**
   * TAL-518: the model context a `/btw` clone inherits: the chat's history plus its running turn's prompt, which
   * deferred save keeps out of `messages` and `context_messages` until settlement.
   */
  sideQuestionContext(s: Session): Message[] {
    const context = structuredClone(this.modelContext(s))
    const pending = this.pendingTurn(s)
    return pending ? withPendingUserTurn(context, pending) : context
  }

  /** Python `_is_messaging_session_id`: from the WebUI metadata or the Agent's row. */
  private isMessagingSession(sid: string): boolean {
    try { if (isMessagingSessionRecord(this.store.get(sid, { metadataOnly: true }).compact())) return true } catch { /* absent */ }
    const meta = this.lookupCliMeta(sid)
    return meta !== null && isMessagingSessionRecord(meta)
  }

  /** Python `_lookup_cli_session_metadata`: the sidebar row for a state.db session in the active profile. */
  private lookupCliMeta(sid: string): Row | null {
    try {
      if (isClaudeCodeSessionId(sid)) return this.claudeCodeRows().find((r) => str(r.session_id) === sid) ?? null
      return this.deps.cliSessions(this.deps.activeProfile(), { sourceFilter: null }).rows.find((r) => str(r.session_id) === sid) ?? null
    } catch {
      return null
    }
  }

  private claudeCodeRows(): Row[] {
    return this.deps.claudeCode?.rows(this.deps.workspaces.lastWorkspace(this.deps.activeProfile())) ?? []
  }

  /** Python `_session_index_marks_was_webui`: an index row that once owned a WebUI sidecar (self-heal 404). */
  private indexMarksWasWebui(sid: string): boolean {
    let entries: Record<string, unknown>[]
    try { entries = this.store.readIndexEntries() } catch { return false }
    for (const entry of entries) {
      if (str(entry.session_id) !== sid) continue
      const explicit = [entry.source_tag, entry.raw_source, entry.session_source].map((v) => str(v).trim().toLowerCase()).filter(Boolean)
      if (explicit.some((v) => v === 'webui' || v === 'fork')) return true
      if (explicit.length) return false
      return !(entry.is_cli_session === true || Boolean(entry.read_only || entry.is_read_only))
    }
    return false
  }

  /**
   * Python `_claim_or_synthesize_cli_session`: build a `Session` from the active profile's state.db for an id without
   * a WebUI sidecar. `materialized` sessions are writeable (the caller persists the sidecar), `not_claimable` ones are
   * read-only stubs, `was_webui`/`no_foreign_state`/`invalid_sid` answer 404.
   */
  claimOrSynthesizeCliSession(sid: string, metaIn?: Row | null): { session: Session | null; reason: 'materialized' | 'not_claimable' | 'was_webui' | 'no_foreign_state' | 'invalid_sid' } {
    if (!isSafeSessionId(sid)) return { session: null, reason: 'invalid_sid' }
    const profile = this.deps.activeProfile()
    const dbPath = join(this.deps.profileHome(profile), 'state.db')
    const row = stateDbSessionRow(dbPath, sid)
    const stateDbSource = str(row?.source).trim().toLowerCase()
    const subagentChild = stateDbSource === 'subagent'
    if ((this.indexMarksWasWebui(sid) || (this.store.wasDeleted(sid) && ['', 'webui', 'fork'].includes(stateDbSource))) && !subagentChild) return { session: null, reason: 'was_webui' }
    const msgs = isClaudeCodeSessionId(sid) ? this.deps.claudeCode?.messages(sid) ?? [] : stateDbSessionMessages(dbPath, sid, { stitch: true })
    if (!msgs.length) return { session: null, reason: 'no_foreign_state' }
    const meta: Row = { ...(metaIn ?? this.lookupCliMeta(sid) ?? {}) }
    if (row) {
      if (!meta.source_tag && stateDbSource) meta.source_tag = stateDbSource
      if (!meta.raw_source && stateDbSource) meta.raw_source = stateDbSource
      if (!meta.title && row.title) meta.title = row.title
      if (!meta.model && row.model) meta.model = row.model
      if (!meta.workspace && row.cwd) meta.workspace = row.cwd
      if (!meta.created_at && row.started_at) meta.created_at = row.started_at
      if (!meta.updated_at && (row.ended_at || row.started_at)) meta.updated_at = row.ended_at || row.started_at
    }
    const claimable = isClaimableCliSource(meta, stateDbSource)
    const workspace = str(meta.workspace || meta.cwd).trim() || this.deps.workspaces.lastWorkspace(profile)
    const defaults = this.store.deps.defaults(profile)
    const session = new Session({
      session_id: sid, title: str(meta.title) || 'CLI Session', workspace, model: str(meta.model) || 'unknown', model_provider: str(meta.model_provider) || null,
      messages: msgs, created_at: Number(meta.created_at) || 0, updated_at: Number(meta.updated_at) || 0, profile: str(meta.profile) || null,
      is_cli_session: claimable ? true : !subagentChild, source_tag: str(meta.source_tag) || null, raw_source: str(meta.raw_source) || null,
      session_source: str(meta.session_source) || null, source_label: str(meta.source_label) || null, read_only: !claimable,
      // Python `import_cli_session`: the claimed sidecar keeps the row's lineage, background project and channel identity
      // (identity persists through `Session.extra`).
      parent_session_id: str(meta.parent_session_id) || null, project_id: str(meta.project_id) || null,
      ...Object.fromEntries(CLI_IDENTITY_FIELDS.filter((k) => meta[k] != null && meta[k] !== '').map((k) => [k, meta[k]])),
    }, defaults)
    return { session, reason: claimable ? 'materialized' : 'not_claimable' }
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

  /**
   * TAL-551: a Claude Code import is a live view of a transcript Claude Code keeps writing. Web never stores a copy,
   * which would freeze its messages and pin it to one profile.
   */
  private rejectClaudeCode(sid: string, verb: string): void {
    if (isClaudeCodeSessionId(sid)) throw new HttpFailure(400, `Claude Code sessions are view-only and cannot be ${verb} from WebUI`)
  }

  private rejectSubagent(sid: string, verb: string): void {
    this.rejectClaudeCode(sid, verb)
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, `Subagent sessions are view-only and cannot be ${verb} from WebUI`)
  }

  /** TAL-372: each delegation row of a turn's scene carries the status of the work it started. */
  backgroundLinked(s: Session, messages: unknown[]): unknown[] {
    return withBackgroundLinks(messages, this.deps.backgroundReceipts?.(s.session_id) ?? [])
  }

  /** `compact()` plus messages, redacted for the wire (Python `_public_session_projection`). */
  publicSession(s: Session, withMessages = true): Record<string, unknown> {
    const payload = this.wireRow(s)
    // Mutation replies replace a client's transcript, so they carry the same server-built scenes as the detail.
    if (withMessages) {
      payload.messages = this.backgroundLinked(s, hydrateAnchorActivityScenes(withToolCallOutcomes(withBackgroundUpdates(withMarkerKinds(withTurnIds(s.messages)), s), s.tool_calls, s.active_stream_id), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, runningScene: !this.journaledActiveTurn(s) }))
      payload.compression_reference = compressionReference(s, payload.messages as unknown[])
    }
    return redactSessionData(payload, this.deps.redactEnabled())
  }

  /** `compact()` with the wire streaming/read-only flags (TAL-312), for replies that return the session row. */
  wireRow(s: Session): Record<string, unknown> {
    return withSessionWireFlags({ ...s.compact({ contextLengthFor: this.deps.contextLengthFor, modelOptionFor: this.deps.modelOptionFor }), read_only: this.isReadOnly(s), assistant_name: this.assistantName(s), workspace_name: this.workspaceNames()(s) }, this.deps.runtime.activeStreamIds)
  }

  /**
   * TAL-303: the label for a session's workspace, from its own profile's registry (a profileless row is the root's).
   * One resolver serves one response, so each profile's registry is read once however many rows it names.
   */
  workspaceNames(): (row: { profile?: unknown; workspace?: unknown }) => string | null {
    const registries = new Map<string, WorkspaceEntry[]>()
    return (row) => {
      const profile = str(row.profile) || 'default'
      let entries = registries.get(profile)
      if (!entries) {
        try { entries = this.deps.workspaces.entries(profile) } catch { entries = [] }
        registries.set(profile, entries)
      }
      return workspaceDisplayName(str(row.workspace), entries)
    }
  }

  /** The agent's display name for a session's profile (`assistant_name`). */
  assistantName(s: Session): string {
    return this.deps.assistantName(s.profile)
  }

  /** Python `public_session_projection(s.__dict__)`: every persisted field, redacted (session export). */
  publicSessionDocument(s: Session): Record<string, unknown> {
    return redactSessionData(s.toDocument(), this.deps.redactEnabled())
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
      return this.foreignSessionDetail(sid)
    }
    const revisionBefore = this.loadRevision(s)
    if (!this.visibleToActiveProfile(s.profile)) {
      if (s.profile) throw new HttpFailure(409, 'Session belongs to a different profile', { code: 'session_profile_mismatch', session_id: sid, profile: s.profile })
      throw new HttpFailure(404, 'Session not found')
    }
    this.clearStaleStreamState(s)
    const journaled = loadMessages ? this.journaledActiveTurn(s) : null
    let transcript = loadMessages ? this.mergedTranscript(s) : []
    const pending = loadMessages ? this.pendingTurn(s) : null
    if (pending) transcript = withPendingUserTurn(transcript, pending)
    if (journaled)transcript = withoutRunningTurnOutput(transcript, { ...journaled, localCount: s.messages.length })
    // Turn ids, tool outcomes and scenes are computed over the full transcript, so every window reports the same values.
    const all: unknown[] = loadMessages ? this.backgroundLinked(s, hydrateAnchorActivityScenes(withToolCallOutcomes(withBackgroundUpdates(withMarkerKinds(withTurnIds(withAttachmentObjects(transcript))), s), s.tool_calls, s.active_stream_id), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, runningScene: !journaled, clipToolResults: msgLimit !== null })) : []
    let truncated: unknown[] = []
    let offset = 0
    let summaryCount: number | null = null
    let summaryLast: number | null = null
    if (loadMessages) {
      ;[truncated, offset] = messageWindowForDisplay(all, msgLimit, msgBefore)
      // TAL-368: a tail window starts no later than the running turn's prompt, so a turn whose output stays in the
      // transcript (no journal to replay it) keeps its prompt; older pages end before it, so it is never sent twice.
      // ponytail: the window grows with that turn's persisted rows; clip the turn instead if degraded runs get long.
      const prompt = pending && msgBefore === null ? all.findIndex((m) => isDict(m) && m.role === 'user' && m._active_turn_token === pending.activeTurnToken) : -1
      if (prompt >= 0 && prompt < offset) {
        truncated = all.slice(prompt, offset + truncated.length)
        offset = prompt
      }
      // Per-row display fields (TAL-186 media, TAL-456 excerpts cut from that display text) only for the rows sent.
      truncated = withBodyExcerpts(withDisplayMedia(truncated, this.mediaProjector(s)), s.active_stream_id)
      if (msgLimit !== null) truncated = messagesForLimitedPayload(truncated)
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
      ...s.compact({ includeRuntime: true, activeStreamIds, contextLengthFor: this.deps.contextLengthFor, modelOptionFor: this.deps.modelOptionFor }),
      messages: truncated,
      message_count: mergedCount,
      tool_calls: toolCalls,
      pending_user_message: s.pending_user_message,
      pending_attachments: loadMessages ? attachmentObjects(s.pending_attachments) : [],
      pending_started_at: s.pending_started_at,
      pending_user_source: s.pending_user_source,
      context_length: Number(s.context_length ?? 0) || this.deps.contextLengthFor(s.model, s.model_provider) || 0,
      threshold_tokens: Number(s.threshold_tokens ?? 0) || 0,
      last_prompt_tokens: Number(s.last_prompt_tokens ?? 0) || 0,
    }
    if (loadMessages) raw.transcript_seq = journaled ? { stream_id: journaled.turnId, seq: 0 } : null
    if (loadMessages) attachTodoState(raw, all, s.extra[UNSETTLED_TODO_KEY])
    if (loadMessages) raw.compression_reference = compressionReference(s, all)
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
    raw.read_only = this.isReadOnly(s)
    raw.assistant_name = this.assistantName(s)
    raw.workspace_name = this.workspaceNames()(s)
    raw.branched_from = this.branchedFrom(s)
    withSessionWireFlags(raw, activeStreamIds)
    raw.pending_steers = raw.active_stream_id ? (this.deps.runtime.pendingSteers?.(str(raw.active_stream_id)) ?? []) : []
    return redactSessionData(raw, this.deps.redactEnabled())
  }

  /**
   * TAL-454: the chat `/branch` copied, while it still loads (archived included). A compression continuation is also a
   * fork of its parent but not a branch, so it links nowhere.
   */
  private branchedFrom(s: Session): { session_id: string; title: string } | null {
    const parentId = s.parent_session_id
    if (!parentId || str(s.session_source).trim().toLowerCase() !== 'fork' || s.compression_recovery_source_session_id) return null
    let title: unknown
    try {
      const parent = this.store.get(parentId, { metadataOnly: true, promote: false, cacheOnMiss: false })
      if (!this.visibleToActiveProfile(parent.profile)) return null
      title = parent.title
    } catch {
      // A read-only foreign parent (a cron run) has no sidecar and opens from the active profile's state.db while it
      // has transcript rows and is not a deleted chat (`claimOrSynthesizeCliSession`'s `was_webui` and `no_foreign_state`).
      const dbPath = this.stateDbPath(null)
      const row = stateDbSessionRow(dbPath, parentId)
      if (!row || this.store.wasDeleted(parentId) || this.indexMarksWasWebui(parentId)) return null
      if (!stateDbSessionMessages(dbPath, parentId, { stitch: true }).length) return null
      title = row.title
    }
    return { session_id: parentId, title: str(redactText(str(title) || 'Untitled', this.deps.redactEnabled())) }
  }

  /**
   * TAL-316: the active run whose journal can replay its output from the start. The detail then leaves that output to the
   * replay; with no active run, no identifiable prompt, or no complete journal, it returns the persisted transcript unchanged.
   */
  private journaledActiveTurn(s: Session): { turnId: string; startedAt: number; activeTurnToken: string } | null {
    const turnId = str(s.active_stream_id).trim()
    const activeTurnToken = buildActiveTurnToken(turnId, s.pending_started_at)
    if (!turnId || !activeTurnToken || this.deps.runtime.journalDegraded(turnId)) return null
    const summary = this.deps.journal?.findRunSummary(turnId)
    if (summary?.session_id !== s.session_id || summary.journal_pruned) return null
    return { turnId, startedAt: Number(s.pending_started_at), activeTurnToken }
  }

  /** TAL-368: the active run's prompt, which the detail shows until settlement persists it; null when idle or promptless. */
  private pendingTurn(s: Session): Parameters<typeof withPendingUserTurn>[1] | null {
    const turnId = str(s.active_stream_id).trim()
    const activeTurnToken = buildActiveTurnToken(turnId, s.pending_started_at)
    const text = str(s.pending_user_message)
    if (!turnId || !activeTurnToken || (!text && !s.pending_attachments.length)) return null
    const startedAt = Number(s.pending_started_at)
    return { turnId, startedAt, activeTurnToken, localCount: s.messages.length, prompt: pendingUserRow(text, s.pending_attachments, startedAt, s.pending_user_source || 'webui', turnId) }
  }

  /** A session without a sidecar, synthesized from state.db for this profile; 404/409 like the detail. */
  private foreignSession(sid: string): { synth: Session; meta: Row | null } {
    const meta = this.lookupCliMeta(sid)
    const profile = str(meta?.profile) || null
    const profileAgnostic = str(meta?.source_tag || meta?.raw_source).trim().toLowerCase() === 'claude_code'
    if (!profileAgnostic && !this.visibleToActiveProfile(profile)) {
      if (profile) throw new HttpFailure(409, 'Session belongs to a different profile', { code: 'session_profile_mismatch', session_id: sid, profile })
      throw new HttpFailure(404, 'Session not found')
    }
    const { session: synth, reason } = this.claimOrSynthesizeCliSession(sid, meta)
    if (!synth || reason === 'was_webui') throw new HttpFailure(404, 'Session not found')
    return { synth, meta }
  }

  /** Python `_handle_session_get` without a sidecar: the state.db transcript as a (read-only or claimable) foreign stub. */
  private foreignSessionDetail(sid: string): Record<string, unknown> {
    const { synth, meta } = this.foreignSession(sid)
    // The same turn projection as a WebUI session: turn ids, tool outcomes, then each completed turn's scene.
    const msgs = hydrateAnchorActivityScenes(withToolCallOutcomes(withMarkerKinds(withTurnIds(synth.messages)), [], null), {}) as Message[]
    const lastTs = Number(msgs[msgs.length - 1]?.timestamp ?? 0) || 0
    const sess: Record<string, unknown> = {
      session_id: synth.session_id, title: synth.title, workspace: synth.workspace, model: synth.model, message_count: msgs.length,
      created_at: synth.created_at, updated_at: synth.updated_at, last_message_at: meta?.last_message_at || meta?.updated_at || lastTs,
      pinned: synth.pinned, archived: synth.archived, project_id: synth.project_id ?? null, profile: synth.profile,
      is_cli_session: synth.is_cli_session, source_tag: synth.source_tag, raw_source: synth.raw_source, session_source: synth.session_source,
      source_label: synth.source_label, read_only: synth.read_only, can_duplicate: false, messages: msgs, tool_calls: [], transcript_seq: null,
      assistant_name: this.assistantName(synth), workspace_name: this.workspaceNames()(synth),
    }
    attachTodoState(sess, msgs)
    const merged = withSessionWireFlags(meta ? mergeCliSidebarMetadata(sess, meta) : sess, this.deps.runtime.activeStreamIds)
    return redactSessionData(merged, this.deps.redactEnabled())
  }

  /** Clear persisted streaming flags when no live stream backs them (Python `_clear_stale_stream_state`). */
  clearStaleStreamState(session: Session): boolean {
    const streamId = session.active_stream_id
    if (!streamId) return false
    if (this.deps.runtime.activeStreamIds.has(streamId)) return false
    if (this.deps.runtime.activeRunStream(session.session_id)) return false
    const pendingAge = session.pending_started_at ? this.deps.now() - session.pending_started_at : null
    if (session.hasPendingPrompt && pendingAge !== null && pendingAge < 30) return false
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
    // Python `_materialize_pending_user_turn_before_error` (#1361) and `_recover_dead_run_journal`: the prompt that was in
    // flight becomes a durable user turn, the output its journal holds follows it, and an interruption marker closes a
    // run that never finished with an answer, so a dead stream never silently drops what the user sent or what streamed.
    const turnId = str(target.active_stream_id)
    // ponytail: one bounded tail read (Python's recovery window); a journal past it recovers its latest output only.
    const events = this.deps.journal?.readRunEventTail(target.session_id, turnId, RECOVERY_JOURNAL_MAX_BYTES, RECOVERY_JOURNAL_MAX_ROWS).events ?? []
    const { rows: output, answered } = journalOutputRows(events, turnId)
    const pendingText = str(target.pending_user_message)
    const attachments = [...target.pending_attachments]
    // The run's starting read died with its worker: the state.db rows from before it started stand in for it. Its own
    // rows open with its prompt and run to the next prompt; anything else another client wrote meanwhile stays.
    const read = this.stateDbRead(target)
    const runStart = target.pending_started_at || events[0]?.created_at || this.deps.now()
    const before = read.rows.filter((m) => Number(m.timestamp) < runStart)
    const ownRows = target.hasPendingPrompt ? runStateDbRows(read.rows.filter((m) => Number(m.timestamp) >= runStart), pendingText) : null
    // Without this turn's rows: an eager save already put its prompt in the transcript a fresh context falls back to.
    const previousContext = this.modelContext(target, before).filter((m) => m._turn_id !== turnId)
    if (target.hasPendingPrompt) {
      const startedAt = typeof target.pending_started_at === 'number' && target.pending_started_at > 0 ? target.pending_started_at : this.deps.now()
      // An eager save already checkpointed this prompt as the turn's user row.
      if (!target.messages.some((m) => m.role === 'user' && !m._steer && m._turn_id === turnId)) target.messages.push({ role: 'user', content: pendingText, timestamp: Math.trunc(startedAt), ...(attachments.length ? { attachments } : {}), _recovered: true, _source: target.pending_user_source ?? 'webui', _turn_id: turnId })
      // The model context settles as a Stop's does: the Agent's own rows when it committed the prompt, else the prompt it
      // was sent; then the prose that streamed past them.
      const prompt = attachedFilesPrompt((str(target.workspace) ? workspaceContextPrefix(str(target.workspace)) : '') + pendingText, attachments)
      const streamed = output.map((m) => str(m.content)).filter(Boolean).join('\n\n')
      target.context_messages = dedupeContext(stoppedTurnContext(previousContext, ownRows ? [...previousContext, ...ownRows] : null, prompt, pendingText, streamed, previousContext.length) ?? [...structuredClone(previousContext), { role: 'user', content: prompt }])
    }
    if (target.hasPendingPrompt || output.length) {
      target.messages.push(...output)
      if (!answered) target.messages.push({ role: 'assistant', content: '**Interrupted:** The reply was interrupted before it could be saved.', timestamp: Math.trunc(this.deps.now()), _error: true, _turn_id: turnId })
      // Settled like a turn: the Agent's own rows are covered by the recovered turn; without them, every row past the run's start is.
      this.settleStateDb(target, { turnId, previousContext, agentRows: ownRows, startId: stateDbSeenId(before) ?? (read.idCapable ? 0 : null) })
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

  list(params: Omit<ListParams, 'activeProfile' | 'isolatedProfileMode' | 'profilesMatch' | 'cliRows' | 'gatewayIdentity' | 'stateDbSources' | 'truncatedSources'>): { body: ListResponse; etag: string } {
    const activeProfile = this.deps.activeProfile()
    const wantState = params.showCliSessions || params.showCronSessions || params.showWebhookSessions || params.showKanbanSessions
    // Python reads every profile's state.db under all_profiles; this port projects the active profile only.
    const cliRead = wantState ? this.deps.cliSessions(activeProfile, { sourceFilter: params.sourceFilter ?? null }) : undefined
    const claudeCodeRows = params.showCliSessions && params.showClaudeCodeSessions ? this.claudeCodeRows() : []
    const cliRows = cliRead ? [...cliRead.rows, ...claudeCodeRows] : undefined
    const gatewayIdentity = loadGatewaySessionIdentityMap(join(this.deps.profileHome(activeProfile), 'sessions', 'sessions.json'))
    const truncatedSources = cliRead?.truncated
    const payload = buildSessionListPayload(this.store, { ...params, ...(cliRows ? { cliRows } : {}), ...(truncatedSources ? { truncatedSources } : {}), gatewayIdentity, stateDbSources: this.stateDbSources, activeProfile, isolatedProfileMode: this.deps.isolatedProfileMode(), profilesMatch: this.deps.profilesMatch })
    return sessionListResponse(payload, this.deps.runtime, this.deps.redactEnabled(), this.deps.now(), this.workspaceNames())
  }

  search(q: string, opts: { content: boolean; depth: number; allProfiles: boolean }): Record<string, unknown> {
    const activeProfile = this.deps.activeProfile()
    let sessions = allSessions(this.store)
    if (!opts.allProfiles) sessions = sessions.filter((r) => this.deps.profilesMatch(str(r.profile) || null, activeProfile))
    sessions = withOwnerLocks(sessions, this.stateDbSources)
    const redact = this.deps.redactEnabled()
    const workspaceName = this.workspaceNames()
    const redactRow = (item: Row) => {
      withSessionWireFlags(item, this.deps.runtime.activeStreamIds)
      item.workspace_name = workspaceName(item)
      if (typeof item.title === 'string') item.title = redactText(item.title, redact)
      for (const f of ['display_title', '_state_db_title', 'parent_title']) if (typeof item[f] === 'string') item[f] = redactText(item[f], redact)
      return item
    }
    const query = q.toLowerCase().trim()
    if (!query) return { sessions: sessions.map((s) => redactRow({ ...s })), all_profiles: opts.allProfiles, active_profile: activeProfile }
    const terms = sessionSearchTerms(query)
    const results: Row[] = []
    for (const s of sessions) {
      if (sessionSearchMatches(str(s.title), terms)) { results.push(redactRow({ ...s, match_type: 'title' })); continue }
      if (!opts.content) continue
      const hit = this.contentMatch(str(s.session_id), terms, opts.depth)
      if (hit) results.push(redactRow({ ...s, ...hit }))
    }
    return { sessions: results, query, count: results.length, all_profiles: opts.allProfiles, active_profile: activeProfile }
  }

  /**
   * TAL-308: the sidebar search. The candidates are exactly the `/api/sessions` rows for `params` (visibility, source,
   * archived, projection and order), narrowed to `projectId` (`none`: rows without a project), then matched on the
   * title, then the metadata the row shows (workspace path and name, model, provider, profile, source label), then message content.
   */
  sidebarSearch(q: string, params: Parameters<SessionService['list']>[0], opts: { content: boolean; depth: number; projectId: string | null }): Record<string, unknown> {
    let rows = this.list(params).body.sessions
    if (opts.projectId === 'none') rows = rows.filter((r) => !r.project_id)
    else if (opts.projectId) rows = rows.filter((r) => str(r.project_id) === opts.projectId)
    const query = q.toLowerCase().trim()
    const base = { all_profiles: params.allProfiles, active_profile: this.deps.activeProfile(), include_archived: params.includeArchived, sidebar_filtered: true }
    if (!query) return { ...base, sessions: rows }
    const terms = sessionSearchTerms(query)
    const results: Row[] = []
    for (const row of rows) {
      if (sessionSearchMatches(str(row.title), terms)) results.push({ ...row, match_type: 'title' })
      else if (['workspace', 'workspace_name', 'model', 'model_provider', 'profile', 'source_label'].some((k) => sessionSearchMatches(str(row[k]), terms))) results.push({ ...row, match_type: 'metadata' })
      else if (opts.content) {
        const hit = this.contentMatch(str(row.session_id), terms, opts.depth)
        if (hit) results.push({ ...row, ...hit })
      }
    }
    return { ...base, sessions: results, query, count: results.length }
  }

  /** The first of a stored session's first `depth` messages (0: all) containing every term, with its redacted excerpt. */
  private contentMatch(sid: string, terms: readonly string[], depth: number): Row | null {
    let sess: Session
    try { sess = this.store.get(sid, { promote: false, cacheOnMiss: false }) } catch { return null }
    for (const m of depth ? sess.messages.slice(0, depth) : sess.messages) {
      const c = sessionSearchMessageText(m)
      if (!sessionSearchMatches(c, terms)) continue
      const item: Row = { match_type: 'content' }
      const preview = sessionSearchPreview(c, terms)
      if (preview) item.match_preview = redactText(preview, this.deps.redactEnabled())
      return item
    }
    return null
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
    const { is_streaming: streaming, active_stream_id: live, read_only: readOnly, active_turn_origin: origin } = this.wireRow(full)
    return {
      session_id: full.session_id, title: full.title, model: full.model, profile, hermes_home: hermesHome, workspace: full.workspace, personality: full.personality,
      message_count: full.messages.length, created_at: full.created_at, updated_at: full.updated_at, agent_running: streaming, is_streaming: streaming, active_stream_id: live, active_turn_origin: origin, read_only: readOnly,
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

  /** The server owns the names' normalization (TAL-631): trimmed, blanks dropped, and nothing left is the profile's defaults. */
  validateToolsetsShape(toolsets: unknown): string[] | null {
    if (toolsets === null || toolsets === undefined) return null
    if (!Array.isArray(toolsets)) throw new HttpFailure(400, 'toolsets must be a list or null')
    if (!toolsets.every((t) => typeof t === 'string')) throw new HttpFailure(400, 'each toolset must be a string')
    const names = toolsets.map((t) => t.trim()).filter(Boolean)
    return names.length ? names : null
  }

  create(body: Record<string, unknown>, opts: { worktree?: { path: string; branch: string; repo_root: string; created_at: number } | null } = {}): Session {
    // Python `new_session`: a body without a profile takes the request's active profile (cookie first).
    const profile = (typeof body.profile === 'string' && body.profile) || this.deps.activeProfile()
    let prevSessionId = typeof body.prev_session_id === 'string' && body.prev_session_id ? body.prev_session_id : null
    if (prevSessionId && !this.sessionIdVisible(prevSessionId)) prevSessionId = null
    // Python: leaving a session for a new one flushes the previous session's memory in the background (W6).
    if (prevSessionId) this.deps.commitSessionMemory?.(prevSessionId)
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

  /** Python `_persist_generated_session_title`: title + generated/manual flags under the session lock, then insights sync. */
  async persistGeneratedTitle(sid: string, nextTitle: string, eventReason: string): Promise<Session> {
    const title = nextTitle.trim().slice(0, 80) || 'Untitled'
    let current: Session
    try { current = this.store.get(sid) } catch { throw new HttpFailure(404, 'Session not found') }
    if (this.isReadOnly(current)) throw new HttpFailure(403, `Session ${sid} is read-only`)
    await this.store.withLock(sid, () => {
      current.title = title
      markSessionTitleGenerated(current)
      this.store.save(current, { touchUpdatedAt: false })
    })
    await this.deps.syncTitle(current)
    this.publish(eventReason, current.profile, current.session_id)
    return current
  }

  async rename(sid: string, rawTitle: unknown): Promise<Record<string, unknown>> {
    const s = this.mutationTarget(sid, 'renamed')
    await this.store.withLock(sid, () => {
      applySessionTitleRename(s, rawTitle)
      this.store.save(s)
    })
    await this.deps.syncTitle(s)
    this.publish('session_rename', s.profile, s.session_id)
    return { session: this.wireRow(s) }
  }

  // The pin quota is counted across sessions, so the count-and-save transaction runs on one process-wide chain;
  // per-session locks alone would let two pins of different sessions both see the last free slot.
  private pinChain: Promise<unknown> = Promise.resolve()

  pin(sid: string, pinRequested: boolean): Promise<Record<string, unknown>> {
    const run = this.pinChain.then(() => this.pinUnserialized(sid, pinRequested))
    this.pinChain = run.catch(() => undefined)
    return run
  }

  private async pinUnserialized(sid: string, pinRequested: boolean): Promise<Record<string, unknown>> {
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
    return { ok: true, session: this.wireRow(s) }
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
    return { ok: true, session: this.wireRow(s), ...worktreeRetainedPayload(s) }
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
    return { ok: true, session: this.wireRow(s) }
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
    await this.store.withLock(sid, async () => {
      s.workspace = newWs
      if ('model' in body || 'model_provider' in body) {
        const [model, provider] = this.deps.modelStateFromRequest('model' in body ? body.model : s.model, 'model_provider' in body ? body.model_provider : undefined, s.model_provider)
        if (model !== null) s.model = model
        s.model_provider = provider
        if (str(oldModel) !== str(s.model) || str(oldProvider) !== str(s.model_provider)) {
          s.context_length = this.deps.resolveContextLength ? await this.deps.resolveContextLength(s.model, s.model_provider, s.profile) : this.deps.contextLengthFor(s.model, s.model_provider)
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
    const s = this.mutationTarget(sid, 'modified')
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
    const s = this.mutationTarget(sid, 'modified')
    // Python `int(body["keep_count"])`: a float truncates, a non-integer string is rejected.
    let keep: number
    if (typeof keepRaw === 'number') keep = Number.isFinite(keepRaw) ? Math.trunc(keepRaw) : Number.NaN
    else if (typeof keepRaw === 'boolean') keep = keepRaw ? 1 : 0
    else keep = /^[+-]?\d+$/.test(str(keepRaw).trim()) ? Number.parseInt(str(keepRaw).trim(), 10) : Number.NaN
    if (!Number.isInteger(keep)) throw new HttpFailure(400, 'keep_count must be an integer')
    if (keep < 0) throw new HttpFailure(400, 'keep_count must be non-negative')
    await this.store.withLock(sid, () => {
      truncateSessionAtKeep(s, keep)
      this.markStateDbSeen(s, undefined, { boundary: true })
      this.store.save(s)
    })
    this.deps.runtime.evictAgent(sid)
    return { ok: true, session: this.publicSession(s) }
  }

  // ── manual compression (TAL-255) ────────────────────────────────────────

  /**
   * Python `_handle_session_compress_start`: validate, then join the session's running job or start a fresh one (a
   * finished job is replaced). The stale-runtime refusal comes before a job exists; a running job is joined without it.
   */
  async startCompression(sid: string, focusRaw: unknown): Promise<CompressionJob> {
    const running = (): CompressionJob | undefined => { const job = this.compressionJobs.get(sid); return job?.status === 'running' ? job : undefined }
    // A running job is joined first: once it has installed its short context, the guards below would refuse a new one.
    const existing = running()
    if (existing) return existing
    const { s } = this.compressionTarget(sid)
    const focusTopic = str(focusRaw).trim().slice(0, 500) || null
    await ensureAgentRuntimeCurrent(this.deps.sidecar?.() ?? null)
    // Another start may have admitted a job while the runtime check awaited.
    const admitted = running()
    if (admitted) return admitted
    // The detached job (and its finalize) is the profile's activity until it settles; checked and taken in one step.
    const profile = s.profile ?? null
    if (this.deps.profileDeleting?.(profile)) throw new HttpFailure(409, `Profile '${str(profile)}' is being deleted.`)
    const release = this.deps.profileActivity?.(profile)
    const now = this.deps.now()
    const job: CompressionJob = { session_id: sid, focus_topic: focusTopic, status: 'running', started_at: now, updated_at: now, done: Promise.resolve() }
    job.done = this.compressSession(sid, focusTopic).finally(() => { release?.(); this.compressionJobs.expireLater(job) }).then(
      (result) => { Object.assign(job, { status: 'done', result, updated_at: this.deps.now() }) },
      (error: unknown) => {
        const known = error instanceof HttpFailure
        if (!known) this.deps.log(`[webui] Manual compression worker failed for session ${sid}: ${(error as Error).message}`)
        Object.assign(job, { status: 'error', error: known ? error.message : `Compression failed: ${sanitizePaths(error)}`, error_status: known ? error.status : 500, error_extra: known ? error.extra : {}, updated_at: this.deps.now() })
      },
    )
    this.compressionJobs.set(job)
    return job
  }

  /** The session a compression may run on now, and the model history it compresses: the context a turn would send, so a
   * repeat compression builds on the previous summary instead of re-reading the whole display transcript. */
  private compressionTarget(sid: string): { s: Session; history: Message[] } {
    this.rejectSubagent(sid, 'compressed')
    const s = this.mutationTarget(sid, 'compressed')
    if (s.active_stream_id) throw new HttpFailure(409, 'Session is still streaming; wait for the current turn to finish.')
    const history = sanitizeMessagesForApi(this.modelContext(s))
    if (history.length < 4) throw new HttpFailure(400, 'Not enough conversation to compress (need at least 4 messages).')
    return { s, history }
  }

  /** TAL-258: the session's WebUI record (absent for a CLI or gateway session) and the profile whose state.db holds its rows. */
  private handoffTarget(sid: string): { local: Session | null; profile: string; dbPath: string } {
    let local: Session | null = null
    try { local = this.store.get(sid) } catch { /* a foreign session without a WebUI record */ }
    const profile = local?.profile ?? this.deps.activeProfile()
    return { local, profile, dbPath: this.stateDbPath(profile) }
  }

  /** Python `_handle_conversation_rounds` (TAL-258): the session's rounds and whether the handoff dock is due. */
  conversationRounds(sid: string, since: number | null): { ok: true; rounds: number; threshold: number; should_show: boolean } {
    const rounds = countConversationRounds(this.handoffTarget(sid).dbPath, sid, since)
    return { ok: true, rounds, threshold: CONVERSATION_ROUND_THRESHOLD, should_show: rounds >= CONVERSATION_ROUND_THRESHOLD }
  }

  /**
   * Python `_handle_handoff_summary` (TAL-258): the session's main model summarizes its last 50 state.db messages after
   * `since`, and the summary is appended as a display-only `handoff_summary` tool row. A failed or cut-off answer falls
   * back to a deterministic local summary rather than an error.
   */
  async handoffSummary(sid: string, since: number | null): Promise<{ ok: true; summary: string; message_count: number; rounds: number; fallback: boolean; warning?: string }> {
    this.rejectSubagent(sid, 'summarized')
    const { local, profile, dbPath } = this.handoffTarget(sid)
    const rounds = countConversationRounds(dbPath, sid, since)
    if (rounds < CONVERSATION_ROUND_THRESHOLD) throw new HttpFailure(400, 'Not enough conversation rounds to generate a summary.')
    // A running turn settles the transcript it started from, which would drop a card appended meanwhile.
    if (local?.active_stream_id) throw new HttpFailure(409, 'Session is still streaming; wait for the current turn to finish.')
    const all = stateDbSessionMessages(dbPath, sid, { stitch: true })
    const messages = (since === null ? all : all.filter((m) => { const ts = stateDbTimestampSeconds(m.timestamp); return ts !== null && ts > since })).slice(-50)
    if (messages.length < 2) throw new HttpFailure(400, 'Not enough messages to summarize.')
    const sidecar = this.deps.sidecar?.() ?? null
    await ensureAgentRuntimeCurrent(sidecar)
    const meta = local ? null : this.lookupCliMeta(sid)
    const generated = await this.generateHandoffSummary(sidecar, profile, local, meta, messages)
    const pick = (row: Record<string, unknown> | null, ...keys: string[]): string => { for (const key of keys) { const v = str(row?.[key]).trim(); if (v) return v } return '' }
    // Python `get_cli_sessions` never listed WebUI's own state.db rows, so they name no channel.
    const cliRow = meta ?? this.lookupCliMeta(sid)
    const channel = pick(local as unknown as Record<string, unknown> | null, 'source_label', 'raw_source', 'source_tag', 'session_source') || (str(cliRow?.raw_source || cliRow?.source).trim().toLowerCase() === 'webui' ? '' : pick(cliRow, 'source_label', 'raw_source', 'source_tag', 'source')) || null
    await this.persistHandoffMarker(sid, profile, handoffMarker(sid, generated.summary, channel, rounds, generated.fallback, this.deps.now()))
    return { ok: true, summary: generated.summary, message_count: messages.length, rounds, fallback: generated.fallback, ...(generated.warning ? { warning: generated.warning } : {}) }
  }

  /** The main model's summary at 700 tokens, once more at 1400 when it was cut off, else the local fallback. */
  private async generateHandoffSummary(sidecar: SidecarLike | null, profile: string, local: Session | null, meta: Row | null, messages: Message[]): Promise<{ summary: string; fallback: boolean; warning?: string }> {
    const fallback = (warning?: string) => ({ summary: fallbackHandoffSummary(messages), fallback: true, ...(warning ? { warning: `Summary generation used local fallback: ${warning}` } : {}) })
    if (!sidecar) return fallback('the Agent sidecar is not running')
    const [model, provider] = local ? this.deps.modelStateFromRequest(local.model, local.model_provider, local.model_provider) : [str(meta?.model).trim() || null, null]
    const prompt = [{ role: 'system', content: HANDOFF_SYSTEM_PROMPT }, { role: 'user', content: `Conversation transcript:\n${handoffTranscript(messages)}` }]
    const ask = (maxTokens: number) => sidecar.call('aux.complete', { profile_home: this.deps.profileHome(profile), task: 'handoff_summary', messages: prompt, model: model ?? '', provider, max_tokens: maxTokens, temperature: 0.2 }, { timeoutMs: 60_000 })
    try {
      let result = await ask(700)
      if (completionIncomplete(result)) result = await ask(1400)
      return completionIncomplete(result) ? fallback() : { summary: result.text, fallback: false }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'agent_runtime_stale') throw staleRuntimeFailure(error)
      // No credential is not a failure: the predecessor answered with the local summary and no warning.
      if (error instanceof SidecarError && error.condition === 'credential_missing') return fallback()
      return fallback(sanitizePaths(error))
    }
  }

  /**
   * Python `_persist_handoff_summary`: a messaging session gets the marker in state.db and its WebUI record; any other
   * session in its WebUI record, or in state.db when it has none. Each store skips a marker its tail already holds, and
   * the session lock keeps two summaries from both passing that check. A card neither store saved answers 503.
   */
  private async persistHandoffMarker(sid: string, profile: string, marker: Message): Promise<void> {
    const card = messageHandoffPayload(marker)
    const toStateDb = async (): Promise<boolean> => {
      if (sameHandoff(handoffPayload(stateDbTailToolContent(this.stateDbPath(profile), sid)), card)) return true
      const sidecar = this.deps.sidecar?.()
      if (!sidecar) return false
      try {
        return (await sidecar.call('state_db.append_message', { profile_home: this.deps.profileHome(profile), session_id: sid, role: 'tool', content: str(marker.content), tool_name: 'handoff_summary', timestamp: Number(marker.timestamp) })).ok
      } catch {
        return false
      }
    }
    await this.store.withLock(sid, async () => {
      let live: Session | null = null
      try { live = this.store.get(sid) } catch { /* no WebUI record */ }
      // A turn that started while the summary was generated would drop the card when it settles.
      if (live?.active_stream_id) throw new HttpFailure(409, 'Session is still streaming; wait for the current turn to finish.')
      const toLocal = (): boolean => {
        if (!live) return false
        if (sameHandoff(messageHandoffPayload(live.messages.at(-1)), card)) return true
        live.messages.push(marker)
        this.store.save(live)
        return true
      }
      const messaging = this.isMessagingSession(sid)
      const saved = messaging ? [await toStateDb(), toLocal()].some(Boolean) : toLocal() || await toStateDb()
      // The caller may switch away on success, so a card saved nowhere is an error, not a summary.
      if (!saved) throw new HttpFailure(503, 'The handoff summary could not be saved; please retry.')
    })
  }

  /** The session's compression job; a deleted session's finished result is dropped rather than served. */
  compressionJob(sid: string): CompressionJob | undefined {
    try { this.store.get(sid, { metadataOnly: true }) } catch { this.compressionJobs.delete(sid); throw new HttpFailure(404, 'Session not found') }
    return this.compressionJobs.get(sid)
  }

  /**
   * Python `_handle_session_compress`: compress the sanitized transcript in the sidecar outside the lock, then under the
   * session lock refuse a result the session moved past (stream state or transcript changed) and install it as the
   * model context with the manual anchor and the #4836 boundary that keeps state.db from replaying compressed rows.
   * The guards run again first: a stream may have started while the caller awaited the runtime check.
   */
  private async compressSession(sid: string, focusTopic: string | null): Promise<Record<string, unknown>> {
    const { s, history } = this.compressionTarget(sid)
    // The display transcript and the model context must both be where the compression found them; the key starts from
    // the exact history sent, so a state.db row that lands after this read fails the commit instead of being dropped.
    const transcriptKey = (x: Session, context: Message[]): string => JSON.stringify([sanitizeMessagesForApi(x.messages), context])
    const historyKey = transcriptKey(s, history)
    const streamState = (x: Session): string => JSON.stringify([x.active_stream_id ?? null, x.pending_user_message ?? null, x.pending_attachments ?? null, x.pending_started_at ?? null])
    const streamBefore = streamState(s)
    const sidecar = this.deps.sidecar?.()
    if (!sidecar) throw new HttpFailure(400, 'Compression failed: the Agent sidecar is not running')
    const [model, provider] = this.deps.modelStateFromRequest(s.model, s.model_provider, s.model_provider)
    let result
    try {
      result = await sidecar.call('chat.compress', {
        profile_home: this.deps.profileHome(s.profile ?? this.deps.activeProfile()), session_id: sid, model: model ?? '', model_provider: provider,
        conversation_history: history, focus_topic: focusTopic, enabled_toolsets: s.enabled_toolsets,
      }, { timeoutMs: 0 })
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'agent_runtime_stale') throw staleRuntimeFailure(error)
      if (error instanceof SidecarError && error.condition === 'credential_missing') throw new HttpFailure(400, 'No provider configured -- cannot compress.')
      throw new HttpFailure(400, `Compression failed: ${sanitizePaths(error)}`)
    }
    // A held compression lock is a conflict to retry; `nothing_to_do` is the Agent's verdict on this transcript.
    if (result.status !== 'compressed') throw new HttpFailure(result.status === 'lock_skipped' ? 409 : 400, result.message ?? 'Nothing to compress yet.')
    const summary = result.summary ?? {}
    let committed = false
    try {
      const current = await this.store.withLock(sid, () => {
        let live: Session
        try { live = this.store.get(sid) } catch { throw new HttpFailure(404, 'Session not found') }
        if (streamState(live) !== streamBefore) throw new HttpFailure(409, 'Session stream state changed during compression; please retry.')
        // One state.db read serves the check, the kept display rows, and the boundary.
        const read = this.stateDbRead(live)
        const stateRows = read.rows
        if (transcriptKey(live, sanitizeMessagesForApi(this.modelContext(live, stateRows))) !== historyKey) throw new HttpFailure(409, 'Session was modified during compression; please retry.')
        // Rows the sidecar returns without a timestamp take the newest one this compression saw, never the clock: the
        // boundary then hides no state.db row the append-only merge would still show (it already drops rows at or
        // before the newest local row), so a CLI row committed after the read follows the compressed context.
        const seen = [...live.messages, ...live.context_messages, ...stateRows].map((m) => Number(m.timestamp)).filter(Number.isFinite)
        const stamp = seen.length ? Math.max(...seen) : this.deps.now()
        const compressed = copyJson(result.messages) as Message[]
        for (const m of compressed) m.timestamp ??= stamp
        live.context_messages = compressed
        live.active_stream_id = null
        live.pending_user_message = null
        live.pending_attachments = []
        live.pending_started_at = null
        live.pending_user_source = null
        // The compressed history included any state.db-only continuation; the new boundary would hide those rows from
        // the display, so the transcript keeps them before it is applied (and the anchor counts them).
        const display = this.mergedTranscript(live, live.messages, stateRows)
        if (display.length > live.messages.length) live.messages = copyJson(display)
        const visible = visibleMessagesForAnchor(live.messages)
        live.compression_anchor_visible_idx = visible.length ? visible.length - 1 : null
        live.compression_anchor_message_key = anchorMessageKey(visible.at(-1))
        live.compression_anchor_summary = anchorSummary(summary, compressed)
        live.compression_anchor_mode = 'manual'
        // #4836: an intentional-shrink boundary, so append-only state.db reconciliation does not replay compressed rows.
        live.truncation_watermark = truncationWatermarkFor(compressed)
        live.truncation_boundary = live.truncation_watermark
        live.truncation_watermark_compressed = true
        this.markStateDbSeen(live, read, { boundary: true })
        live.last_prompt_tokens = result.after_tokens
        live.post_compression_context_tokens_estimate = result.after_tokens
        this.store.save(live)
        // A backup from before the compression would restore the uncompressed context.
        try { rmSync(`${this.store.pathFor(sid)}.bak`, { force: true }) } catch { /* ignore */ }
        return live
      })
      committed = true
      // The cached turn agent still carries the uncompressed state; the next turn builds a fresh one (gateway parity).
      // Awaited, so a turn sent right after the reply cannot reuse the old agent.
      try { await sidecar.call('chat.evict_agent', { session_id: sid }) } catch (error) { this.deps.log(`[webui] agent eviction after compression of ${sid} failed: ${(error as Error).message}`) }
      return { ok: true, session: this.publicSession(current), summary, focus_topic: focusTopic }
    } finally {
      // Second phase: the Agent's context-engine notification fires only for a result the session now holds.
      if (result.commit_token) {
        try { await sidecar.call('chat.compress_finalize', { commit_token: result.commit_token, committed }) } catch (error) { this.deps.log(`[webui] compression finalize for ${sid} failed: ${(error as Error).message}`) }
      }
    }
  }

  async clear(sid: string): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    const s = this.mutationTarget(sid, 'modified')
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
      this.markStateDbSeen(s, undefined, { boundary: true })
      this.store.save(s)
      if (hadMessages) { try { rmSync(`${this.store.pathFor(sid)}.bak`, { force: true }) } catch { /* ignore */ } }
    })
    this.deps.runtime.evictAgent(sid, true)
    return { ok: true, session: this.wireRow(s) }
  }

  async retry(sid: string): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    return this.store.withLock(sid, () => {
      const s = this.mutationTarget(sid, 'modified')
      const history = s.messages
      const lastUser = findLastUserIndex(history)
      if (lastUser === null) return { error: 'No previous message to retry.' }
      // What a client resends (TAL-515): the files that reached the model, which only ever got attachments with a path,
      // and the prompt as typed. The attached-files line is the server's only when such files exist; otherwise the user
      // typed it. Nothing to resend fails before the exchange is removed.
      const prompt = history[lastUser]!
      const lastUserText = extractText(prompt.content)
      const lastUserAttachments = attachmentObjects(Array.isArray(prompt.attachments) ? prompt.attachments : []).filter((a): a is Record<string, unknown> => isDict(a) && Boolean(str(a.path).trim()))
      const lastUserPrompt = stripWorkspacePrefix(lastUserAttachments.length ? stripAttachedFilesMarker(lastUserText) : lastUserText, true)
      if (!lastUserPrompt && !lastUserAttachments.length) return { error: 'The last message has nothing to resend.' }
      const removed = history.length - lastUser
      shrinkTo(s, lastUser)
      this.markStateDbSeen(s, undefined, { boundary: true })
      this.store.save(s)
      return { ok: true, last_user_text: lastUserText, last_user_prompt: lastUserPrompt, last_user_attachments: lastUserAttachments, removed_count: removed }
    })
  }

  async undo(sid: string): Promise<Record<string, unknown>> {
    this.rejectSubagent(sid, 'modified')
    return this.store.withLock(sid, () => {
      const s = this.mutationTarget(sid, 'modified')
      const history = s.messages
      const lastUser = findLastUserIndex(history)
      if (lastUser === null) return { error: 'Nothing to undo.' }
      const removedText = extractText(history[lastUser]?.content)
      const removed = history.length - lastUser
      shrinkTo(s, lastUser)
      this.markStateDbSeen(s, undefined, { boundary: true })
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
    // A truncation cut names deleted state.db rows of the source; the copy's own state.db rows are all genuine (TAL-504).
    const watermark = session.truncation_watermark_compressed ? { truncation_watermark: session.truncation_watermark, truncation_boundary: session.truncation_boundary, truncation_watermark_compressed: true } : {}
    const copied = new Session(
      {
        title: `${session.title || 'Untitled'} (copy)`, workspace: session.workspace, model: session.model, model_provider: session.model_provider,
        messages: copyJson(session.messages), tool_calls: copyJson(session.tool_calls), pinned: false, archived: false, project_id: session.project_id, profile: session.profile,
        input_tokens: session.input_tokens, output_tokens: session.output_tokens, estimated_cost: session.estimated_cost, cache_read_tokens: session.cache_read_tokens, cache_write_tokens: session.cache_write_tokens,
        personality: session.personality, enabled_toolsets: session.enabled_toolsets, context_length: session.context_length, threshold_tokens: session.threshold_tokens,
        ...watermark, context_messages: copyJson(session.context_messages),
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
    const source = this.get404(sid)
    if (this.isReadOnly(source)) {
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
    // Python: `keep_count` indexes the merged display transcript, never the raw sidecar array.
    const sourceMessages = this.mergedTranscript(source)
    const forked = keepCount !== null ? sourceMessages.slice(0, keepCount) : [...sourceMessages]
    const title = customTitle ?? `${source.title || 'Untitled'} (fork)`
    const forkKeep = keepCount ?? sourceMessages.length
    // The branch's model context must carry the retained state.db rows too: the new id has no state.db rows of its
    // own, and the runner prefers a non-empty context over the displayed messages.
    const stateRows = this.stateDbRows(source)
    const sourceContext = stateRows.length ? this.mergedTranscript(source, source.context_messages.length ? source.context_messages : source.messages) : source.context_messages
    const forkedContext = copyJson(truncateContextForDisplayKeep(sourceContext, sourceMessages, forkKeep))
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

  /** Python `read_session_lineage_report` on the active profile's state.db. */
  lineageReport(sid: string): Record<string, unknown> {
    return stateDbLineageReport(this.stateDbPath(null), sid)
  }

  /** TAL-259: recovery reads the active profile's state.db, and a recovered sidecar joins that profile. */
  private recoveryDeps(): RecoveryDeps {
    return { store: this.store, stateDbPath: this.stateDbPath(null), profile: this.deps.activeProfile(), stampingSince: this.deps.recoveryStampingSince(), log: this.deps.log }
  }

  recoveryAudit(): RecoveryAudit {
    return auditSessionRecovery(this.recoveryDeps())
  }

  recoveryRepairSafe(): Promise<RecoveryRepair> {
    return repairSafeSessionRecovery(this.recoveryDeps())
  }

  /**
   * Python `_handle_session_compression_recovery_start`: open a compression-exhausted session's focused continuation, an
   * empty fork keeping its workspace, model, profile, toolsets and worktree. A retry opens the oldest continuation
   * already started from it in the same profile; the source's lock makes concurrent starts converge on one child.
   */
  async compressionRecoveryStart(sid: string): Promise<Record<string, unknown>> {
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot start compression recovery from WebUI')
    const action = COMPRESSION_RECOVERY_ACTION_START_FOCUSED
    let created = false
    const child = await this.store.withLock(sid, () => {
      // Validated under the lock: a delete that won it leaves no source to fork.
      const source = this.store.get(sid)
      if (!this.visibleToActiveProfile(source.profile)) throw new HttpFailure(404, 'Session not found')
      if (!compressionRecoveryPayload(source)) throw new HttpFailure(409, 'Session does not have a compression recovery action.')
      const existing = this.compressionRecoveryChild(sid, action, source.profile)
      if (existing) return existing
      const base = (source.title || 'Untitled').trim() || 'Untitled'
      const fresh = new Session(
        {
          title: base.endsWith(' (focused continuation)') ? base : `${base} (focused continuation)`, workspace: source.workspace, model: source.model, model_provider: source.model_provider,
          project_id: source.project_id, profile: source.profile, session_source: 'fork', personality: source.personality, enabled_toolsets: copyJson(source.enabled_toolsets),
          context_length: source.context_length, threshold_tokens: source.threshold_tokens, gateway_routing: copyJson(source.gateway_routing), gateway_routing_history: copyJson(source.gateway_routing_history),
          parent_session_id: source.session_id, worktree_path: source.worktree_path, worktree_branch: source.worktree_branch, worktree_repo_root: source.worktree_repo_root, worktree_created_at: source.worktree_created_at,
          compression_recovery_source_session_id: sid, compression_recovery_action: action,
          // An empty model-facing transcript: the focused follow-up must not replay the exhausted context.
          messages: [], context_messages: [], composer_draft: { text: '', files: [] },
        },
        { workspace: source.workspace, model: source.model },
      )
      try {
        this.store.save(fresh)
      } catch (error) {
        throw new HttpFailure(500, `Failed to start compression recovery: ${sanitizePaths(error)}`)
      }
      this.store.touch(fresh)
      created = true
      return fresh
    })
    if (created) this.publish('session_compression_recovery', child.profile, child.session_id)
    return {
      ok: true, session: this.publicSession(child), source_session_id: sid, recommended_recovery_action: action,
      message: created ? 'Started a focused continuation. Describe the next narrow task to continue.' : 'Opened the existing focused continuation for this exhausted session.',
    }
  }

  /** Python `find_compression_recovery_session`: the oldest same-profile continuation started from `sid`, cached or persisted. */
  private compressionRecoveryChild(sid: string, action: string, profile: string | null): Session | null {
    const matches = (s: Session): boolean => s.compression_recovery_source_session_id === sid && s.compression_recovery_action === action && this.deps.profilesMatch(s.profile, profile)
    const found = new Map<string, Session>()
    for (const s of this.store.sessions.values()) if (matches(s)) found.set(s.session_id, s)
    for (const id of this.store.persistedIds()) {
      if (found.has(id) || this.store.sessions.has(id)) continue
      try {
        const meta = this.store.get(id, { metadataOnly: true, promote: false, cacheOnMiss: false })
        if (matches(meta)) found.set(id, meta)
      } catch { /* unreadable: not a match */ }
    }
    const [oldest] = [...found.values()].sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || (a.updated_at || 0) - (b.updated_at || 0) || (a.session_id < b.session_id ? -1 : 1))
    return oldest ? this.store.get(oldest.session_id) : null
  }

  /** The run that keeps `delete` answering 409, if any; stream status reports it so a draining client can wait on it (TAL-622). */
  activeRunBlocking(sid: string): string | null {
    const live = this.deps.runtime.activeRunStream(sid)
    if (live) return live
    try {
      const candidate = str(this.store.get(sid, { metadataOnly: true, promote: false, cacheOnMiss: false }).active_stream_id).trim()
      if (candidate && this.deps.runtime.activeStreamIds.has(candidate)) return candidate
    } catch { /* absent */ }
    return null
  }

  async delete(sid: string): Promise<Record<string, unknown>> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    if (!isSafeSessionId(sid)) throw new HttpFailure(400, 'Invalid session_id')
    // Python: a read-only import (persisted sidecar flag, sidebar metadata, or a foreign state.db owner such as a
    // Claude Code session) is never deleted — that would erase the owner's authoritative transcript.
    if (this.isReadOnlyImport(sid)) throw new HttpFailure(400, 'Read-only imported sessions cannot be deleted from WebUI')
    if (this.isSubagentViewOnly(sid)) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot be deleted from WebUI')
    const retained = (() => { try { return worktreeRetainedPayload(this.store.get(sid, { metadataOnly: true })) } catch { return {} } })()
    let eventProfile: string | null = null
    let hadSidecar = true
    try { eventProfile = this.store.get(sid, { metadataOnly: true }).profile } catch { eventProfile = null; hadSidecar = false }
    // Python `_is_messaging_session_id`: decided before the JSON is gone, from WebUI metadata or the Agent's row.
    const isMessaging = this.isMessagingSession(sid)
    if (this.activeRunBlocking(sid)) throw new HttpFailure(409, 'Session has an active run; stop it before deleting')
    try {
      await this.store.withLock(sid, () => {
        if (this.activeRunBlocking(sid)) throw new HttpFailure(409, 'Session has an active run; stop it before deleting')
        // A public share outlives its session file, and revokeShare needs the session, so revoke it first.
        try { this.deps.shares.revoke(this.store.get(sid, { metadataOnly: true })) } catch (error) { if (!(error instanceof SessionNotFound)) throw error }
        if (!this.store.deleteFiles(sid)) throw new HttpFailure(500, 'Failed to delete session data')
      }, { timeoutMs: 5000 })
    } catch (error) {
      if (error instanceof SessionBusy) throw new HttpFailure(503, 'Session busy, try again')
      throw error
    }
    this.deps.runtime.evictAgent(sid, true)
    try { rmSync(this.deps.attachmentDir(sid), { recursive: true, force: true }) } catch { /* ignore */ }
    // Python `delete_run_journal` (#3802): a deleted session leaves no replayable run journal behind.
    try { this.deps.journal?.deleteSession(sid) } catch { /* ignore */ }
    this.deps.runtime.closeTerminal(sid)
    // Python: the Agent/CLI transcript in state.db goes too (else a claimable CLI row resurfaces in the sidebar), but a
    // messaging channel's memory is never erased from the WebUI; the actual outcome is reported.
    let stateDbCleanupFailed = false
    if (!isMessaging) {
      // TAL-529: the compression continuations go too, tip first; the Agent's delete keeps and detaches them otherwise.
      for (const id of stateDbCompressionLineage(this.stateDbPath(eventProfile), sid).reverse()) {
        try { if (!(await this.deps.runtime.deleteCliSession(eventProfile, id))) stateDbCleanupFailed = true } catch { stateDbCleanupFailed = true }
      }
    }
    this.publish('session_delete', eventProfile)
    // Only a sidecar session is ever published to the relay.
    if (hadSidecar) this.deps.clearRelayCompletions?.(sid, eventProfile)
    return { ok: true, state_db_cleanup_failed: stateDbCleanupFailed, ...retained }
  }

  cleanup(zeroOnly: boolean): Record<string, unknown> {
    let cleaned = 0
    const removed = new Set<string>()
    for (const s of this.store.scanAll()) {
      const shouldDelete = zeroOnly ? s.messages.length === 0 : s.title === 'Untitled' && s.messages.length === 0
      if (!shouldDelete) continue
      // A cleared session keeps its share; keep the session (and its revoke route) if the share cannot be revoked.
      try { this.deps.shares.revoke(s) } catch { continue }
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

  /** The session and the full transcript its detail is built from; a state.db-only session gives its synthesized one. */
  private fullTranscript(sid: string): { session: Session; transcript: Message[]; stored: boolean } {
    try {
      let session = this.store.get(sid)
      if (session.loadedMetadataOnly) session = this.store.load(sid) ?? session
      if (!this.visibleToActiveProfile(session.profile)) throw new HttpFailure(404, 'Session not found')
      return { session, transcript: this.mergedTranscript(session), stored: true }
    } catch (error) {
      if (error instanceof HttpFailure) throw error
      const session = this.foreignSession(sid).synth
      return { session, transcript: session.messages, stored: false }
    }
  }

  readAnchorScene(query: Record<string, string | null | undefined>): Record<string, unknown> {
    const sid = str(query.session_id).trim()
    const messageRef = normalizeAnchorSceneMessageRef(query.message_ref)
    const messageIndex = anchorSceneIntOrNull(query.message_index)
    if (!sid || (!messageRef && messageIndex === null)) throw new HttpFailure(400, 'session_id and message_ref or message_index are required')
    const { session, transcript, stored } = this.fullTranscript(sid)
    const result = readAnchorSceneRows(session, { messageRef, messageIndex, before: anchorSceneIntOrNull(query.before), limit: anchorSceneIntOrNull(query.limit) }, withToolCallOutcomes(withTurnIds(transcript), session.tool_calls, session.active_stream_id))
    if (!result) throw new HttpFailure(404, 'Anchor activity scene not found')
    // Paged rows come from the raw transcript, so they take the same credential redaction as the detail's preview.
    const enabled = this.deps.redactEnabled()
    const redacted = redactValue(result, enabled) as typeof result
    const rows = withSceneToolDisplay(result.rows, redacted.rows as unknown[], enabled)
    // `/api/media` serves stored sessions only, so a state.db-only session's rows stay as written, as its detail does.
    return { ...redacted, rows: stored ? withSceneRowMedia(rows, this.mediaProjector(session)) : rows }
  }

  /** TAL-331: one tool call's whole result, which a limited response clipped (`result_truncated`), redacted like the detail. */
  readToolResult(query: { session_id: string; tool_call_id: string }): { tool_call_id: string; result: string; result_view: ToolResultView } {
    const sid = query.session_id.trim()
    const id = query.tool_call_id.trim()
    if (!sid || !id) throw new HttpFailure(400, 'session_id and tool_call_id are required')
    const full = fullToolResult(this.fullTranscript(sid).transcript, id)
    if (full === null) throw new HttpFailure(404, 'Tool result not found')
    return { tool_call_id: id, ...redactValue(full, this.deps.redactEnabled()) as typeof full }
  }

  // ── shares ───────────────────────────────────────────────────────────────

  createShare(sid: string): Record<string, unknown> {
    this.rejectClaudeCode(sid, 'shared')
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
      share: { token: meta.share_token, url: sharePath(meta.share_token) ?? '', title: meta.share_title, message_count: meta.share_message_count, created_at: meta.share_created_at, updated_at: meta.share_updated_at },
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

/** Python `_sanitize_error`: absolute paths in an error message never reach the client. */
export function sanitizePaths(error: unknown): string {
  return str((error as Error)?.message ?? error).replace(/(?:(?:\/[a-zA-Z0-9_.-]+)+|(?:[A-Z]:\\[^\s]+))/g, '<path>')
}

/** TAL-536: a dead run's own state.db rows: from its prompt to the next prompt (tool results and applied steers stay in it). */
function runStateDbRows(rows: Message[], prompt: string): Message[] | null {
  const at = rows.findIndex((m) => looksLikeCurrentUserTurn(m, prompt))
  if (at < 0) return null
  const toolResult = (m: Message): boolean => Array.isArray(m.content) && m.content.some((part) => isDict(part) && part.type === 'tool_result')
  const end = rows.findIndex((m, i) => i > at && m.role === 'user' && !toolResult(m) && agentSteerText(m) === null)
  return rows.slice(at, end < 0 ? undefined : end)
}

/** TAL-493: a row's full-text identity; one with no text (reasoning or media only) by its raw role, content, and reasoning. */
function settledIdentity(m: Message): string {
  return messageIdentity(m, Infinity) ?? JSON.stringify([m.role ?? null, m.content ?? null, reasoningFieldsText(m)])
}

/** `rows` minus one occurrence of each row of `base`, by `settledIdentity`. */
function withoutRows(rows: Message[], base: Message[]): Message[] {
  const left = new Map<string, number>()
  for (const m of base) left.set(settledIdentity(m), (left.get(settledIdentity(m)) ?? 0) + 1)
  return rows.filter((m) => { const key = settledIdentity(m); const n = left.get(key) ?? 0; if (n > 0) left.set(key, n - 1); return n === 0 })
}

/**
 * TAL-493: what the state.db marker was recorded under: the boundary fields every boundary writer sets (an older release
 * moves them without the marker) and the role, timestamp, and database file identity of the row the marker names (a
 * recreated state.db, whose ids start over, has no such row).
 */
function stateDbMarkKey(s: Session, stateRows: Message[], seenId: number | null): string {
  const anchor = seenId === null ? undefined : stateRows.find((m) => m._state_db_row_id === seenId)
  return JSON.stringify([s.truncation_watermark ?? null, s.truncation_boundary ?? null, s.intentional_shrink_generation ?? null, s.clear_generation ?? null, anchor ? [anchor.role ?? null, anchor.timestamp ?? null, anchor._state_db_generation ?? null] : null])
}

/**
 * The recorded state.db marker while what it was recorded under still holds and this version wrote the session last (an
 * older release can apply a boundary that changes no field), else null (the timestamp rules apply).
 */
function currentStateDbSeenId(s: Session, stateRows: Message[]): number | null {
  const seenId = s.state_db_seen_id
  return seenId !== null && s.state_db_seen_stamp === s.updated_at && s.state_db_seen_boundary === stateDbMarkKey(s, stateRows, seenId) ? seenId : null
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

/** Python truthiness for the JSON values a transcript row carries. */
function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (isDict(v)) return Object.keys(v).length > 0
  return Boolean(v)
}

/** JSON with sorted object keys (Python `json.dumps(..., sort_keys=True)`). */
function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) => (isDict(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value)) ?? ''
}

/** Equality key for a row `id`/`timestamp`; `null` when the value is absent. Numbers compare by value (`2 == 2.0`). */
function identityKey(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? `s${v}` : typeof v === 'number' ? `n${String(v)}` : `j${sortedJson(v)}`
}

function rowSignature(row: unknown): string | null {
  if (!isDict(row)) return null
  const field = (v: unknown): string => (!pyTruthy(v) ? '' : typeof v === 'string' ? v : sortedJson(v))
  return JSON.stringify([field(row.role), field(row.content), field(row.tool_call_id), field(row.tool_use_id), field(row.tool_name || row.name), field(row.tool_calls)])
}

/** First index in sorted `positions` whose value is `>= start`. */
function lowerBound(positions: number[], start: number): number {
  let lo = 0
  let hi = positions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (positions[mid]! < start) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Map each display row to the context row it represents, scanning forward. An `id` match wins; otherwise the role+content
 * signature must match, and a shared `timestamp` makes it exact. A signature match where an identity is missing is weak:
 * one weak candidate counts as a match, a second one before any exact match leaves the row ambiguous.
 */
function alignDisplayToContext(ctx: unknown[], full: unknown[]): { matches: (number | null)[]; ambiguous: (number | null)[] } {
  const index = () => new Map<string, number[]>()
  const push = (map: Map<string, number[]>, key: string, idx: number): void => {
    const list = map.get(key)
    if (list) list.push(idx)
    else map.set(key, [idx])
  }
  const first = (list: number[] | undefined, start: number): number | undefined => list?.[lowerBound(list, start)]
  const byId = index(), bySigTs = index(), bySigTsNoId = index()
  const weakAny = index(), weakNoId = index(), weakNoTs = index(), weakNoIdNoTs = index()
  ctx.forEach((row, idx) => {
    const sig = rowSignature(row)
    if (sig === null) return
    const id = identityKey((row as Message).id)
    const ts = identityKey((row as Message).timestamp)
    push(weakAny, sig, idx)
    if (id === null) push(weakNoId, sig, idx)
    if (ts === null) push(weakNoTs, sig, idx)
    if (id === null && ts === null) push(weakNoIdNoTs, sig, idx)
    if (id !== null) push(byId, id, idx)
    if (ts !== null) {
      push(bySigTs, `${sig}\0${ts}`, idx)
      if (id === null) push(bySigTsNoId, `${sig}\0${ts}`, idx)
    }
  })

  const matches: (number | null)[] = []
  const ambiguous: (number | null)[] = []
  let next = 0
  for (const message of full) {
    let match: number | null = null
    let ambiguousAt: number | null = null
    const sig = rowSignature(message)
    if (sig !== null) {
      const id = identityKey((message as Message).id)
      const ts = identityKey((message as Message).timestamp)
      const exact = [id !== null ? first(byId.get(id), next) : undefined, ts !== null ? first((id !== null ? bySigTsNoId : bySigTs).get(`${sig}\0${ts}`), next) : undefined]
        .filter((idx): idx is number => idx !== undefined)
      const exactIdx = exact.length ? Math.min(...exact) : null
      const weakList = (id !== null ? (ts !== null ? weakNoIdNoTs : weakNoId) : ts !== null ? weakNoTs : weakAny).get(sig) ?? []
      const w = lowerBound(weakList, next)
      const [firstWeak, secondWeak] = [weakList[w], weakList[w + 1]]
      if (secondWeak !== undefined && (exactIdx === null || secondWeak < exactIdx)) ambiguousAt = firstWeak!
      else match = exactIdx ?? firstWeak ?? null
    }
    matches.push(match)
    ambiguous.push(ambiguousAt)
    if (match !== null) next = match + 1
  }
  return { matches, ambiguous }
}

/** Align model context with the display prefix `full[:keep]` (Python `truncate_context_for_display_keep`, #5096/#5563). */
export function truncateContextForDisplayKeep(context: Message[] | null | undefined, full: unknown[], keep: number): Message[] {
  if (keep <= 0) return []
  const ctx = context ?? []
  if (!ctx.length || !full.length) return []
  if (keep < full.length) {
    const { matches, ambiguous } = alignDisplayToContext(ctx, full)
    const lastKept = matches[keep - 1]!
    const firstUnkept = matches[keep]!
    const boundary = full[keep - 1]
    const keptUser = isDict(boundary) && boundary.role === 'user'
    // Cut at the first unkept display row; a kept user turn ends at its own row so unkept tool rows after it drop.
    if (firstUnkept !== null) return lastKept !== null && keptUser ? ctx.slice(0, lastKept + 1) : ctx.slice(0, firstUnkept)
    if (lastKept !== null) {
      const ambiguousUnkept = ambiguous[keep]!
      return ambiguousUnkept !== null && isDict(boundary) && !keptUser ? ctx.slice(0, ambiguousUnkept) : ctx.slice(0, lastKept + 1)
    }
    // Both boundary rows unresolved in a shorter (compressed) context: cut past the last kept display row that resolved,
    // accepting a weak match. Under-keeping beats slicing at the raw display index.
    if (ctx.length < full.length) {
      for (let i = keep - 1; i >= 0; i -= 1) {
        const resolved = matches[i] ?? ambiguous[i]
        if (resolved !== null && resolved !== undefined) return ctx.slice(0, resolved + 1)
      }
    }
  }
  // Unalignable (or nothing cut): keep the compaction prefix a longer context carries, then `keep` rows (#5096).
  const prefixLen = Math.max(0, ctx.length - full.length)
  return ctx.slice(0, prefixLen + keep)
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
  session.truncation_watermark_compressed = false
  return [oldMsgCount, oldCtxCount]
}

function shrinkTo(session: Session, lastUserIdx: number): void {
  const history = session.messages
  session.messages = history.slice(0, lastUserIdx)
  stampIntentionalShrink(session, history.length, session.messages.length)
  session.truncation_watermark = truncationWatermarkFor(session.messages)
  session.truncation_boundary = session.truncation_watermark
  session.truncation_watermark_compressed = false
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
