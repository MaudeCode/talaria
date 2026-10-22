import { unavailableContextDetail, type ContextDetail } from '@maudecode/talaria-web-contracts'
import { filterAsync } from '../util.js'
import { statSignature } from '../fs/stat.js'
import { SessionPrefixIndex } from './prefix-index.js'
/**
 * Route-level session operations (the Python `/api/session*` handlers): the
 * detail payload, list and search, and every mutation with its guards.
 * Runtime concerns owned by other domains arrive through `SessionServiceDeps`.
 */
import type { AgentStorage, ChatReadiness, PendingSteer, RecoveryAudit, RunStatus, SessionGoal, SessionNotice, RecoveryRepair, SidecarResult } from '@maudecode/talaria-web-contracts'
import type { RunJournal } from './journal.js'
import { str } from '../util.js'
import { createHmac, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildActiveTurnToken, copyJson, redactSessionData, redactValue, stripPublicInternalFields, withSceneToolDisplay } from '../redact.js'
import type { DraftStore } from './drafts.js'
import { DraftVersionConflict, normalizeDraftVersion } from './drafts.js'
import type { SessionEventBus } from './events.js'
import { allSessions, buildSessionListPayload, reconcileLocalSessionRows, sessionLineageIds, CLI_IDENTITY_FIELDS, isClaimableCliSource, isMessagingSessionRecord, ownerLockCandidates, withOwnerLocks, withSessionWireFlags, lineageRootId, type OwnerSources, mergeCliSidebarMetadata, sessionListResponse, sessionSearchMatches, sessionSearchPreview, sessionSearchTerms, type ListParams, type ListResponse, type Row, type RuntimeOverlay } from './list.js'
import { anchorSceneIntOrNull, fullToolResult, hydrateAnchorActivityScenes, normalizeAnchorSceneMessageRef, readAnchorSceneRows, storeAnchorScene, withTurnIds } from './anchor.js'
import { contextUsage, COMPRESSION_RECOVERY_ACTION_START_FOCUSED, compressionRecoveryPayload, forgetContextFigures, isSafeSessionId, lastMessageTimestamp, Session, sharePath, stripAttachedFilesMarker, titleFrom, WORKTREE_RETAINED_KEY, type Message } from './session.js'
import { SessionBusy, SessionNotFound, type SessionStore } from './store.js'
import { UNSETTLED_TODO_KEY, attachTodoSnapshot, attachTodoState } from './todo.js'
import { isClaudeCodeSessionId, type ClaudeCodeSessionSource } from './claude-code.js'
import { auditSessionRecovery, repairSafeSessionRecovery, type RecoveryDeps } from './recovery.js'
import { stateDbWebDiagnosticIdsAsync, agentSessionRowsExistingAsync, CANONICAL_READ_ONLY_REASON, OWNERSHIP_UNAVAILABLE_REASON, CONVERSATION_ROUND_THRESHOLD, emptyLineageReport, stateDbSessionReadAsync, stateDbSessionSourcesAsync, stateDbTimestampSeconds, withStateDbListingReads, type stateDbSessionRow, type StateDbRead, type StateDbSessionSource, type StateDbSettlementRead } from './state-db.js'
import { completionIncomplete, fallbackHandoffSummary, HANDOFF_SYSTEM_PROMPT, handoffMarker, handoffPayload, handoffTranscript, messageHandoffPayload, sameHandoff } from './handoff.js'
import { anchorMessageKey, anchorSummary, CompressionJobs, compressionReference, visibleMessagesForAnchor, type CompressionJob } from './compress.js'
import { chatReadiness, runtimeFailureDetails, SidecarError, type SidecarLike } from '../sidecar/client.js'
import { agentSteerText, ApiMessageSummary, appendStateDbIdentityRows, attachedFilesPrompt, attachmentObjects, checkpointTurnStart, dedupeContext, isContextCompressionMarker, journalOutputRows, looksLikeCurrentUserTurn, stoppedTurnContext, mergeSessionMessagesAppendOnly, messageIdentity, pendingUserRow, reasoningFieldsText, sanitizeMessagesForApi, withDataUseRequirements, stateDbSeenId, stripWorkspacePrefix, withAttachmentObjects, newestSettledReply, withBodyExcerpts, withDisplayMedia, withMarkerKinds, withMirrorSources, withSceneRowMedia, withPendingUserTurn, withToolCallOutcomes, withoutRunningTurnOutput, type ToolResultView } from './merge.js'
import { withBackgroundUpdates } from './background-updates.js'
import { markedStateDbGeneration, stateDbIdentityKeys, stampStateDbGeneration, stateDbMessageRepresented } from './state-db-identity.js'
import { sourceKind } from './source-kind.js'
import { withBackgroundLinks, type Receipt } from './background-tasks.js'
import { messagesForLimitedPayload, messageCountsAsRenderable, messageWindowForDisplay, MAX_MSG_LIMIT, parseMsgLimit, toolCallsForMessageWindow } from './window.js'
import { redactText } from '../redact.js'
import { workspaceDisplayName, type WorkspaceEntry, type WorkspaceRegistry } from '../workspace/workspaces.js'
import { buildShareSnapshot, type ShareStore } from './shares.js'
import { mediaAnchorRootResolved, resolveMediaAccess, mediaRefPath, mediaTarget, type MediaAccessDeps } from '../workspace/media.js'
import { projectMediaRefs, type MediaProjection } from '../workspace/media-refs.js'
import type { ProjectStore } from '../projects.js'
import { loadGatewaySessionIdentityMap } from './list.js'
import { join } from 'node:path'
import type { GatewaySessions } from './gateway-sessions.js'

export class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HttpFailure'
  }
}

/**
 * Python `_agent_runtime_barrier_response`: a stale local Agent checkout is refused with a typed 409 before the caller
 * mutates anything. An unavailable connection is refused before dispatch; other check failures are not a verdict
 * and let the caller proceed.
 */
export async function ensureAgentRuntimeCurrent(sidecar: SidecarLike | null): Promise<void> {
  if (!sidecar) return
  // Runtime RPCs bypass the client's ready gate and can queue behind an unfinished handshake.
  if (chatReadiness(sidecar).condition === 'sidecar_unavailable') {
    throw new HttpFailure(503, 'The Agent sidecar is not ready; retry once it finishes starting.', { condition: 'sidecar_unavailable' })
  }
  try {
    await sidecar.call('runtime.ensure_current', {})
  } catch (error) {
    if (error instanceof SidecarError && error.condition === 'agent_runtime_stale') throw staleRuntimeFailure(error)
  }
}

/** The health probe is also the browser's server-reachability probe (30 s), so the readiness check answers well inside it. */
const CHAT_READINESS_CHECK_TIMEOUT_MS = 5_000
/** TAL-1254: how soon a worktree lock the sidecar could not confirm is tried again. */
export const WORKTREE_RETAIN_RETRY_MS = 60_000

/**
 * TAL-951: whether a chat turn would be admitted now. Ready and source-stale incompatible sidecars both run turn
 * admission's live check: recovery state can change after the handshake. A check
 * that cannot answer fails closed as `sidecar_unavailable`.
 */
export async function currentChatReadiness(sidecar: SidecarLike | null): Promise<ChatReadiness> {
  const readiness = chatReadiness(sidecar)
  if (!sidecar || (!readiness.available && readiness.condition !== 'agent_runtime_stale')) return readiness
  try {
    await sidecar.call('runtime.ensure_current', {}, { timeoutMs: CHAT_READINESS_CHECK_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof SidecarError && error.condition === 'agent_runtime_stale') return { available: false, ...runtimeFailureDetails(error.condition, error.data), condition: 'agent_runtime_stale' }
    return { available: false, condition: error instanceof SidecarError && error.condition === 'agent_incompatible' ? 'agent_incompatible' : 'sidecar_unavailable' }
  }
  // The live guard can clear after a rollback, but the client's incompatible admission gate still refuses chat.
  return readiness.available ? readiness : { available: false, ...runtimeFailureDetails('agent_runtime_stale'), condition: 'agent_runtime_stale' }
}

function staleRuntimeFailure(error: SidecarError): HttpFailure {
  const { message, ...details } = runtimeFailureDetails(error.condition, error.data)
  return new HttpFailure(409, message ?? error.message, details)
}

/** Lazy reads shared by one gate sequence, never across a lock wait or sidecar dispatch. */
interface SessionGateReads {
  sid: string
  owners: (profile?: string) => Promise<Map<string, StateDbSessionSource> | null>
  row: () => Promise<ReturnType<typeof stateDbSessionRow>>
  meta: () => Promise<Row | null>
  messages: (stitch: boolean) => Promise<Message[]>
  existing: () => Promise<Set<string>>
}

export interface SessionServiceDeps {
  /** TAL-259: epoch seconds of the state directory's `recovery_stamping_since` marker. */
  recoveryStampingSince: () => Promise<number>
  /** TAL-255: the Agent sidecar for manual compression (`chat.compress`); null while it is down. */
  sidecar?: () => SidecarLike | null
  /** Detached sidecar work for a profile: deletion waits for the returned release, so the home outlives the work. */
  profileActivity?: (profile: string | null) => () => void
  /** A profile whose deletion has started takes no new detached work. */
  profileDeleting?: (profile: string | null) => boolean
  /** TAL-372: the session's background work receipts, for the delegation rows that started them. */
  backgroundReceipts?: (sid: string) => Receipt[] | Promise<Receipt[]>
  backgroundPending?: (sid: string) => Promise<Set<string>>
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
    /** The live stream's server-selected presentation, else null. */
    runStatus?: (streamId: string) => RunStatus | null
    liveToolProgress?: (streamId: string) => Record<string, unknown>[]
    /** TAL-1006: the live stream's open compression span start (epoch seconds), else null. */
    compressionStartedAt?: (streamId: string) => number | null
    /** TAL-899: whether a Stop holds the session's automatic turns until the user's next turn. */
    automaticTurnsHeld?: (sid: string) => Promise<boolean>
    sessionNotices?: (sid: string) => SessionNotice[]
    sessionGoal?: (sid: string) => SessionGoal | null
    /** Drop the session's cached agent; `endSession` (delete/clear) also ends its approval grants and parked approvals. */
    evictAgent: (sid: string, endSession?: boolean) => Promise<void>
    closeTerminal: (sid: string) => void
    /**
     * Python `delete_cli_session`: remove the session and its compression continuations from the profile's state.db in one
     * transaction; `ok` is false on failure, with `refused` when another Agent process holds any of them (TAL-792).
     */
    deleteCliSession: (profile: string | null, sid: string) => Promise<SidecarResult<'state_db.delete_cli_session'>>
  }
  attachmentDir: (sid: string) => string
  /** A deleted session can never be viewed, so its finished runs are cleared from the relay. */
  clearRelayCompletions?: (sid: string, profile: string | null) => Promise<void>
  /** Run journals are removed with their session (Python `delete_run_journal`). */
  journal?: RunJournal
  hermesHome: string
  home: string
  /** Sync title-only metadata to state.db when `sync_to_insights` is on; `manual` marks a user-requested title (rename or regenerate). */
  syncTitle: (session: Session, manual?: boolean) => Promise<void>
  /** TAL-591: the background title job for a CLI session a mutation just claimed (Python `import_cli` queued one). */
  titleClaimed?: (session: Session) => void
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
  /** TAL-1040: the explicit launch route for `provider`: its configured endpoint (model, providers or custom_providers), else null. */
  profileLaunchRoute?: (profile: string, provider: string) => { provider: string; baseUrl: string | null }
  /** TAL-542: the pair a stale session model starts on, from the profile's catalog; `null` keeps it. */
  repairSessionModel?: (profile: string | null, model: string, provider: string | null) => [string, string] | null
  /** Explicit discovery for auxiliary title generation; ordinary turn admission uses only fresh cached repair evidence. */
  warmSessionModelRepair?: (profile?: string | null) => Promise<void>
  yolo: { isEnabled: (sid: string) => boolean; set: (sid: string, enabled: boolean) => void }
  /** state.db sidebar rows for a profile (Python `get_cli_sessions`); null when the projection is unavailable. */
  /** `truncated`: source kinds whose rows stopped at the per-kind window on this read (TAL-482). */
  cliSessions: (profile: string, opts: { sourceFilter: string | null; sessionIds?: readonly string[]; keepEmpty?: boolean; sidebarRows?: boolean }) => Promise<{ rows: Row[]; truncated: ReadonlySet<string>; storage: AgentStorage }>
  /** TAL-551: read-only Claude Code transcripts, listed with the CLI rows when both toggles are on. */
  claudeCode?: ClaudeCodeSessionSource
  profileHome: (profile: string) => string
  /** Python `commit_session_memory` (fire-and-forget): the cached Agent flushes memory for a session the user left. */
  commitSessionMemory?: (sid: string) => Promise<void>
  /** TAL-186: the `/api/media` allow-list the transcript media projection rewrites against; without it nothing local is rewritten. */
  media?: { access: MediaAccessDeps; localIo: (profile: string | null) => boolean }
}

/** TAL-536: the most of a dead run's journal stale-stream cleanup reads (Python's recovery window). */
const RECOVERY_JOURNAL_MAX_BYTES = 8 * 1024 * 1024
const RECOVERY_JOURNAL_MAX_ROWS = 65536
const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export class SessionService {
  owner: GatewaySessions | null = null
  /** TAL-255: one manual compression worker per session, shared by every compress route. */
  private readonly compressionJobs: CompressionJobs
  /** TAL-1005: the turns now waiting on their session's compression job before they read its history. */
  private readonly compactionWaiters = new Set<string>()
  private worktreeRetainRetry: ReturnType<typeof setTimeout> | null = null
  private worktreesUnconfirmed = 0

  constructor(readonly deps: SessionServiceDeps) {
    this.compressionJobs = new CompressionJobs()
  }

  private get store(): SessionStore { return this.deps.store }

  /**
   * User-turn admission shared by `chat.start` and automatic turns through `TurnRunner.startServerTurn`.
   * A requested workspace must be trusted; the session's own one, when its directory is gone, falls back to the last one.
   */
  async turnWorkspace(s: Session, requested?: unknown): Promise<string> {
    const ws = this.deps.workspaces
    if (requested !== undefined && requested !== null && requested !== '') {
      try { return (await ws.resolveTrusted(str(requested), s.profile)) } catch (error) { throw new HttpFailure(400, (error as Error).message) }
    }
    try {
      const [workspace, recovered] = (await ws.resolveImplicitWithRecovery(s.workspace, async (p) => (await ws.lastWorkspace(p)), s.profile))
      if (recovered) s.workspace = workspace
      return workspace
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
  }

  /** Split qualified ids and opportunistically repair against fresh evidence; missing discovery never delays a turn. */
  turnModel(s: Session, body: Record<string, unknown> = {}): [string | null, string | null, boolean] {
    const requestedModel = str(body.model) || s.model
    const requestedProvider = 'model_provider' in body ? (body.model_provider as string | null) : s.model_provider
    const [model, provider] = this.deps.modelStateFromRequest(requestedModel, requestedProvider, s.model_provider)
    if (model !== requestedModel || !model || body.explicit_model_pick === true) return [model, provider, model !== requestedModel]
    const repaired = this.deps.repairSessionModel?.(s.profile ?? null, model, provider)
    return repaired ? [repaired[0], repaired[1], true] : [model, provider, false]
  }

  /**
   * TAL-186: rewrites a session's media references to their URLs. A local path is rewritten only when `/api/media`
   * serves it for this session, under the same resolution, so every rewritten reference loads.
   */
  async mediaProjector(s: Session): Promise<(text: string) => MediaProjection | null> {
    const media = this.deps.media
    const access = media ? await resolveMediaAccess(media.access) : null
    const served = new Map<string, string | null>()
    const localUrl = (path: string): string | null => {
      if (!media?.localIo(s.profile) || !access) return null
      if (served.has(path)) return served.get(path) ?? null
      let url: string | null = null
      try {
        const target = mediaTarget(mediaRefPath(path))
        if (mediaAnchorRootResolved(target, s, access)) url = `./api/media?${new URLSearchParams({ path: target, session_id: s.session_id }).toString()}`
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
  async sessionIdVisible(raw: unknown): Promise<boolean> {
    if (typeof raw !== 'string' || !raw.trim()) return true
    const sid = raw.trim()
    if (!isSafeSessionId(sid)) return false
    let session: Session
    try {
      session = (await this.store.get(sid, { metadataOnly: true }))
    } catch {
      return true
    }
    return this.visibleToActiveProfile(session.profile)
  }

  private localTargets: { key: string; ids: Map<string, string> } | null = null

  /** One receipt-backed physical target for every operation on a local conversation alias, read on the state.db worker. */
  async resolveSessionId(sid: string): Promise<string> {
    try {
      const path = this.stateDbPath(null)
      const stamp = (): string => JSON.stringify([statSignature(path), statSignature(`${path}-wal`), path])
      const key = stamp()
      if (this.localTargets?.key !== key) this.localTargets = { key, ids: new Map() }
      const cached = this.localTargets.ids.get(sid)
      if (cached) return cached
      const { target, read } = await stateDbSessionReadAsync({ target: sid, read: false }, 'stateDbLocalTargetRead', path, sid)
      // A failed or changing read cannot seed a routing cache.
      const targets = this.localTargets
      if (read && targets.key === key && stamp() === key) {
        if (targets.ids.size >= 500) targets.ids.clear()
        targets.ids.set(sid, target)
      }
      return target
    } catch { return sid }
  }

  /** Python `_lookup_cli_session_metadata(...).get('read_only')` plus the persisted sidecar flag and a not-claimable foreign owner. */
  private async isReadOnlyImport(sid: string, reads = this.sessionGateReads(sid)): Promise<boolean> {
    try {
      const s = (await this.store.get(sid, { metadataOnly: true }))
      if (await this.loadedReadOnlyReason(s, undefined, reads)) return true
    } catch {
      // No sidecar: a foreign state.db transcript whose owner refuses claiming is read-only too.
      const { session, reason } = (await this.claimOrSynthesizeCliSession(sid, undefined, reads))
      if (session && reason === 'not_claimable') return true
    }
    const meta = await reads.meta()
    return meta !== null && Boolean(meta.read_only)
  }

  /** Python `_session_is_subagent_view_only`: a delegated child by any signal — the persisted sidecar or the state.db row. */
  async isSubagentViewOnly(sid: string, reads = this.sessionGateReads(sid)): Promise<boolean> {
    try {
      const s = (await this.store.get(sid, { metadataOnly: true, cacheOnMiss: false, promote: false }))
      if (str(s.source_tag || s.raw_source || s.session_source).trim().toLowerCase() === 'subagent') return true
    } catch { /* no sidecar */ }
    const meta = await reads.meta()
    return meta !== null && str(meta.source_tag || meta.raw_source || meta.source).trim().toLowerCase() === 'subagent'
  }

  /** TAL-358: batched `sessions.source` owners from the active profile's state.db, read on the state.db worker (TAL-923). */
  readonly stateDbSources = async (ids: string[], profile = this.deps.activeProfile()): Promise<Map<string, StateDbSessionSource> | null> => {
    try { return await stateDbSessionSourcesAsync(this.stateDbPath(profile), ids) } catch { return null }
  }

  /** The owners of `byProfile`'s ids, read up front, as the synchronous lookup `withOwnerLocks` takes. */
  private async ownerSources(byProfile: Map<string, Set<string>>, read: SessionService['stateDbSources'] = this.stateDbSources): Promise<OwnerSources> {
    const owners = new Map(await Promise.all([...byProfile].map(async ([profile, ids]) =>
      [profile, ids.size ? await read([...ids], profile) : new Map<string, StateDbSessionSource>()] as const)))
    return (_ids, profile = this.deps.activeProfile()) => owners.get(profile) ?? null
  }

  /** `withOwnerLocks` with the owners read on the state.db worker, so a gate or payload never opens state.db on this thread. */
  private async ownerLocked(rows: Row[], read?: SessionService['stateDbSources']): Promise<Row[]> {
    return withOwnerLocks(rows, await this.ownerSources(ownerLockCandidates(rows), read))
  }

  /**
   * TAL-590 (Python #3238): the read-only CLI or API-server imports among `rows` whose active-profile state.db row is
   * gone, so their source was deleted outside Web and no Web action could remove them. An unreadable state.db proves
   * nothing (`agentSessionRowsExisting`); another profile's session or one with a run the runtime still holds is never
   * an orphan, while a stream id a crash left behind does not count as one.
   */
  private async orphanedImports(rows: Row[], existing?: Set<string>, owners?: Map<string, StateDbSessionSource> | null, reads?: SessionGateReads): Promise<Set<string>> {
    const candidates = (await this.orphanCandidates(rows))
    if (!candidates.length) return new Set()
    existing ??= await (reads ? reads.existing() : agentSessionRowsExistingAsync(this.stateDbPath(null), candidates))
    if (owners === undefined) owners = await (reads ? reads.owners() : this.stateDbSources(candidates))
    return new Set(candidates.filter((sid) => !existing.has(sid) && owners !== null && typeof owners.get(sid) !== 'object'))
  }

  private async orphanCandidates(rows: Row[]): Promise<string[]> {
    return (await filterAsync(rows, async (r) => r.read_only && ['cli', 'api'].includes(sourceKind(r)) && this.visibleToActiveProfile(str(r.profile) || null) && !(await this.activeRunBlocking(str(r.session_id)))))
      .map((r) => str(r.session_id))
  }

  private async isOrphanedImport(sid: string, reads = this.sessionGateReads(sid)): Promise<boolean> {
    try { return (await this.orphanedImports([(await this.store.get(sid, { metadataOnly: true })).compact()], undefined, undefined, reads)).size > 0 } catch { return false }
  }

  /**
   * The list's owner locks and orphan prune (an orphan's sidecar goes, as nothing else ever removes it), with their
   * state.db reads made on the listing worker up front so the synchronous build never opens state.db (TAL-920).
   */
  private async listStateDbLookups(rows: Row[], cliRowIds: string[]): Promise<Pick<ListParams, 'stateDbSources' | 'pruneOrphanedImports'>> {
    const dbPath = this.stateDbPath(null)
    const activeProfile = this.deps.activeProfile()
    const byProfile = ownerLockCandidates(rows)
    const activeIds = byProfile.get(activeProfile) ?? new Set<string>()
    for (const id of cliRowIds) activeIds.add(id)
    byProfile.set(activeProfile, activeIds)
    const owners = await this.ownerSources(byProfile)
    const checked = new Set((await this.orphanCandidates(rows)))
    const existing = checked.size ? await agentSessionRowsExistingAsync(dbPath, checked) : new Set<string>()
    return {
      stateDbSources: owners,
      pruneOrphanedImports: async (current) => {
        // Only an id the worker checked can be an orphan; a row that became a candidate meanwhile waits for the next list.
        const orphans = (await this.orphanedImports(current.filter((r) => checked.has(str(r.session_id))), existing, owners([], activeProfile)))
        for (const sid of orphans) (await this.store.delete(sid))
        return orphans
      },
    }
  }

  /** The persisted flag folded with the state.db owner lock (TAL-358): the one read-only rule for mutation gates and the wire. */
  async readOnlyReason(s: Session | string, profile?: string, reads?: SessionGateReads): Promise<string | null> {
    if (typeof s === 'string') {
      try { s = await this.store.get(s, { metadataOnly: true, cacheOnMiss: false, promote: false }) } catch (error) {
        if (!(error instanceof SessionNotFound)) return OWNERSHIP_UNAVAILABLE_REASON
      }
    }
    return await this.loadedReadOnlyReason(s, profile, reads)
  }

  private async loadedReadOnlyReason(s: Session | string, profile?: string, reads?: SessionGateReads): Promise<string | null> {
    let raw: Row = typeof s === 'string' ? { session_id: s, profile: this.deps.activeProfile() }
      : { session_id: s.session_id, profile: s.profile, source_tag: s.source_tag, raw_source: s.raw_source, session_source: s.session_source, read_only: s.read_only }
    if (profile !== undefined) raw = this.deps.profilesMatch(str(raw.profile) || null, profile) ? { ...raw, profile } : { session_id: raw.session_id, profile }
    const row = (await this.ownerLocked([raw], reads ? (_ids, ownerProfile) => reads.owners(ownerProfile) : undefined))[0]!
    return row.read_only ? str(row.read_only_reason) || 'Read-only imported sessions cannot be modified from WebUI' : null
  }

  /**
   * The final owner check before a protected sidecar dispatch or write: callers dispatch as soon as it resolves. The
   * owner is the Agent's, which can change at any moment, so reading it on the state.db worker (TAL-923) widens no
   * window Web could close; the session lock, where one is held, still serializes Web's own writes.
   */
  async assertWritable(session: Session | string, profile?: string, reads?: SessionGateReads): Promise<void> {
    const reason = await this.readOnlyReason(session, profile, reads)
    if (reason) throw new HttpFailure(403, reason)
  }

  /** Controls can exist without a local session file; use the same id the sidecar will address. */
  async idForMutation(sid: string): Promise<string> {
    sid = sid.trim()
    if (!sid) throw new HttpFailure(400, 'Missing required field(s): session_id')
    await this.assertWritable(sid)
    return sid
  }

  async isReadOnly(s: Session): Promise<boolean> { return (await this.readOnlyReason(s)) !== null }

  /** Recheck after the mutex wait; legacy local metadata/handoff actions keep their existing read-only allowance. */
  private withMutationLock<T>(sid: string, fn: () => Promise<T> | T, opts: { timeoutMs?: number; allowReadOnly?: boolean } = {}): Promise<T> {
    return this.store.withLock(sid, async () => {
      if (opts.allowReadOnly) (await this.rejectViewOnly(sid, 'modified'))
      else (await this.assertWritable(sid))
      return fn()
    }, opts)
  }

  /** Full session for mutation, refusing read-only imports (Python `_get_or_materialize_session`). */
  async getForMutation(sid: string, reads?: SessionGateReads): Promise<Session> {
    let s = (await this.get404(sid, {}, reads))
    s = (await this.store.ensureFull(sid, s))
    await this.assertWritable(s, undefined, reads?.sid === s.session_id ? reads : undefined)
    if (str(s.source_tag || s.raw_source).trim().toLowerCase() === 'subagent') throw new HttpFailure(403, 'Read-only subagent child session')
    return s
  }

  private async get404(sid: string, opts: { metadataOnly?: boolean } = {}, reads?: SessionGateReads): Promise<Session> {
    sid = await this.resolveSessionId(sid)
    try {
      return (await this.store.get(sid, opts))
    } catch (error) {
      if (error instanceof SessionNotFound) {
        // Python `_get_or_materialize_session`: a claimable foreign (CLI/TUI/Desktop) session gains a WebUI sidecar
        // on its first mutation; a read-only foreign source answers 403 from `getForMutation`, a missing one 404.
        const synth = (await this.claimOrSynthesizeCliSession(sid, undefined, reads))
        if (synth.session && synth.reason === 'materialized') {
          await this.store.save(synth.session)
          await this.store.touch(synth.session)
          this.deps.titleClaimed?.(synth.session)
          return synth.session
        }
        if (synth.session) return synth.session
        throw new HttpFailure(404, 'Session not found')
      }
      throw error
    }
  }

  /** The Agent's state.db rows for this session (empty for subagent views, which never merge). */
  async stateDbRows(s: Session): Promise<Message[]> {
    return (await this.stateDbRead(s)).rows
  }

  /**
   * `stateDbRows` and whether the read succeeded on a state.db whose messages carry ids (TAL-493). TAL-1162: read on the
   * state.db worker; a worker failure is a failed read.
   */
  stateDbRead(s: Session): Promise<StateDbRead> {
    if (isSubagentView(s)) return Promise.resolve(failedStateDbRead())
    return stateDbSessionReadAsync(failedStateDbRead(), 'stateDbSessionRead', this.stateDbPath(s.profile), s.session_id, { stitch: false, lineage: stateDbReadLineage(s) })
  }

  /** `stateDbRead`'s projection of the rows past `afterId` alone (the detail's page tail), on the state.db worker. */
  stateDbTailRead(s: Session, afterId: number, unidentified: readonly ReadonlyMap<string, number>[]): Promise<StateDbRead & { anchor?: Message; requiresFullRead?: boolean }> {
    return stateDbSessionReadAsync(failedStateDbRead(), 'stateDbSessionTailRead', this.stateDbPath(s.profile), s.session_id, afterId, { lineage: stateDbReadLineage(s), unidentified })
  }

  /** The one read a turn's settlement builds its context from and settles with (`stateDbSettlementRead`). */
  settlementRead(s: Session): Promise<StateDbSettlementRead> {
    const unchanged: StateDbSettlementRead = { ...failedStateDbRead(), lineage: s.state_db_lineage ?? [s.session_id], rotated: null }
    if (isSubagentView(s)) return Promise.resolve(unchanged)
    return stateDbSessionReadAsync(unchanged, 'stateDbSettlementRead', this.stateDbPath(s.profile), s.session_id, s.state_db_lineage)
  }

  /**
   * Preserve existing transcript provenance before a turn adds Agent rows from its starting database read. The stamp
   * lands before this returns; the read follows.
   */
  beginStateDbTurn(s: Session): Promise<StateDbRead> {
    stampStateDbGeneration([...s.messages, ...s.context_messages], markedStateDbGeneration(s))
    return this.stateDbRead(s)
  }

  private stateDbPath(profile: string | null | undefined): string {
    return join(this.deps.profileHome(profile ?? this.deps.activeProfile()), 'state.db')
  }

  /**
   * Python `_merged_session_messages_for_display`: the sidecar transcript merged append-only with the Agent's state.db
   * rows (a WebUI conversation continued from the CLI shows the CLI turns). This is the coordinate space `GET
   * /api/session` exposes, so branching and the next model history slice/extend the same list.
   */
  mergedTranscript(s: Session, local: Message[], stateRows: Message[]): Message[] {
    if (!stateRows.length) return local
    return mergeSessionMessagesAppendOnly(local, stateRows, { truncationWatermark: s.truncation_watermark, compressedWatermark: s.truncation_watermark_compressed, stateDbSeenId: currentStateDbSeenId(s, stateRows), stateDbGeneration: markedStateDbGeneration(s) })
  }

  /**
   * TAL-493: record the highest state.db id this boundary or settled turn read, under the session lock in the same save,
   * so the merge never replays a covered row and appends every row committed after the read. Call it after the boundary
   * fields are set: the marker holds only while they and the row it names stay as recorded.
   */
  markStateDbSeen(s: Session, read: StateDbRead, opts: { boundary?: boolean } = {}): void {
    // Freeze numeric provenance before replacing the marker, including after a database replacement.
    const priorGeneration = markedStateDbGeneration(s)
    if (priorGeneration !== null) stampStateDbGeneration([...s.messages, ...s.context_messages], priorGeneration)
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
  settleStateDb(s: Session, turn: { turnId: string; previousContext: Message[]; agentRows?: Message[] | null; startId?: number | null; startGeneration?: string | null; read: StateDbSettlementRead }): void {
    const read = turn.read
    const agentAdded = withoutRows(turn.agentRows ?? [], turn.previousContext)
    const contextAdded = withoutRows(s.context_messages, turn.previousContext)
    if (typeof turn.startGeneration === 'string') {
      stampStateDbGeneration(s.messages.filter((m) => m._turn_id !== turn.turnId), markedStateDbGeneration(s))
      stampStateDbGeneration([...s.messages.filter((m) => m._turn_id === turn.turnId), ...contextAdded, ...agentAdded], turn.startGeneration)
    }
    const startGeneration = turn.previousContext.findLast((m) => typeof m._state_db_generation === 'string')?._state_db_generation
    const generation = turn.startGeneration ?? markedStateDbGeneration(s) ?? (typeof startGeneration === 'string' ? startGeneration : null)
    const readGeneration = read.generation
    const generationChanged = generation !== null && typeof readGeneration === 'string' && generation !== readGeneration
    const includeUids = read.rows.some((m) => stateDbIdentityKeys(m).some((id) => id.startsWith('uid:')))
    const identities = (m: Message): string[] => stateDbIdentityKeys(m, includeUids, generation)
    const startedWith = new Set(turn.previousContext.flatMap((m) => identities(m)))
    const wasInContext = (m: Message): boolean => stateDbMessageRepresented(m, startedWith, includeUids, generation)
    const earlier = mergeSessionMessagesAppendOnly(s.messages, read.rows.filter(wasInContext), { stateDbSeenId: -1, stateDbGeneration: generation }).slice(s.messages.length)
    const added = new Map<string, number>()
    const addedIds = new Set(agentAdded.flatMap((m) => identities(m)))
    for (const m of agentAdded) {
      if (!identities(m).length) added.set(settledIdentity(m), (added.get(settledIdentity(m)) ?? 0) + 1)
    }
    const ownWorkAfter = turn.agentRows?.length || generationChanged ? null : turn.startId ?? null
    // Without a current marker, the turn's own starting read is the baseline: rows committed after it are judged here.
    const seenId = currentStateDbSeenId(s, read.rows) ?? (generationChanged ? null : turn.startId ?? null)
    const shown = read.rows.length ? mergeSessionMessagesAppendOnly(s.messages, read.rows, { truncationWatermark: s.truncation_watermark, compressedWatermark: s.truncation_watermark_compressed, stateDbSeenId: seenId, stateDbGeneration: generation }) : s.messages
    const fresh = new Set(shown.slice(s.messages.length))
    // The turn's own rows the merge already matched to their local copies use up their share before any shown row can.
    if (seenId !== null) {
      for (const m of read.rows) {
        const id = m._state_db_row_id
        if (typeof id !== 'number' || id <= seenId || wasInContext(m) || fresh.has(m)) continue
        const left = added.get(settledIdentity(m)) ?? 0
        if (left > 0) added.set(settledIdentity(m), left - 1)
      }
    }
    const missed = [...fresh].filter((m) => {
      const id = m._state_db_row_id
      if (wasInContext(m)) return false
      if (stateDbMessageRepresented(m, addedIds, includeUids, generation)) return false
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
      if (s.context_messages.length) s.context_messages = mergeSessionMessagesAppendOnly(s.context_messages, copyJson(missed), { stateDbSeenId: -1, stateDbGeneration: generation })
    }
    this.markStateDbSeen(s, read)
    // TAL-529: a compression rotation moved the Agent to a continuation, whose first rows restate the compressed context.
    // The read follows the new lineage from here, and everything it holds now is covered.
    // ponytail: a CLI row committed to the continuation before this settlement is covered with them; telling them apart
    // needs the Agent to mark the rows it writes at rotation.
    const lineage = read.lineage
    if (JSON.stringify(lineage) !== JSON.stringify(s.state_db_lineage ?? [s.session_id])) {
      s.state_db_lineage = lineage.length > 1 ? lineage : null
      this.markStateDbSeen(s, read.rotated ?? failedStateDbRead())
    }
  }

  /**
   * TAL-921: the model context a turn leaves when it ends without its settled result (an error, a Stop, a dead run), as a
   * Stop's: the Agent's rows when they hold the turn's prompt, else its own rows among `stateRows` (the state.db rows
   * committed after it started), then the prose that streamed past them. Null when it captured nothing the model can use.
   */
  unsettledTurnContext(turn: { previousContext: Message[]; prompt: string | Record<string, unknown>[]; msgText: string; streamedText: string; historyLength: number; agentRows?: Message[] | null; stateRows: Message[] }): Message[] | null {
    const reported = turn.agentRows && checkpointTurnStart(turn.agentRows, turn.msgText, turn.historyLength) !== null ? turn.agentRows : null
    const own = reported ? null : runStateDbRows(turn.stateRows, turn.msgText)
    const checkpoint = reported ?? (own && [...turn.previousContext, ...own])
    const context = stoppedTurnContext(turn.previousContext, checkpoint, turn.prompt, turn.msgText, turn.streamedText, turn.historyLength)
    if (!context) return null
    if (!own || !checkpoint || checkpointTurnStart(checkpoint, turn.msgText, turn.historyLength) === null) return dedupeContext(context)
    // The context holds the turn's own state.db rows from its prompt on. The Agent persisted the prompt's text only, so the
    // prompt row carries what the turn sent (attached files, images). This turn's settlement covers the rows: without
    // their ids, the next one never reads them as a CLI continuation the transcript lacks.
    const at = turn.previousContext.length
    return dedupeContext(context.map((m, i) => {
      if (i === at) return { role: 'user', content: turn.prompt, ...(m.timestamp != null ? { timestamp: m.timestamp } : {}) }
      return i > at && i < at + own.length ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== '_state_db_row_id' && k !== '_state_db_generation')) : m
    }))
  }

  /**
   * Python `reconciled_state_db_messages_for_session(prefer_context=True)`: the model history is the owner context
   * extended append-only with the Agent's state.db rows (a CLI continuation of this session reaches the model), except
   * for a compressed context whose anchor cannot be verified — that stays context-only.
   */
  modelContext(s: Session, stateRows: Message[]): Message[] {
    const local: Message[] = s.context_messages.length ? s.context_messages : s.messages.filter((m) => !m._error && !m._partial)
    return local.some((m) => isContextCompressionMarker(m)) ? local : this.mergedTranscript(s, local, stateRows)
  }

  /** `modelContext` over a state.db read taken now. */
  async readModelContext(s: Session): Promise<Message[]> {
    return this.modelContext(s, await this.stateDbRows(s))
  }

  /**
   * TAL-518: the model context a `/btw` clone inherits: the chat's history plus its running turn's prompt, which
   * deferred save keeps out of `messages` and `context_messages` until settlement.
   */
  async sideQuestionContext(s: Session): Promise<Message[]> {
    const context = structuredClone(await this.readModelContext(s))
    const pending = this.pendingTurn(s)
    return pending ? withPendingUserTurn(context, pending) : context
  }

  /** Python `_is_messaging_session_id`: from the WebUI metadata or the Agent's row. */
  private async isMessagingSession(sid: string, reads = this.sessionGateReads(sid)): Promise<boolean> {
    try { if (isMessagingSessionRecord((await this.store.get(sid, { metadataOnly: true })).compact())) return true } catch { /* absent */ }
    const meta = await reads.meta()
    return meta !== null && isMessagingSessionRecord(meta)
  }

  private sessionGateReads(sid: string): SessionGateReads {
    const profile = this.deps.activeProfile()
    const dbPath = this.stateDbPath(profile)
    const owners = new Map<string, Promise<Map<string, StateDbSessionSource> | null>>()
    let row: Promise<ReturnType<typeof stateDbSessionRow>> | undefined
    let meta: Promise<Row | null> | undefined
    let transcript: Promise<Message[]> | undefined
    let context: Promise<Message[]> | undefined
    let existing: Promise<Set<string>> | undefined
    return {
      sid,
      owners: (ownerProfile = profile) => {
        let pending = owners.get(ownerProfile)
        if (!pending) { pending = this.stateDbSources([sid], ownerProfile); owners.set(ownerProfile, pending) }
        return pending
      },
      row: () => row ??= stateDbSessionReadAsync(null, 'stateDbSessionRow', dbPath, sid),
      meta: () => meta ??= this.lookupCliMeta(sid),
      messages: (stitch) => stitch
        ? transcript ??= isClaudeCodeSessionId(sid) ? Promise.resolve(this.deps.claudeCode?.messages(sid) ?? []) : stateDbSessionReadAsync([], 'stateDbSessionMessages', dbPath, sid, { stitch: true })
        : context ??= stateDbSessionReadAsync([], 'stateDbSessionMessages', dbPath, sid, { stitch: false }),
      existing: () => existing ??= agentSessionRowsExistingAsync(dbPath, [sid]),
    }
  }

  /**
   * Python `_lookup_cli_session_metadata`: the sidebar row for a state.db session in the active profile, else its plain
   * row (a segment its chain's row does not name). Both are read by id: the sidebar listing would scan every session to
   * rank its window (TAL-923).
   */
  private async lookupCliMeta(sid: string): Promise<Row | null> {
    try {
      if (isClaudeCodeSessionId(sid)) return (await this.claudeCodeRows()).find((r) => str(r.session_id) === sid) ?? null
      const profile = this.deps.activeProfile()
      return (await this.deps.cliSessions(profile, { sourceFilter: null, sessionIds: [sid], sidebarRows: true })).rows.find((r) => str(r.session_id) === sid)
        ?? (await this.deps.cliSessions(profile, { sourceFilter: null, sessionIds: [sid] })).rows[0] ?? null
    } catch {
      return null
    }
  }

  private async claudeCodeRows(): Promise<Row[]> {
    return this.deps.claudeCode?.rows((await this.deps.workspaces.lastWorkspace(this.deps.activeProfile()))) ?? []
  }

  /** Python `_session_index_marks_was_webui`: an index row that once owned a WebUI sidecar (self-heal 404). */
  private async indexMarksWasWebui(sid: string): Promise<boolean> {
    let entries: Record<string, unknown>[]
    try { entries = (await this.store.readIndexEntries()) } catch { return false }
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
  async claimOrSynthesizeCliSession(sid: string, metaIn?: Row | null, reads?: SessionGateReads): Promise<{ session: Session | null; reason: 'materialized' | 'not_claimable' | 'was_webui' | 'no_foreign_state' | 'invalid_sid' }> {
    if (!isSafeSessionId(sid)) return { session: null, reason: 'invalid_sid' }
    const profile = this.deps.activeProfile()
    sid = await this.resolveSessionId(sid)
    if (reads?.sid !== sid) reads = this.sessionGateReads(sid)
    const [row, owners] = await Promise.all([reads.row(), reads.owners()])
    const stateDbSource = str(row?.source).trim().toLowerCase()
    const subagentChild = stateDbSource === 'subagent'
    const canonical = typeof owners?.get(sid) === 'object'
    if (((await this.indexMarksWasWebui(sid)) || ((await this.store.wasDeleted(sid)) && ['', 'webui', 'fork'].includes(stateDbSource))) && !subagentChild && !canonical) return { session: null, reason: 'was_webui' }
    const msgs = await reads.messages(true)
    const meta: Row = { ...(metaIn ?? (await reads.meta()) ?? {}) }
    // An owner receipt proves a session before its first turn (a fresh diagnostic chat, TAL-1040); a bare row does not.
    if (!msgs.length && !(meta._lineage_root_id && meta._lineage_tip_id) && !canonical) return { session: null, reason: 'no_foreign_state' }
    if (row) {
      if (!meta.source_tag && stateDbSource) meta.source_tag = stateDbSource
      if (!meta.raw_source && stateDbSource) meta.raw_source = stateDbSource
      if (!meta.title && row.title) meta.title = row.title
      if (!meta.model && row.model) meta.model = row.model
      if (!meta.workspace && row.cwd) meta.workspace = row.cwd
      if (!meta.created_at && row.started_at) meta.created_at = row.started_at
      if (!meta.updated_at && (row.ended_at || row.started_at)) meta.updated_at = row.ended_at || row.started_at
    }
    // An owner read that fails is an unknown owner, which never releases a claim (TAL-793).
    const claimable = owners !== null && isClaimableCliSource(meta, owners.get(sid) || stateDbSource)
    const workspace = str(meta.workspace || meta.cwd).trim() || (await this.deps.workspaces.lastWorkspace(profile))
    const defaults = (await this.store.deps.defaults(profile))
    const context = Array.isArray(meta._lineage_ids) ? await reads.messages(false) : null
    const session = new Session({
      session_id: sid, title: str(meta.title) || 'CLI Session', workspace, model: str(meta.model) || 'unknown', model_provider: str(meta.model_provider) || null,
      messages: msgs, created_at: Number(meta.created_at) || 0, updated_at: Number(meta.updated_at) || 0, profile: str(meta.profile) || null,
      pinned: Boolean(meta.pinned), archived: Boolean(meta.archived),
      ...(context ? { context_messages: context } : {}),
      is_cli_session: claimable ? true : !subagentChild, source_tag: str(meta.source_tag) || null, raw_source: str(meta.raw_source) || null,
      session_source: str(meta.session_source) || null, source_label: str(meta.source_label) || null, read_only: !claimable,
      // Python `import_cli_session`: the claimed sidecar keeps the row's lineage, background project and channel identity
      // (identity persists through `Session.extra`).
      parent_session_id: str(meta.parent_session_id) || null, project_id: str(meta.project_id) || null,
      ...Object.fromEntries(CLI_IDENTITY_FIELDS.filter((k) => meta[k] != null && meta[k] !== '').map((k) => [k, meta[k]])),
    }, defaults)
    return { session, reason: claimable ? 'materialized' : 'not_claimable' }
  }

  private async mutationTarget(sid: string, verb: string, reads?: SessionGateReads): Promise<Session> {
    try {
      return (await this.getForMutation(sid, reads))
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

  private async rejectViewOnly(sid: string, verb: string, reads?: SessionGateReads): Promise<string> {
    sid = sid.trim()
    if (reads?.sid !== sid) reads = this.sessionGateReads(sid)
    this.rejectClaudeCode(sid, verb)
    let profile = this.deps.activeProfile()
    try { profile = (await this.store.get(sid, { metadataOnly: true, cacheOnMiss: false, promote: false })).profile || 'default' } catch { /* foreign row */ }
    const owners = await reads.owners(profile)
    const owner = owners?.get(sid)
    if (!owners || typeof owner === 'object') throw new HttpFailure(403, typeof owner === 'object' ? owner.reason ?? CANONICAL_READ_ONLY_REASON : OWNERSHIP_UNAVAILABLE_REASON)
    if ((await this.isSubagentViewOnly(sid, reads))) throw new HttpFailure(400, `Subagent sessions are view-only and cannot be ${verb} from WebUI`)
    return sid
  }

  /** All transcript transports use the same live-run and durable-pending evidence. */
  async backgroundUpdates<T>(s: Session, messages: T[], reviewRows?: (turnId: string) => Message[]): Promise<T[]> {
    return withBackgroundUpdates(messages, s, { activeTurnId: this.deps.runtime.activeRunStream(s.session_id), pendingDelegations: (await this.deps.backgroundPending?.(s.session_id)) ?? new Set(), ...(reviewRows ? { reviewRows } : {}) })
  }

  /** TAL-372: each delegation row of a turn's scene carries the status of the work it started. */
  async backgroundLinked(s: Session, messages: unknown[]): Promise<unknown[]> {
    return withBackgroundLinks(messages, (await this.deps.backgroundReceipts?.(s.session_id)) ?? [])
  }

  /** `compact()` plus messages, redacted for the wire (Python `_public_session_projection`). */
  async publicSession(s: Session, withMessages = true, messages: Message[] = s.messages): Promise<Record<string, unknown>> {
    const payload = (await this.wireRow(s))
    // Mutation replies replace a client's transcript, so they carry the same server-built scenes as the detail.
    if (withMessages) {
      payload.messages = (await this.backgroundLinked(s, hydrateAnchorActivityScenes(withToolCallOutcomes((await this.backgroundUpdates(s, withMarkerKinds(withTurnIds(messages), s))), s.tool_calls, s.active_stream_id), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, runningScene: !(await this.journaledActiveTurn(s)) })))
      payload.compression_reference = compressionReference(s, payload.messages as unknown[])
    }
    return redactSessionData(payload, this.deps.redactEnabled())
  }

  /** Opaque read identity, including context changes that do not alter display message counts. */
  private contextDetailKey(s: Session): string {
    return createHash('sha256').update(JSON.stringify([s.session_id, s.profile, s.model, s.model_provider, s.workspace, s.updated_at, s.messages.length, s.context_messages, s.post_compression_context_tokens_estimate, s.active_stream_id])).digest('hex')
  }

  /** `compact()` with the wire streaming/read-only flags (TAL-312), for replies that return the session row. */
  async wireRow(s: Session): Promise<Record<string, unknown>> {
    return withSessionWireFlags((await this.ownerLocked([{ ...s.compact({ contextLengthFor: this.deps.contextLengthFor, modelOptionFor: this.deps.modelOptionFor }), context_detail_key: this.contextDetailKey(s), assistant_name: this.assistantName(s), workspace_name: (await this.workspaceNames([s]))(s) }]))[0]!, this.deps.runtime.activeStreamIds)
  }

  /**
   * TAL-303: the label for a session's workspace, from its own profile's registry (a profileless row is the root's).
   * One resolver serves one response, so each profile's registry is read once however many rows it names.
   */
  async workspaceNames(rows: readonly { profile?: unknown; workspace?: unknown }[]): Promise<(row: { profile?: unknown; workspace?: unknown }) => string | null> {
    const registries = new Map<string, WorkspaceEntry[]>()
    for (const profile of new Set(rows.map((row) => str(row.profile) || 'default'))) {
      let entries: WorkspaceEntry[]
      try { entries = await this.deps.workspaces.entries(profile) } catch { entries = [] }
      registries.set(profile, entries)
    }
    return (row) => workspaceDisplayName(str(row.workspace), registries.get(str(row.profile) || 'default') ?? [])
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

  private async loadRevision(s: Session): Promise<string | null> {
    return (await this.store.revision(s.session_id))
  }

  private readonly pageTails = new WeakMap<SessionPrefixIndex, { key: string; tail: Message[]; index: SessionPrefixIndex; newestReply?: number | null; enoughContext: boolean; sources: SessionService['stateDbSources']; contextRows: Message[]; contextLength: number; summary: { total: number; last: number; todo: Record<string, unknown> | null; compression: ReturnType<SessionPrefixIndex['compressionReference']> } }>()
  private readonly pageContexts = new WeakMap<SessionPrefixIndex, { key: string; local: Message[]; enough: boolean; contextRows: Message[]; contextLength: number; marker: boolean; unidentified: readonly ReadonlyMap<string, number>[] }>()

  private prefixIndex(s: Session, revision: string | null): SessionPrefixIndex {
    const previous = s.prefixIndex
    if (previous?.rows === s.messages && previous.revision === revision && previous.length <= s.messages.length) {
      previous.extend()
      return previous
    }
    return s.prefixIndex = new SessionPrefixIndex(s.messages, revision, markedStateDbGeneration(s), { toolCalls: s.tool_calls })
  }

  /** Existing projections, once per complete turn range, in absolute transcript coordinates. */
  private async deriveRange(s: Session, rows: Message[], baseIndex: number, initialTurn: string, journaled: boolean, refs: Pick<Map<string, number>, 'get'>, calls: unknown[], reviewRows: (turnId: string) => Message[]): Promise<Message[]> {
    return (await this.backgroundLinked(s, hydrateAnchorActivityScenes(withToolCallOutcomes((await this.backgroundUpdates(s, withMarkerKinds(withTurnIds(withAttachmentObjects(rows), baseIndex, initialTurn), s), reviewRows)), calls, s.active_stream_id, baseIndex), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, runningScene: !journaled, clipToolResults: true, baseIndex, refCounts: refs }))) as Message[]
  }

  private async limitedDetail(s: Session, index: SessionPrefixIndex, limit: number, before: number | null, pending: ReturnType<SessionService['pendingTurn']>, journaled: Awaited<ReturnType<SessionService['journaledActiveTurn']>>, retried = false) {
    let prefixEnd = s.messages.length
    const turnId = pending?.turnId ?? journaled?.turnId
    if (turnId) prefixEnd = Math.min(prefixEnd, index.turns.get(turnId)?.first ?? prefixEnd)
    const prompt = pending ? index.prompts.get(pending.activeTurnToken) : undefined
    if (prompt !== undefined) prefixEnd = Math.min(prefixEnd, prompt)
    const dbPath = this.stateDbPath(s.profile)
    const key = JSON.stringify([index.revision, index.length, statSignature(dbPath), statSignature(`${dbPath}-wal`), s.active_stream_id, pending, journaled, s.state_db_seen_id, s.state_db_seen_boundary, s.state_db_seen_stamp, s.updated_at, this.deps.activeProfile(), s.compression_anchor_summary, s.compression_anchor_message_key, s.compression_anchor_visible_idx, this.compactionWaiters.has(s.active_stream_id ?? '')])
    let cached = this.pageTails.get(index)
    if (cached?.key !== key || cached.contextRows !== s.context_messages || cached.contextLength !== s.context_messages.length) {
      const streaming = Boolean(s.active_stream_id && !this.compactionWaiters.has(s.active_stream_id))
      const contextKey = JSON.stringify([index.revision, s.active_stream_id, index.length, streaming])
      let context = this.pageContexts.get(index)
      if (context?.key !== contextKey || context.contextRows !== s.context_messages || context.contextLength !== s.context_messages.length) {
        const summary = !s.context_messages.length && !s.active_stream_id ? index.model : new ApiMessageSummary(s.active_stream_id, !s.context_messages.length)
        if (summary !== index.model && !streaming) { for (const row of s.context_messages.length ? s.context_messages : s.messages) { summary.add(row); if (summary.enough) break } summary.finish() }
        context = { key: contextKey, local: summary.rows, enough: summary.enough, contextRows: s.context_messages, contextLength: s.context_messages.length, marker: summary.marker, unidentified: summary.enough ? [] : summary.unidentified }
        this.pageContexts.set(index, context)
      }
      let stateRows: Message[]
      let effectiveSeenId: number | null = null
      let cacheable = true
      let appended: Message[] | null = null
      // TAL-1162: the transcript reads run on the state.db worker. A session that changed meanwhile no longer matches this
      // index or the lifecycle snapshots: null asks the caller to take them again, and a second change is answered as
      // read, uncached.
      const [localRows, localCount, updatedAt, seenId] = [s.messages, s.messages.length, s.updated_at, s.state_db_seen_id]
      const changed = (): boolean => s.messages !== localRows || s.messages.length !== localCount || s.updated_at !== updatedAt || s.state_db_seen_id !== seenId
      if (typeof seenId === 'number' && !isSubagentView(s)) {
        const read = await this.stateDbTailRead(s, seenId, [...index.unidentified, ...context.unidentified])
        if (changed()) { if (!retried) return null; cacheable = false }
        if (!read.ok) cacheable = false
        const markerRows = read.anchor ? [read.anchor, ...read.rows] : read.rows
        if (read.ok && read.idCapable && currentStateDbSeenId(s, markerRows) !== null) {
          // Covered rows consume unidentified local copies before a new duplicate. Any such match needs the full snapshot.
          const ambiguous = read.requiresFullRead === true
          if (!ambiguous) {
            const includeUids = read.rows.some((m) => stateDbIdentityKeys(m).some((id) => id.startsWith('uid:')))
            const mode = includeUids ? 1 : 0
            appended = appendStateDbIdentityRows(read.rows, seenId, index.identities[mode], index.unidentified[mode], index.generation, includeUids)
            stateRows = read.rows
            effectiveSeenId = seenId
          }
        }
      }
      if (appended === null) {
        stateRows = await this.stateDbRows(s)
        if (changed()) { if (!retried) return null; cacheable = false }
        effectiveSeenId = currentStateDbSeenId(s, stateRows)
        appended = this.mergedTranscript(s, s.messages, stateRows).slice(s.messages.length)
      }
      let tail = [...s.messages.slice(prefixEnd), ...appended]
      if (pending) tail = withPendingUserTurn(tail, { ...pending, localCount: s.messages.length - prefixEnd })
      if (journaled) tail = withoutRunningTurnOutput(tail, { ...journaled, localCount: s.messages.length - prefixEnd })
      const tailIndex = new SessionPrefixIndex(tail, index.revision, index.generation, { toolCalls: index.toolCalls(prefixEnd, tail.length), baseIndex: prefixEnd, initialTurn: prefixEnd ? index.turnId(prefixEnd - 1) : 'legacy:start', timestampFloor: index.summary(prefixEnd).maxTimestamp, todoFloor: index.summary(prefixEnd).maxTodoTimestamp, parent: { index, end: prefixEnd } })
      const enoughContext = !streaming && (context.enough || sanitizeMessagesForApi(context.marker ? context.local : mergeSessionMessagesAppendOnly(context.local, stateRows!, { truncationWatermark: s.truncation_watermark, compressedWatermark: s.truncation_watermark_compressed, stateDbSeenId: effectiveSeenId, stateDbGeneration: index.generation }).filter((m) => !s.active_stream_id || m._turn_id !== s.active_stream_id), { maxMessages: 4 }).length >= 4)
      const owners = new Map<string, Map<string, StateDbSessionSource>>()
      const sources: SessionService['stateDbSources'] = async (ids, profile) => {
        const ownerKey = JSON.stringify([ids, profile])
        const existing = owners.get(ownerKey)
        if (existing) return existing
        const result = await this.stateDbSources(ids, profile)
        if (result) owners.set(ownerKey, result)
        return result
      }
      cached = { key, tail, index: tailIndex, enoughContext, sources, contextRows: s.context_messages, contextLength: s.context_messages.length,
        summary: { total: prefixEnd + tail.length, last: Math.max(index.summary(prefixEnd).maxTimestamp, tailIndex.summary().maxTimestamp), todo: tailIndex.summary().todo ?? index.summary(prefixEnd).todo, compression: index.compressionReference(s, prefixEnd, tailIndex) } }
      if (cacheable) this.pageTails.set(index, cached)
    }
    const { tail, index: tailIndex } = cached
    const total = prefixEnd + tail.length
    const end = before === null ? total : Math.max(0, Math.min(before, total))
    const readRange = (start: number, stop: number) => start >= prefixEnd ? tail.slice(start - prefixEnd, stop - prefixEnd) : [...s.messages.slice(start, Math.min(stop, prefixEnd)), ...(stop > prefixEnd ? tail.slice(0, stop - prefixEnd) : [])]
    const idAt = (at: number) => at < prefixEnd ? index.turnId(at) : tailIndex.turnId(at)
    const turnSpan = (id: string) => {
      const prefix = index.turns.get(id), suffix = tailIndex.turns.get(id)
      return { first: Math.min(prefix && prefix.first < prefixEnd ? prefix.first : total, suffix?.first ?? total), last: Math.max(prefix && prefix.first < prefixEnd ? Math.min(prefix.last, prefixEnd - 1) : -1, suffix?.last ?? -1) + 1 }
    }
    const spanAt = (at: number) => {
      const id = idAt(at), own = turnSpan(id)
      const dependencies = [index.dependencies.get(id), tailIndex.dependencies.get(id)]
      const first = Math.min(...dependencies.map((span) => span?.first ?? total))
      const last = Math.max(...dependencies.map((span) => span ? Math.min(span.last, total - 1) : -1))
      return { first: Math.min(own.first, first), last: Math.max(own.last, last + 1) }
    }
    // A notification can refer to a parent turn outside this page. Read that indexed turn, never the whole prefix.
    const reviewTurns = new Map<string, Message[]>()
    const reviewRows = (id: string): Message[] => {
      let rows = reviewTurns.get(id)
      if (!rows) {
        const span = turnSpan(id)
        rows = span.first < span.last ? withTurnIds(readRange(span.first, span.last), span.first, span.first ? idAt(span.first - 1) : 'legacy:start').filter((row) => row._turn_id === id) : []
        reviewTurns.set(id, rows)
      }
      return rows
    }
    const refs = { get: (ref: string) => index.refCountBefore(ref, prefixEnd) + (tailIndex.refCounts.get(ref) ?? 0) }
    if (cached.newestReply === undefined) {
      let newestReply: number | null = null
      const excluded = new Set(s.active_stream_id ? [s.active_stream_id] : [])
      selection: for (const owner of [tailIndex, index]) for (const candidate of owner.replyTurns(owner === index ? prefixEnd : total, excluded)) {
        const span = turnSpan(idAt(candidate)), rows = readRange(span.first, span.last)
        const derived = await this.deriveRange(s, rows, span.first, span.first ? idAt(span.first - 1) : 'legacy:start', Boolean(journaled), refs, index.toolCalls(span.first, rows.length), reviewRows)
        const newest = newestSettledReply(derived, s.active_stream_id, span.first)
        if (newest !== null) { newestReply = newest; break selection }
      }
      cached.newestReply = newestReply
    }
    let start = end ? spanAt(Math.max(0, end - limit)).first : 0
    if (pending && before === null) start = Math.min(start, prefixEnd)
    let stop = end ? spanAt(end - 1).last : 0
    // Stamped ids can recur non-contiguously. Include every row of a selected turn, as the full derivation does.
    let derived: Message[] = []
    for (;;) {
      for (let at = start; at < stop; at += 1) { const span = spanAt(at); if (span.first < start) { start = span.first; at = start - 1 } stop = Math.max(stop, span.last) }
      const rows = readRange(start, stop)
      const calls = index.toolCalls(start, rows.length)
      derived = (await this.deriveRange(s, rows, start, start ? idAt(start - 1) : 'legacy:start', Boolean(journaled), refs, calls, reviewRows))
      const [page, relative] = messageWindowForDisplay(derived, limit, end - start)
      if (relative > 0 || start === 0 || page.filter((m) => messageCountsAsRenderable(m)).length >= limit) {
        let offset = start + relative
        let messages = page as Message[]
        if (pending && before === null) {
          const at = derived.findIndex((m) => m.role === 'user' && m._active_turn_token === pending.activeTurnToken)
          if (at >= 0 && start + at < offset) { messages = derived.slice(at, relative + messages.length); offset = start + at }
        }
        return { messages, offset, newestReply: cached.newestReply, ...cached.summary, enoughContext: cached.enoughContext, sources: cached.sources }
      }
      start = spanAt(Math.max(0, start - Math.max(limit, stop - start))).first
    }
  }

  /** Python `_handle_session_get` on the WebUI sidecar (state.db merge pending). */
  async detail(sid: string, query: { messages?: string | null | undefined; msg_limit?: string | null | undefined; msg_before?: string | null | undefined; resolve_model?: string | null | undefined }): Promise<Record<string, unknown>> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    sid = await this.resolveSessionId(sid)
    const loadMessages = (query.messages ?? '1') !== '0'
    const msgLimit = parseMsgLimit(query.msg_limit ?? null)
    const msgBeforeRaw = query.msg_before
    const msgBefore = msgBeforeRaw ? (Number.isInteger(Number(msgBeforeRaw)) ? Number(msgBeforeRaw) : null) : null
    let s: Session
    try {
      s = (await this.store.get(sid, { metadataOnly: !loadMessages }))
    } catch {
      return (await this.foreignSessionDetail(sid, loadMessages, msgLimit, msgBefore))
    }
    let revisionBefore = (await this.loadRevision(s))
    if (!this.visibleToActiveProfile(s.profile)) {
      if (s.profile) throw new HttpFailure(409, 'Session belongs to a different profile', { code: 'session_profile_mismatch', session_id: sid, profile: s.profile })
      throw new HttpFailure(404, 'Session not found')
    }
    await this.clearStaleStreamState(s)
    // TAL-1162: the full transcript read runs on the state.db worker before the lifecycle snapshots are taken, so they
    // describe the session the payload is built from.
    const stateRows = loadMessages && msgLimit === null ? await this.stateDbRows(s) : []
    let journaled = loadMessages ? (await this.journaledActiveTurn(s)) : null
    let pending = loadMessages ? this.pendingTurn(s) : null
    let prefix = loadMessages && msgLimit !== null ? this.prefixIndex(s, revisionBefore) : null
    let limited = prefix && msgLimit !== null ? (await this.limitedDetail(s, prefix, msgLimit, msgBefore, pending, journaled)) : null
    if (prefix && msgLimit !== null && !limited) {
      // The session changed during the page's transcript read: every snapshot is taken again, once.
      revisionBefore = await this.loadRevision(s)
      journaled = await this.journaledActiveTurn(s)
      pending = this.pendingTurn(s)
      prefix = this.prefixIndex(s, revisionBefore)
      limited = await this.limitedDetail(s, prefix, msgLimit, msgBefore, pending, journaled, true)
    }
    let transcript = loadMessages && !limited ? this.mergedTranscript(s, s.messages, stateRows) : []
    if (pending && !limited) transcript = withPendingUserTurn(transcript, pending)
    if (journaled && !limited)transcript = withoutRunningTurnOutput(transcript, { ...journaled, localCount: s.messages.length })
    // Turn ids, tool outcomes and scenes are computed over the full transcript, so every window reports the same values.
    const all: unknown[] = loadMessages && !limited ? (await this.backgroundLinked(s, hydrateAnchorActivityScenes(withToolCallOutcomes((await this.backgroundUpdates(s, withMarkerKinds(withTurnIds(withAttachmentObjects(transcript)), s))), s.tool_calls, s.active_stream_id), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, runningScene: !journaled, clipToolResults: msgLimit !== null }))) : []
    let truncated: unknown[] = limited?.messages ?? []
    let offset = limited?.offset ?? 0
    let summaryCount: number | null = limited?.total ?? null
    let summaryLast: number | null = limited?.last ?? null
    if (loadMessages) {
      if (!limited) [truncated, offset] = messageWindowForDisplay(all, msgLimit, msgBefore)
      // TAL-368: a tail window starts no later than the running turn's prompt, so a turn whose output stays in the
      // transcript (no journal to replay it) keeps its prompt; older pages end before it, so it is never sent twice.
      // ponytail: the window grows with that turn's persisted rows; clip the turn instead if degraded runs get long.
      const prompt = pending && msgBefore === null ? all.findIndex((m) => isDict(m) && m.role === 'user' && m._active_turn_token === pending.activeTurnToken) : -1
      if (prompt >= 0 && prompt < offset) {
        truncated = all.slice(prompt, offset + truncated.length)
        offset = prompt
      }
      // Per-row display fields (TAL-186 media, TAL-456 excerpts cut from that display text) only for the rows sent.
      truncated = withBodyExcerpts(withDisplayMedia(truncated, (await this.mediaProjector(s))), s.active_stream_id, limited ? limited.newestReply : newestSettledReply(all, s.active_stream_id), offset)
      if (msgLimit !== null) truncated = messagesForLimitedPayload(truncated)
    } else {
      summaryCount = s.metadataMessageCount ?? s.messages.length
      summaryLast = lastMessageTimestamp(s.messages) ?? 0
    }
    const windowed = loadMessages && msgLimit !== null && (msgBefore !== null || truncated.length < (limited?.total ?? all.length))
    let toolCalls: unknown[] = loadMessages ? s.tool_calls : []
    if (windowed) toolCalls = prefix ? prefix.toolCalls(offset, truncated.length, true) : toolCallsForMessageWindow(toolCalls, offset, truncated.length)
    if (loadMessages && s.active_stream_id && msgBefore === null) toolCalls = [...toolCalls, ...(this.deps.runtime.liveToolProgress?.(s.active_stream_id) ?? [])]
    const mergedCount = summaryCount ?? all.length
    let mergedLast = summaryLast ?? 0
    if (summaryLast === null && all.length) {
      mergedLast = Math.max(...all.map((m) => (isDict(m) ? Number(m.timestamp ?? 0) || 0 : 0)))
    }
    const activeStreamIds = this.deps.runtime.activeStreamIds
    const raw: Record<string, unknown> = {
      ...s.compact({ ...(prefix ? { transcriptSummary: prefix.summary() } : {}), includeRuntime: true, activeStreamIds, contextLengthFor: this.deps.contextLengthFor, modelOptionFor: this.deps.modelOptionFor }),
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
    if (limited) attachTodoSnapshot(raw, limited.todo, s.extra[UNSETTLED_TODO_KEY])
    else if (loadMessages) attachTodoState(raw, all, s.extra[UNSETTLED_TODO_KEY])
    if (loadMessages) raw.compression_reference = limited ? limited.compression : compressionReference(s, all)
    if (mergedLast) {
      raw.last_message_at = Math.max(Number(raw.last_message_at ?? 0) || 0, mergedLast)
      raw.updated_at = Math.max(Number(raw.updated_at ?? 0) || 0, mergedLast)
    }
    const isTruncated = loadMessages && msgLimit !== null && offset > 0
    raw._messages_truncated = isTruncated
    raw._messages_offset = offset
    raw._msg_limit_max = MAX_MSG_LIMIT
    const revisionAfter = (await this.loadRevision(s))
    raw._load_revision = revisionBefore !== null && revisionBefore === revisionAfter ? hashRevision(revisionBefore) : `unstable-${randomUUID().replace(/-/g, '')}`
    Object.assign(raw, (await this.ownerLocked([raw], limited?.sources))[0])
    raw.assistant_name = this.assistantName(s)
    raw.workspace_name = (await this.workspaceNames([s]))(s)
    raw.branched_from = (await this.branchedFrom(s))
    withSessionWireFlags(raw, activeStreamIds)
    // A metadata-only read lacks the history the gate counts, so it carries no flag.
    if (loadMessages) raw.can_compress = limited ? raw.read_only !== true && !isClaudeCodeSessionId(s.session_id) && (!s.active_stream_id || this.compactionWaiters.has(s.active_stream_id)) && limited.enoughContext : this.canCompress(s, raw.read_only === true, stateRows)
    raw.confirms_deep_truncate = true
    raw.pending_steers = raw.active_stream_id ? (this.deps.runtime.pendingSteers?.(str(raw.active_stream_id)) ?? []) : []
    // TAL-1006: the compression a client shows on load: the running manual job's, else the live run's open span.
    const job = this.compressionJobs.get(s.session_id)
    raw.run_status = this.currentRunStatus(s.session_id, str(raw.active_stream_id) || null)
    raw.compression_started_at = job?.status === 'running' ? job.started_at : raw.active_stream_id ? (this.deps.runtime.compressionStartedAt?.(str(raw.active_stream_id)) ?? null) : null
    raw.automatic_turns_held = (await this.deps.runtime.automaticTurnsHeld?.(s.session_id)) ?? false
    raw.notices = this.deps.runtime.sessionNotices?.(s.session_id) ?? []
    raw.goal = this.deps.runtime.sessionGoal?.(s.session_id) ?? null
    const publicRow = redactSessionData(raw, this.deps.redactEnabled())
    return this.owner ? await this.owner.project(publicRow, msgLimit, msgBefore, loadMessages) : publicRow
  }

  /**
   * TAL-454: the chat `/branch` copied, while it still loads (archived included). A compression continuation is also a
   * fork of its parent but not a branch, so it links nowhere.
   */
  private async branchedFrom(s: Session): Promise<{ session_id: string; title: string } | null> {
    const parentId = s.parent_session_id
    if (!parentId || str(s.session_source).trim().toLowerCase() !== 'fork' || s.compression_recovery_source_session_id) return null
    let title: unknown
    try {
      const parent = (await this.store.get(parentId, { metadataOnly: true, promote: false, cacheOnMiss: false }))
      if (!this.visibleToActiveProfile(parent.profile)) return null
      title = parent.title
    } catch {
      // A read-only foreign parent (a cron run) has no sidecar and opens from the active profile's state.db while it
      // has transcript rows and is not a deleted chat (`claimOrSynthesizeCliSession`'s `was_webui` and `no_foreign_state`).
      const dbPath = this.stateDbPath(null)
      const row = await stateDbSessionReadAsync(null, 'stateDbSessionRow', dbPath, parentId)
      if (!row || (await this.store.wasDeleted(parentId)) || (await this.indexMarksWasWebui(parentId))) return null
      if (!(await stateDbSessionReadAsync(false, 'stateDbSessionHasMessages', dbPath, parentId))) return null
      title = row.title
    }
    return { session_id: parentId, title: str(redactText(str(title) || 'Untitled', this.deps.redactEnabled())) }
  }

  /**
   * TAL-316: the active run whose journal can replay its output from the start. The detail then leaves that output to the
   * replay; with no active run, no identifiable prompt, or no complete journal, it returns the persisted transcript unchanged.
   */
  private async journaledActiveTurn(s: Session): Promise<{ turnId: string; startedAt: number; activeTurnToken: string } | null> {
    const turnId = str(s.active_stream_id).trim()
    const activeTurnToken = buildActiveTurnToken(turnId, s.pending_started_at)
    if (!turnId || !activeTurnToken || this.deps.runtime.journalDegraded(turnId)) return null
    const summary = (await this.deps.journal?.findRunSummary(turnId))
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
  private async foreignSession(sid: string): Promise<{ synth: Session; meta: Row | null }> {
    sid = await this.resolveSessionId(sid)
    const meta = (await this.lookupCliMeta(sid))
    const profile = str(meta?.profile) || null
    const profileAgnostic = str(meta?.source_tag || meta?.raw_source).trim().toLowerCase() === 'claude_code'
    if (!profileAgnostic && !this.visibleToActiveProfile(profile)) {
      if (profile) throw new HttpFailure(409, 'Session belongs to a different profile', { code: 'session_profile_mismatch', session_id: sid, profile })
      throw new HttpFailure(404, 'Session not found')
    }
    const { session: synth, reason } = (await this.claimOrSynthesizeCliSession(sid, meta))
    if (!synth || reason === 'was_webui') throw new HttpFailure(404, 'Session not found')
    return { synth, meta }
  }

  /** Python `_handle_session_get` without a sidecar: the state.db transcript as a (read-only or claimable) foreign stub. */
  foreignMessages(messages: Message[], session: object): Message[] {
    return hydrateAnchorActivityScenes(withToolCallOutcomes(withMarkerKinds(withTurnIds(messages), session), [], null), {}) as Message[]
  }

  private async foreignSessionDetail(sid: string, loadMessages: boolean, msgLimit: number | null, msgBefore: number | null): Promise<Record<string, unknown>> {
    const { synth, meta } = (await this.foreignSession(sid))
    // The same turn projection as a WebUI session: turn ids, tool outcomes, then each completed turn's scene.
    const msgs = this.foreignMessages(synth.messages, synth)
    const lastTs = Number(msgs[msgs.length - 1]?.timestamp ?? 0) || 0
    const sess: Record<string, unknown> = {
      session_id: synth.session_id, title: synth.title, workspace: synth.workspace, model: synth.model, message_count: msgs.length,
      created_at: synth.created_at, updated_at: synth.updated_at, last_message_at: meta?.last_message_at || meta?.updated_at || lastTs,
      pinned: synth.pinned, archived: synth.archived, project_id: synth.project_id ?? null, profile: synth.profile,
      is_cli_session: synth.is_cli_session, source_tag: synth.source_tag, raw_source: synth.raw_source, session_source: synth.session_source,
      source_label: synth.source_label, read_only: synth.read_only, can_duplicate: false, messages: msgs, tool_calls: [], transcript_seq: null,
      assistant_name: this.assistantName(synth), workspace_name: (await this.workspaceNames([synth]))(synth), confirms_deep_truncate: true,
    }
    attachTodoState(sess, msgs)
    const merged = withSessionWireFlags((await this.ownerLocked([meta ? mergeCliSidebarMetadata(sess, meta) : sess]))[0]!, this.deps.runtime.activeStreamIds)
    const publicRow = redactSessionData(merged, this.deps.redactEnabled())
    return this.owner ? await this.owner.project(publicRow, msgLimit, msgBefore, loadMessages) : publicRow
  }

  /** Clear persisted streaming flags when no live stream backs them (Python `_clear_stale_stream_state`). */
  async clearStaleStreamState(session: Session): Promise<boolean> {
    const streamId = session.active_stream_id
    if (!streamId) return false
    if (this.deps.runtime.activeStreamIds.has(streamId)) return false
    if (this.deps.runtime.activeRunStream(session.session_id)) return false
    const pendingAge = session.pending_started_at ? this.deps.now() - session.pending_started_at : null
    if (session.hasPendingPrompt && pendingAge !== null && pendingAge < 30) return false
    // Reading a display-only session must not settle the previous Talaria worker's transcript.
    if ((await this.isReadOnly(session))) return false
    let target = session
    if (session.loadedMetadataOnly) {
      const full = (await this.store.load(session.session_id))
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
    const events = (await this.deps.journal?.readRunEventTail(target.session_id, turnId, RECOVERY_JOURNAL_MAX_BYTES, RECOVERY_JOURNAL_MAX_ROWS))?.events ?? []
    const { rows: output, answered } = journalOutputRows(events, turnId)
    const pendingText = str(target.pending_user_message)
    const attachments = [...target.pending_attachments]
    // The run's starting read died with its worker: the state.db rows from before it started stand in for it. Its own
    // rows open with its prompt and run to the next prompt; anything else another client wrote meanwhile stays.
    const read = await this.settlementRead(target)
    const runStart = target.pending_started_at || events[0]?.created_at || this.deps.now()
    const before = read.rows.filter((m) => Number(m.timestamp) < runStart)
    const runRows = read.rows.filter((m) => Number(m.timestamp) >= runStart)
    const ownRows = target.hasPendingPrompt ? runStateDbRows(runRows, pendingText) : null
    // Without this turn's rows: an eager save already put its prompt in the transcript a fresh context falls back to.
    const previousContext = this.modelContext(target, before).filter((m) => m._turn_id !== turnId)
    if (target.hasPendingPrompt) {
      const startedAt = typeof target.pending_started_at === 'number' && target.pending_started_at > 0 ? target.pending_started_at : this.deps.now()
      // An eager save already checkpointed this prompt as the turn's user row.
      if (!target.messages.some((m) => m.role === 'user' && !m._steer && m._turn_id === turnId)) target.messages.push({ role: 'user', content: pendingText, timestamp: Math.trunc(startedAt), ...(attachments.length ? { attachments } : {}), _recovered: true, _source: target.pending_user_source ?? 'webui', _turn_id: turnId })
      // The model context settles as a Stop's does: the Agent's own rows when it committed the prompt, else the prompt it
      // was sent; then the prose that streamed past them.
      const prompt = attachedFilesPrompt(pendingText, attachments)
      const streamed = output.map((m) => str(m.content)).filter(Boolean).join('\n\n')
      target.context_messages = this.unsettledTurnContext({ previousContext, prompt, msgText: pendingText, streamedText: streamed, historyLength: previousContext.length, stateRows: runRows }) ?? dedupeContext([...structuredClone(previousContext), { role: 'user', content: prompt }])
    }
    if (target.hasPendingPrompt || output.length) {
      target.messages.push(...output)
      if (!answered) target.messages.push({ role: 'assistant', content: '**Interrupted:** The reply was interrupted before it could be saved.', _terminal_state: 'interrupted', timestamp: Math.trunc(this.deps.now()), _error: true, _turn_id: turnId })
      // Settled like a turn: the Agent's own rows are covered by the recovered turn; without them, every row past the run's start is.
      this.settleStateDb(target, { turnId, previousContext, agentRows: ownRows, startId: stateDbSeenId(before) ?? (read.idCapable ? 0 : null), read })
    }
    target.active_stream_id = null
    target.pending_user_message = null
    target.pending_attachments = []
    target.pending_started_at = null
    target.pending_user_source = null
    try { (await this.store.save(target, { touchUpdatedAt: false })) } catch { return false }
    if (target !== session) {
      session.active_stream_id = null
      session.pending_user_message = null
      session.pending_attachments = []
      session.pending_started_at = null
      session.pending_user_source = null
      await this.store.touch(target)
    }
    return true
  }

  // ── list / search ────────────────────────────────────────────────────────

  /** Expand saved aliases in one worker query independently of the bounded native sidebar window. */
  private async persistedAliasMetadata(rows: Row[], existing: Row[] = []): Promise<{ rows: Row[]; storage?: AgentStorage }> {
    const profile = this.deps.activeProfile()
    const represented = new Set(existing.flatMap((row) => [...sessionLineageIds(row)]))
    const ids = rows.filter((row) => this.deps.profilesMatch(str(row.profile) || null, profile) && !isClaudeCodeSessionId(str(row.session_id)) && !represented.has(str(row.session_id))).map((row) => str(row.session_id))
    if (!ids.length) return { rows: existing }
    const extra = await this.deps.cliSessions(profile, { sourceFilter: null, sessionIds: ids })
    return { rows: [...new Map([...existing, ...extra.rows].map((row) => [str(row.session_id), row])).values()], storage: extra.storage }
  }

  async list(params: Omit<ListParams, 'activeProfile' | 'isolatedProfileMode' | 'profilesMatch' | 'cliRows' | 'gatewayIdentity' | 'stateDbSources' | 'truncatedSources' | 'agentStorage' | 'pruneOrphanedImports' | 'webuiRows' | 'webDiagnosticIds'>): Promise<{ body: ListResponse; etag: string }> {
    const activeProfile = this.deps.activeProfile()
    const webuiRows = (await allSessions(this.store, { sidebarMetadataOnly: true }))
    const wantState = params.showCliSessions || params.showCronSessions || params.showWebhookSessions || params.showKanbanSessions
    // Python reads every profile's state.db under all_profiles; this port projects the active profile only.
    const cliRead = wantState ? await this.deps.cliSessions(activeProfile, { sourceFilter: params.sourceFilter ?? null }) : undefined
    const claudeCodeRows = params.showCliSessions && params.showClaudeCodeSessions ? (await this.claudeCodeRows()) : []
    let cliRows = cliRead ? [...cliRead.rows, ...claudeCodeRows] : undefined
    let agentStorage = cliRead?.storage
    // TAL-1040: diagnostic chats Web started are Web chats, read even when external Agent sessions are hidden.
    const webDiagnosticIds = new Set(params.sourceFilter ? [] : await stateDbWebDiagnosticIdsAsync(join(this.deps.profileHome(activeProfile), 'state.db')))
    const unread = [...webDiagnosticIds].filter((id) => !cliRows?.some((row) => sessionLineageIds(row).has(id)))
    if (unread.length) {
      const extra = await this.deps.cliSessions(activeProfile, { sourceFilter: null, sessionIds: unread, keepEmpty: true })
      cliRows = [...(cliRows ?? []), ...extra.rows]
      agentStorage ??= extra.storage
    }
    const gatewayIdentity = loadGatewaySessionIdentityMap(join(this.deps.profileHome(activeProfile), 'sessions', 'sessions.json'))
    const truncatedSources = cliRead?.truncated
    if (cliRows) {
      const expanded = await this.persistedAliasMetadata(webuiRows, cliRows)
      cliRows = expanded.rows
      if (expanded.storage && (expanded.storage.state === 'corrupt' || agentStorage?.state === 'ok')) agentStorage = expanded.storage
    }
    const lookups = await withStateDbListingReads(() => this.listStateDbLookups(webuiRows, (cliRows ?? []).map((r) => str(r.session_id))))
    const payload = (await buildSessionListPayload(this.store, { ...params, ...(cliRows ? { cliRows } : {}), ...(truncatedSources ? { truncatedSources } : {}), ...(agentStorage ? { agentStorage } : {}), gatewayIdentity, ...lookups, webuiRows, webDiagnosticIds, activeProfile, isolatedProfileMode: this.deps.isolatedProfileMode(), profilesMatch: this.deps.profilesMatch }))
    return sessionListResponse(payload, this.deps.runtime, this.deps.redactEnabled(), this.deps.now(), await this.workspaceNames([...payload.sessions, ...payload.sidebar_reference_sessions]))
  }

  async search(q: string, opts: { content: boolean; depth: number; allProfiles: boolean }): Promise<Record<string, unknown>> {
    const activeProfile = this.deps.activeProfile()
    let sessions = (await allSessions(this.store))
    if (!opts.allProfiles) sessions = sessions.filter((r) => this.deps.profilesMatch(str(r.profile) || null, activeProfile))
    const metadata = await this.persistedAliasMetadata(sessions)
    sessions = reconcileLocalSessionRows(sessions, metadata.rows, this.deps.profilesMatch)
    sessions = await this.ownerLocked(sessions)
    const redact = this.deps.redactEnabled()
    const workspaceName = await this.workspaceNames(sessions)
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
    const matches = opts.content ? await this.store.searchMessages(sessions.filter((s) => !sessionSearchMatches(str(s.title), terms)).map((s) => str(s.session_id)), terms, opts.depth) : new Map<string, { idx: number; text: string }>()
    const results: Row[] = []
    for (const s of sessions) {
      if (sessionSearchMatches(str(s.title), terms)) { results.push(redactRow({ ...s, match_type: 'title' })); continue }
      const hit = matches.get(str(s.session_id))
      if (hit) results.push(redactRow({ ...s, ...this.contentMatch(hit.text, terms) }))
    }
    return { sessions: results, query, count: results.length, all_profiles: opts.allProfiles, active_profile: activeProfile }
  }

  /**
   * TAL-308: the sidebar search. The candidates are exactly the `/api/sessions` rows for `params` (visibility, source,
   * archived, projection and order), narrowed to `projectId` (`none`: rows without a project), then matched on the
   * title, then the metadata the row shows (workspace path and name, model, provider, profile, source label), then message content.
   */
  async sidebarSearch(q: string, params: Parameters<SessionService['list']>[0], opts: { content: boolean; depth: number; projectId: string | null }): Promise<Record<string, unknown>> {
    let rows = (await this.list(params)).body.sessions
    if (opts.projectId === 'none') rows = rows.filter((r) => !r.project_id)
    else if (opts.projectId) rows = rows.filter((r) => str(r.project_id) === opts.projectId)
    const query = q.toLowerCase().trim()
    const base = { all_profiles: params.allProfiles, active_profile: this.deps.activeProfile(), include_archived: params.includeArchived, sidebar_filtered: true }
    if (!query) return { ...base, sessions: rows }
    const terms = sessionSearchTerms(query)
    const metadataMatch = (row: Row) => ['workspace', 'workspace_name', 'model', 'model_provider', 'profile', 'source_label'].some((k) => sessionSearchMatches(str(row[k]), terms))
    const matches = opts.content ? await this.store.searchMessages(rows.filter((row) => !sessionSearchMatches(str(row.title), terms) && !metadataMatch(row)).map((row) => str(row.session_id)), terms, opts.depth) : new Map<string, { idx: number; text: string }>()
    const results: Row[] = []
    for (const row of rows) {
      if (sessionSearchMatches(str(row.title), terms)) results.push({ ...row, match_type: 'title' })
      else if (metadataMatch(row)) results.push({ ...row, match_type: 'metadata' })
      else {
        const hit = matches.get(str(row.session_id))
        if (hit) results.push({ ...row, ...this.contentMatch(hit.text, terms) })
      }
    }
    return { ...base, sessions: results, query, count: results.length }
  }

  /** The first of a stored session's first `depth` messages (0: all) containing every term, with its redacted excerpt. */
  private contentMatch(text: string, terms: readonly string[]): Row {
    const item: Row = { match_type: 'content' }
    const preview = sessionSearchPreview(text, terms)
    if (preview) item.match_preview = redactText(preview, this.deps.redactEnabled())
    return item
  }

  // ── status / usage ───────────────────────────────────────────────────────

  async status(sid: string): Promise<Record<string, unknown>> {
    const s = (await this.get404(sid, { metadataOnly: true }))
    await this.clearStaleStreamState(s)
    const full = (await this.get404(sid))
    const inp = Math.trunc(full.input_tokens) || 0
    const out = Math.trunc(full.output_tokens) || 0
    const profile = full.profile || 'default'
    let hermesHome = ''
    try { hermesHome = this.deps.workspaces.deps.profileHome(profile) } catch { hermesHome = '' }
    const { is_streaming: streaming, active_stream_id: live, read_only: readOnly, read_only_reason: readOnlyReason, active_turn_origin: origin } = (await this.wireRow(full))
    return {
      session_id: full.session_id, title: full.title, model: full.model, profile, hermes_home: hermesHome, workspace: full.workspace, personality: full.personality,
      message_count: full.messages.length, created_at: full.created_at, updated_at: full.updated_at, agent_running: streaming, is_streaming: streaming, active_stream_id: live, active_turn_origin: origin, read_only: readOnly, read_only_reason: readOnlyReason,
      input_tokens: inp, output_tokens: out, total_tokens: inp + out, estimated_cost: full.estimated_cost,
    }
  }

  async contextDetail(sid: string, expectedKey: string): Promise<ContextDetail> {
    if (await this.owner?.isOwned(sid)) return this.owner!.contextDetail(sid, expectedKey)
    const session = await this.get404(sid)
    const profile = this.deps.activeProfile()
    if (session.profile && session.profile !== profile || await this.loadedReadOnlyReason(session)) return unavailableContextDetail()
    const sidecar = this.deps.sidecar?.()
    if (!sidecar) return unavailableContextDetail()
    // The read owns no cache. Compression and model/workspace replacement invalidate its response.
    const marks = (current = session) => this.contextDetailKey(current)
    const before = marks()
    if (before !== expectedKey) return unavailableContextDetail('changed')
    try {
      const detail = await sidecar.call('chat.context_detail', { session_id: sid, profile_home: this.deps.profileHome(profile), model: session.model, model_provider: session.model_provider, workspace: session.workspace })
      return this.deps.activeProfile() === profile && before === marks(await this.get404(sid)) ? detail : unavailableContextDetail('changed')
    } catch { return unavailableContextDetail() }
  }

  async usage(sid: string): Promise<Record<string, unknown>> {
    const s = (await this.get404(sid))
    const inp = Math.trunc(s.input_tokens) || 0
    const out = Math.trunc(s.output_tokens) || 0
    return { input_tokens: inp, output_tokens: out, total_tokens: inp + out, estimated_cost: s.estimated_cost, model: s.model }
  }

  // ── creation ─────────────────────────────────────────────────────────────

  async resolveNewSessionWorkspace(body: Record<string, unknown>, visiblePrevSessionId: string | null, profile: string | null): Promise<string | null> {
    const candidate = body.workspace
    if (!candidate) return null
    const value = str(candidate)
    if (body.workspace_inherited_from_prev_session !== true || !visiblePrevSessionId) return (await this.deps.workspaces.resolveTrusted(value, profile))
    let previous: Session
    try { previous = (await this.store.get(visiblePrevSessionId, { metadataOnly: true })) } catch { return (await this.deps.workspaces.resolveTrusted(value, profile)) }
    if (previous.workspace !== value) return (await this.deps.workspaces.resolveTrusted(value, profile))
    const [workspace] = (await this.deps.workspaces.resolveImplicitWithRecovery(value, async (p) => (await this.deps.workspaces.profileDefaultWorkspaceForBoot(p)), profile))
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

  async create(body: Record<string, unknown>, opts: { worktree?: { path: string; branch: string; repo_root: string; created_at: number } | null } = {}): Promise<Session> {
    // Python `new_session`: a body without a profile takes the request's active profile (cookie first).
    const profile = (typeof body.profile === 'string' && body.profile) || this.deps.activeProfile()
    let prevSessionId = typeof body.prev_session_id === 'string' && body.prev_session_id ? body.prev_session_id : null
    if (prevSessionId && !(await this.sessionIdVisible(prevSessionId))) prevSessionId = null
    // Python: leaving a session for a new one flushes the previous session's memory in the background (W6).
    if (prevSessionId) await this.deps.commitSessionMemory?.(prevSessionId)
    let workspace: string | null
    try {
      workspace = (await this.resolveNewSessionWorkspace(body, prevSessionId, profile))
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const [model, provider] = this.deps.modelStateFromRequest(body.model, body.model_provider, null)
    const toolsets = this.validateToolsetsShape(body.enabled_toolsets)
    const s = (await this.store.newSession({ workspace, model, modelProvider: provider, profile, projectId: typeof body.project_id === 'string' && body.project_id ? body.project_id : null, worktree: opts.worktree ?? null, enabledToolsets: toolsets }))
    if (opts.worktree) this.publish('session_new', s.profile, s.session_id)
    return s
  }

  /**
   * TAL-1040: an `ignore_config` / `safe` chat starts through the active profile's Agent owner, which freezes the mode before
   * any Agent import. That owner reads no profile default, so the launch route is explicit: the requested model, else this
   * profile's default as a normal chat starts, with that provider's configured endpoint.
   */
  async createDiagnostic(body: Record<string, unknown>, mode: 'ignore_config' | 'safe'): Promise<Record<string, unknown>> {
    const profile = (typeof body.profile === 'string' && body.profile) || this.deps.activeProfile()
    if (profile !== this.deps.activeProfile()) throw new HttpFailure(400, 'A diagnostic chat starts in the active profile')
    if (!this.owner) throw new HttpFailure(409, 'The Agent cannot start a chat in this mode', { code: 'execution_mode_unavailable', reason: 'gateway_unavailable' })
    const defaults = await this.store.deps.defaults(profile)
    let workspace: string | null
    try {
      workspace = await this.resolveNewSessionWorkspace(body, null, profile)
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const [requested, requestedProvider] = this.deps.modelStateFromRequest(body.model, body.model_provider, null)
    const model = requested ?? defaults.model
    const provider = requested ? requestedProvider : requestedProvider ?? defaults.modelProvider ?? null
    if (!model) throw new HttpFailure(400, 'Choose a model before starting a diagnostic chat')
    const toolsets = this.validateToolsetsShape(body.enabled_toolsets)
    const route = provider ? this.deps.profileLaunchRoute?.(profile, provider) ?? { provider, baseUrl: null } : null
    const sid = await this.owner.create(profile, typeof body.request_id === 'string' ? body.request_id : null, { execution_mode: mode, cwd: workspace ?? defaults.workspace, model,
      ...(route ? { provider: route.provider } : {}), ...(route?.baseUrl ? { base_url: route.baseUrl } : {}), ...(toolsets ? { toolsets } : {}) })
    return this.detail(sid, {})
  }

  // ── simple metadata mutations ────────────────────────────────────────────

  /** Python `_persist_generated_session_title`: title + generated/manual flags under the session lock, then insights sync. */
  async persistGeneratedTitle(sid: string, nextTitle: string, eventReason: string): Promise<Session> {
    const title = nextTitle.trim().slice(0, 80) || 'Untitled'
    let current: Session
    try { current = (await this.store.get(sid)) } catch { throw new HttpFailure(404, 'Session not found') }
    if ((await this.isReadOnly(current))) throw new HttpFailure(403, `Session ${sid} is read-only`)
    await this.withMutationLock(sid, async () => {
      current.title = title
      markSessionTitleGenerated(current)
      await this.store.save(current, { touchUpdatedAt: false })
    })
    // An explicit regenerate is user-requested, so state.db takes it over a manual name.
    await this.deps.syncTitle(current, true)
    this.publish(eventReason, current.profile, current.session_id)
    return current
  }

  async rename(sid: string, rawTitle: unknown): Promise<Record<string, unknown>> {
    const reads = this.sessionGateReads(sid)
    const s = (await this.mutationTarget(sid, 'renamed', reads))
    await this.withMutationLock(sid, async () => {
      applySessionTitleRename(s, rawTitle)
      await this.store.save(s)
    })
    await this.deps.syncTitle(s, true)
    this.publish('session_rename', s.profile, s.session_id)
    return { session: (await this.wireRow(s)) }
  }

  // The pin quota is counted across sessions, so the count-and-save transaction runs on one process-wide chain;
  // per-session locks alone would let two pins of different sessions both see the last free slot.
  private pinChain: Promise<unknown> = Promise.resolve()

  pin(sid: string, pinRequested: boolean): Promise<Record<string, unknown>> {
    const run = this.pinChain.then(async () => (await this.pinUnserialized(sid, pinRequested)))
    this.pinChain = run.catch(() => undefined)
    return run
  }

  private async pinUnserialized(sid: string, pinRequested: boolean): Promise<Record<string, unknown>> {
    const reads = this.sessionGateReads(sid)
    await this.rejectViewOnly(sid, 'modified', reads)
    let s = (await this.get404(sid, {}, reads))
    s = (await this.store.ensureFull(sid, s))
    if (pinRequested && !s.pinned) {
      const rows = (await allSessions(this.store))
      const byId = new Map(rows.filter((r) => r.session_id).map((r) => [str(r.session_id), r]))
      byId.set(s.session_id, s.compact())
      const targetLineage = lineageRootId(s.compact(), byId)
      const pinnedLineages = new Set(rows.filter((r) => r.pinned && !r.pre_compression_snapshot).map((r) => lineageRootId(r, byId)))
      pinnedLineages.delete(targetLineage)
      const limit = this.deps.pinnedSessionsLimit()
      if (pinnedLineages.size >= limit) throw new HttpFailure(400, `Up to ${limit} sessions can be pinned. Unpin one before pinning another.`)
    }
    await this.withMutationLock(sid, async () => {
      s.pinned = pinRequested
      await this.store.save(s)
    }, { allowReadOnly: true })
    this.publish('session_pin', s.profile, s.session_id)
    return { ok: true, session: (await this.wireRow(s)) }
  }

  /**
   * TAL-1254: relock the worktrees of every unarchived worktree chat (or just `only`) for the running sidecar, so the
   * Agent's worktree sweep reads them as live, and flag each one git no longer has as retained. Runs before a
   * (re)started sidecar reports ready and when a chat is unarchived. The Agent's sweep runs outside Talaria, so a lock
   * the sidecar could not confirm is retried until git takes it; meanwhile that tree keeps its flag.
   */
  async retainWorktrees(call: SidecarLike['call'], only?: Session): Promise<void> {
    const { rows, unread } = only ? { rows: [only.compact()], unread: 0 } : await this.worktreeSessionRows()
    const targets = rows.filter((row) => !row.archived && typeof row.worktree_path === 'string' && row.worktree_path && typeof row.session_id === 'string')
    if (!targets.length) {
      if (unread) this.retryWorktreeRetention()
      return
    }
    let results: Record<string, string>
    try {
      ({ results } = await call('worktree.retain', { paths: [...new Set(targets.map((row) => String(row.worktree_path)))] }))
    } catch (error) {
      this.retryWorktreeRetention()
      throw error
    }
    const unconfirmed = targets.filter((row) => !results[String(row.worktree_path)]).length + unread
    if (!only && unconfirmed !== this.worktreesUnconfirmed) this.deps.log(`[webui] ${String(unconfirmed)} worktree lock(s) not yet held by the sidecar${unconfirmed ? '; retrying' : ''}`)
    if (!only) this.worktreesUnconfirmed = unconfirmed
    if (unconfirmed) this.retryWorktreeRetention()
    for (const row of targets) {
      const state = results[String(row.worktree_path)]
      const sid = String(row.session_id)
      if (!state) continue
      try {
        // `extra` follows the transcript in the file, past what a metadata-only read sees.
        if (row._unread) continue
        const s = await this.store.ensureFull(sid, await this.store.get(sid, { metadataOnly: true }))
        if ((state === 'missing') === (s.extra[WORKTREE_RETAINED_KEY] === true)) continue
        await this.withMutationLock(sid, async () => {
          s.extra = Object.fromEntries(Object.entries(s.extra).filter(([key]) => key !== WORKTREE_RETAINED_KEY))
          if (state === 'missing') s.extra[WORKTREE_RETAINED_KEY] = true
          await this.store.save(s, { touchUpdatedAt: false })
        }, { allowReadOnly: true })
        this.publish('session_worktree', s.profile, sid)
      } catch (error) {
        if (error instanceof SessionNotFound) continue
        this.deps.log(`[webui] could not record the worktree state of ${sid}: ${(error as Error).message}`)
        this.retryWorktreeRetention()
      }
    }
  }

  /**
   * Every persisted worktree chat, read from its own file: the index only narrows the files to read, since a crash
   * between a save and its index update can leave a session out of the index or with a stale `archived`. A file that
   * cannot be read now, or a session directory that cannot be listed, falls back to the index rows (`_unread`, so their
   * flags are left alone) and counts in `unread`, which keeps retention retrying until every file has been read.
   */
  private async worktreeSessionRows(): Promise<{ rows: Record<string, unknown>[]; unread: number }> {
    let indexed: Map<string, Record<string, unknown>>
    try { indexed = new Map((await this.store.readIndexEntries()).map((row) => [str(row.session_id), row])) } catch { indexed = new Map() }
    let persisted: Set<string>
    try { persisted = await this.store.persistedIds({ strict: true }) } catch {
      // The session directory cannot be listed now: retain what the index names and retry until it can.
      const rows = [...indexed.values()].filter((row) => row.worktree_path).map((row) => ({ ...row, archived: false, _unread: true }))
      return { rows, unread: Math.max(1, rows.length) }
    }
    const candidates = [...persisted].filter((sid) => !indexed.has(sid) || indexed.get(sid)?.worktree_path)
    let unread = 0
    const rows = await Promise.all(candidates.map(async (sid) => {
      try { return (await this.store.get(sid, { metadataOnly: true })).compact() } catch (error) {
        if (error instanceof SessionNotFound) return null
        unread += 1
        const row = indexed.get(sid)
        return row?.worktree_path ? { ...row, archived: false, _unread: true } : null
      }
    }))
    return { rows: rows.filter((row) => row !== null), unread }
  }

  /** One pending retry at a time; a sidecar that is not ready by then retains everything in its next ready gate instead. */
  private retryWorktreeRetention(): void {
    if (this.worktreeRetainRetry) return
    this.worktreeRetainRetry = setTimeout(() => {
      this.worktreeRetainRetry = null
      const sidecar = this.deps.sidecar?.()
      if (sidecar?.status !== 'ready') return
      this.retainWorktrees((method, params, opts) => sidecar.call(method, params, opts)).catch((error: unknown) => { this.deps.log(`[webui] worktree lock retry failed: ${String(error)}`) })
    }, WORKTREE_RETAIN_RETRY_MS)
    this.worktreeRetainRetry.unref()
  }

  async archive(sid: string, archived: boolean): Promise<Record<string, unknown>> {
    const reads = this.sessionGateReads(sid)
    await this.rejectViewOnly(sid, 'archived', reads)
    let s = (await this.get404(sid, {}, reads))
    s = (await this.store.ensureFull(sid, s))
    await this.withMutationLock(sid, async () => {
      s = await this.store.ensureFull(sid, await this.store.get(sid))
      const previous = { archived: s.archived, pinned: s.pinned }
      const wasArchived = (await this.store.loadMetadataOnly(sid))?.archived ?? false
      s.archived = archived
      if (archived) s.pinned = false
      try {
        await this.store.save(s, { touchUpdatedAt: false })
        const saved = await this.store.loadMetadataOnly(sid)
        if (saved?.archived !== archived || saved.pinned !== s.pinned) throw new HttpFailure(409, 'Archive was not saved; reload the chat and retry')
      } catch (error) {
        Object.assign(s, previous)
        throw error
      }
      if (archived && !wasArchived) await this.finalizeSession(sid, s.profile, 'archive', stateDbReadLineage(s) ?? undefined)
    }, { allowReadOnly: true })
    const sidecar = this.deps.sidecar?.()
    if (!archived && sidecar) await this.retainWorktrees((method, params, opts) => sidecar.call(method, params, opts), s).catch(() => undefined)
    this.publish('session_archive', s.profile, s.session_id)
    return { ok: true, session: (await this.wireRow(s)), ...worktreeRetainedPayload(s) }
  }

  async move(sid: string, targetProjectId: string | null): Promise<Record<string, unknown>> {
    const s = (await this.mutationTarget(sid, 'moved'))
    if (targetProjectId) {
      const sessionProfile = s.profile || this.deps.activeProfile()
      const target = (await this.deps.projects.load()).find((p) => p.project_id === targetProjectId)
      if (!target || !this.deps.profilesMatch(target.profile ?? null, sessionProfile)) throw new HttpFailure(404, 'Project not found')
    }
    try {
      await this.withMutationLock(sid, async () => {
        s.project_id = targetProjectId
        await this.store.save(s)
      }, { timeoutMs: 5000 })
    } catch (error) {
      if (error instanceof SessionBusy) throw new HttpFailure(503, 'Session is busy (streaming). Please try again in a moment.')
      throw error
    }
    this.publish('session_move', s.profile, s.session_id)
    return { ok: true, session: (await this.wireRow(s)) }
  }

  private readonly modelConfirmationKey = randomUUID()

  private async confirmModelSwitch(s: Session, model: string, provider: string | null, token: unknown, retry = false): Promise<void> {
    const stateRows = await this.stateDbRows(s)
    const profile = s.profile ?? this.deps.activeProfile()
    const home = this.deps.profileHome(profile)
    const context = contextUsage(s).context_used_tokens
    const messages = this.modelContext(s, stateRows)
    const before = JSON.stringify([s.model, s.model_provider, context, s.context_length, messages])
    let decision: SidecarResult<'models.selection_warnings'>
    try {
      const sidecar = this.deps.sidecar?.()
      if (!sidecar) throw new Error('Agent sidecar is unavailable')
      decision = await sidecar.call('models.selection_warnings', { profile_home: home, session_id: s.session_id, model, provider, current_model: s.model, current_provider: s.model_provider, context_tokens: context, messages })
    } catch (error) {
      throw new HttpFailure(503, `Cannot check model selection warnings: ${(error as Error).message}`)
    }
    const stateRowsAfter = await this.stateDbRows(s)
    if (before !== JSON.stringify([s.model, s.model_provider, contextUsage(s).context_used_tokens, s.context_length, this.modelContext(s, stateRowsAfter)])) {
      if (retry) throw new HttpFailure(503, 'The session changed while checking model warnings. Try the selection again.')
      return this.confirmModelSwitch(s, model, provider, null, true)
    }
    if (!decision.warnings.length) return
    const signature = JSON.stringify([profile, home, s.session_id, s.model, s.model_provider, model, provider, context, s.context_length, messages, decision])
    const confirmToken = createHmac('sha256', this.modelConfirmationKey).update(signature).digest('hex')
    if (token !== confirmToken) throw new HttpFailure(409, decision.warnings.map((w) => w.message).join('\n\n'), { type: 'model_confirmation_required', warnings: decision.warnings, confirm_token: confirmToken })
  }

  async update(sid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let s = (await this.mutationTarget(sid, 'updated'))
    let oldWs = s.workspace
    let newWs = oldWs
    await this.withMutationLock(sid, async () => {
      s = await this.mutationTarget(sid, 'updated')
      oldWs = s.workspace
      try {
        newWs = await this.deps.workspaces.resolveTrusted(typeof body.workspace === 'string' ? body.workspace : s.workspace, s.profile)
      } catch (error) {
        throw new HttpFailure(400, (error as Error).message)
      }
      const oldModel = s.model
      const oldProvider = s.model_provider
      const hasModel = 'model' in body || 'model_provider' in body
      const [model, provider] = hasModel ? this.deps.modelStateFromRequest('model' in body ? body.model : s.model, 'model_provider' in body ? body.model_provider : undefined, s.model_provider) : [s.model, s.model_provider]
      const nextModel = model ?? s.model
      const changed = hasModel && (str(oldModel) !== str(nextModel) || str(oldProvider) !== str(provider))
      const contextLength = changed ? (this.deps.resolveContextLength ? await this.deps.resolveContextLength(nextModel, provider, s.profile) : this.deps.contextLengthFor(nextModel, provider)) : s.context_length
      if (changed) await this.confirmModelSwitch(s, nextModel ?? '', provider, body.confirm_token)
      await this.assertWritable(s)
      s.workspace = newWs
      if (hasModel) {
        s.model = nextModel
        s.model_provider = provider
        if (changed) {
          s.context_length = contextLength
          forgetContextFigures(s)
        }
      }
      if (changed || oldWs !== newWs) await this.deps.runtime.evictAgent(sid)
      await this.store.save(s)
    })
    if (str(oldWs) !== str(newWs)) this.deps.runtime.closeTerminal(sid)
    await this.deps.workspaces.setLastWorkspace(newWs, s.profile)
    return { session: (await this.publicSession(s)) }
  }

  async setToolsets(sid: string, toolsets: unknown): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'modified')
    const cleaned = this.validateToolsetsShape(toolsets)
    const s = (await this.mutationTarget(sid, 'modified'))
    await this.withMutationLock(sid, async () => {
      s.enabled_toolsets = cleaned
      await this.store.save(s)
    })
    return { ok: true, enabled_toolsets: s.enabled_toolsets }
  }

  /** Python `/api/personality/set` persistence: the name only; the prompt is resolved by the caller. */
  async setPersonality(sid: string, name: string | null): Promise<string | null> {
    await this.rejectViewOnly(sid, 'modified')
    const s = (await this.mutationTarget(sid, 'modified'))
    await this.withMutationLock(sid, async () => {
      s.personality = name
      await this.store.save(s)
    })
    return typeof s.personality === 'string' ? s.personality : null
  }

  // ── transcript mutations ─────────────────────────────────────────────────

  /**
   * TAL-929: under a `hold`, a cut that discards more than one user turn changes nothing and answers with its counts,
   * unless `confirmToken` is the token of the rows it would remove now: a transcript that changed since asks again.
   * Without one (a released App, which asked on the device) the cut proceeds as before.
   */
  async truncate(sid: string, keepRaw: unknown, hold: { confirmToken: string | null } | null = null): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'modified')
    if (keepRaw === null || keepRaw === undefined) throw new HttpFailure(400, 'Missing required field(s): keep_count')
    const s = (await this.mutationTarget(sid, 'modified'))
    // Python `int(body["keep_count"])`: a float truncates, a non-integer string is rejected.
    let keep: number
    if (typeof keepRaw === 'number') keep = Number.isFinite(keepRaw) ? Math.trunc(keepRaw) : Number.NaN
    else if (typeof keepRaw === 'boolean') keep = keepRaw ? 1 : 0
    else keep = /^[+-]?\d+$/.test(str(keepRaw).trim()) ? Number.parseInt(str(keepRaw).trim(), 10) : Number.NaN
    if (!Number.isInteger(keep)) throw new HttpFailure(400, 'keep_count must be an integer')
    if (keep < 0) throw new HttpFailure(400, 'keep_count must be non-negative')
    const refused = await this.withMutationLock(sid, async () => {
      // One state.db read decides and marks the boundary, so a row committed meanwhile is neither counted nor hidden.
      const read = await this.stateDbRead(s)
      if (hold) {
        // A failed read cannot say whether a CLI continuation would go too: fail closed. The Agent keeps a state.db for every
        // profile it has run in, so a missing one is never evidence of a session without state.db rows.
        if (!read.ok) throw new HttpFailure(503, read.reason ?? 'The session history could not be read. Please try again in a moment.')
        const held = (await this.heldCut(s, keep, read.rows))
        if (held && held.confirm_token !== hold.confirmToken) return held
      }
      // A cut inside the state.db continuation keeps the continuation's rows before it: the boundary below hides every
      // row this read saw, so those rows join the stored transcript and model history first.
      if (keep > s.messages.length) {
        if (s.context_messages.length) s.context_messages = this.modelContext(s, read.rows)
        s.messages = this.mergedTranscript(s, s.messages, read.rows)
      }
      truncateSessionAtKeep(s, keep)
      this.markStateDbSeen(s, read, { boundary: true })
      await this.store.save(s)
      return null
    })
    if (refused) return refused
    await this.deps.runtime.evictAgent(sid)
    return { ok: true, session: (await this.publicSession(s)) }
  }

  /**
   * TAL-929: the confirmation a cut at `keep` needs, or null for one that removes at most one user turn. Counted on the rows
   * the detail shows, state.db continuation included, since `keep` indexes them: the user turns the cut removes, and the
   * messages after the row it starts at.
   */
  private async heldCut(s: Session, keep: number, stateRows: Message[]): Promise<{ ok: false; confirm_required: true; discard_user_turns: number; discard_messages: number; confirm_token: string } | null> {
    const transcript = this.mergedTranscript(s, s.messages, stateRows)
    const cut = (((await this.publicSession(s, true, transcript)).messages ?? []) as Message[]).map((m, i) => ({ m, i })).filter(({ m, i }) => i >= keep && m._display === 'row')
    const userTurns = cut.filter(({ m }) => m.role === 'user').length
    if (userTurns <= 1) return null
    const token = createHash('sha256').update(JSON.stringify(transcript.slice(keep))).digest('hex').slice(0, 32)
    return { ok: false, confirm_required: true, discard_user_turns: userTurns, discard_messages: cut.filter(({ i }) => i > keep).length, confirm_token: token }
  }

  // ── manual compression (TAL-255) ────────────────────────────────────────

  /**
   * Python `_handle_session_compress_start`: validate, then join the session's running job or start a fresh one (a
   * finished job is replaced). The stale-runtime refusal comes before a job exists; a running job is joined without it.
   */
  async startCompression(sid: string, focusRaw: unknown, opts: { automatic?: boolean } = {}): Promise<CompressionJob> {
    const running = (): CompressionJob | undefined => { const job = this.compressionJobs.get(sid); return job?.status === 'running' ? job : undefined }
    // A running job is joined first: once it has installed its short context, the guards below would refuse a new one.
    const existing = running()
    if (existing) return existing
    const { s } = (await this.compressionTarget(sid))
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
    const job: CompressionJob = { session_id: sid, focus_topic: focusTopic, status: 'running', started_at: now, updated_at: now, turns: new Set(), automatic: opts.automatic === true, done: Promise.resolve() }
    job.done = this.compressSession(job).finally(() => { release?.(); this.compressionJobs.expireLater(job) }).then(
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

  /**
   * TAL-1005: compact the session in its joinable compression job before the next turn reads its history. A running job
   * is always joined; a new one starts when the session is `due` (`compactionDue`, read from the store when omitted).
   * `turn` is the waiting turn's stream: the job leaves its rows alone. `onWait` runs once a job is being waited on; an abort of `signal` (the turn's Stop) ends the wait but not the
   * job. True when the job installed a compressed context. Never throws: a failed job leaves the Agent's own preflight.
   */
  async ensureCompacted(sid: string, opts: { turn?: string; signal?: AbortSignal; onWait?: () => void | Promise<void>; due?: boolean } = {}): Promise<boolean> {
    const { turn, signal } = opts
    if (turn) this.compactionWaiters.add(turn)
    try {
      let job = this.compressionJobs.get(sid)
      if (job?.status !== 'running') job = (opts.due ?? (await this.storedCompactionDue(sid))) ? await this.startCompression(sid, null, { automatic: true }) : undefined
      if (!job || signal?.aborted) return false
      if (turn) job.turns.add(turn)
      await opts.onWait?.()
      const aborted = new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      await Promise.race([job.done, aborted])
      return !signal?.aborted && job.status === 'done'
    } catch (error) {
      this.deps.log(`[webui] compaction before the next turn of ${sid} did not run: ${(error as Error).message}`)
      return false
    } finally {
      if (turn) this.compactionWaiters.delete(turn)
    }
  }

  /**
   * TAL-1005: measure the model context again when it holds a post-compression estimate the rows after it may have
   * outgrown (a waiting turn's prompt, a stopped or failed turn's work). Skipped while a turn owns the session, which
   * settles its own figures, or once the estimate changed meanwhile. True when it stored a new estimate.
   */
  async remeasureContext(sid: string): Promise<boolean> {
    const sidecar = this.deps.sidecar?.()
    let s: Session
    try { s = (await this.store.get(sid)) } catch { return false }
    const before = s.post_compression_context_tokens_estimate
    if (before === null || s.active_stream_id || !sidecar) return false
    let tokens: number
    try { tokens = (await sidecar.call('models.estimate_tokens', { messages: await this.readModelContext(s) })).tokens } catch { return false }
    return this.store.withLock(sid, async () => {
      let live: Session
      try { live = (await this.store.get(sid)) } catch { return false }
      if (live.active_stream_id || live.post_compression_context_tokens_estimate !== before || (await this.isReadOnly(live))) return false
      live.post_compression_context_tokens_estimate = Math.max(1, tokens)
      await this.store.save(live, { touchUpdatedAt: false })
      return true
    })
  }

  private async storedCompactionDue(sid: string): Promise<boolean> {
    try { return this.compactionDue((await this.store.get(sid, { metadataOnly: true }))) } catch { return false }
  }

  /** Whether the session's context (the post-compression estimate, else the last prompt) reached the next turn's threshold. */
  compactionDue(s: Session): boolean {
    const positive = (v: unknown): number | null => { const n = Math.trunc(Number(v ?? 0)); return Number.isFinite(n) && n > 0 ? n : null }
    const used = positive(s.post_compression_context_tokens_estimate) ?? positive(s.last_prompt_tokens)
    const threshold = positive(s.next_turn_threshold_tokens) ?? positive(s.threshold_tokens)
    return used !== null && threshold !== null && used >= threshold
  }

  /** The session a compression may run on now, and the model history it compresses: the context a turn would send, so a
   * repeat compression builds on the previous summary instead of re-reading the whole display transcript. `context` is
   * that history unsanitized and `stateRows` the state.db read it came from. */
  private async compressionTarget(sid: string): Promise<{ s: Session; history: Message[]; context: Message[]; stateRows: Message[] }> {
    await this.rejectViewOnly(sid, 'compressed')
    const s = (await this.mutationTarget(sid, 'compressed'))
    const stateRows = await this.stateDbRows(s)
    const context = this.compressionContext(s, stateRows)
    return { s, history: sanitizeMessagesForApi(context), context, stateRows }
  }

  /**
   * The loaded session's own compression guards: no running turn and enough model history. TAL-1005: a turn waiting on
   * the compression has not read its history yet, so it does not block; the context leaves out its rows, as it does.
   */
  private compressionContext(s: Session, stateRows: Message[]): Message[] {
    const turn = s.active_stream_id
    if (turn && !this.compactionWaiters.has(turn)) throw new HttpFailure(409, 'Session is still streaming; wait for the current turn to finish.')
    const context = this.modelContext(s, stateRows).filter((m) => !turn || m._turn_id !== turn)
    if (sanitizeMessagesForApi(context).length < 4) throw new HttpFailure(400, 'Not enough conversation to compress (need at least 4 messages).')
    return context
  }

  /** TAL-614: whether a manual compression would start now: `compressionTarget`'s gates, with `readOnly` the wire flag. */
  private canCompress(s: Session, readOnly: boolean, stateRows: Message[]): boolean {
    if (readOnly || isClaudeCodeSessionId(s.session_id)) return false
    try {
      this.compressionContext(s, stateRows)
      return true
    } catch (error) {
      if (error instanceof HttpFailure) return false
      throw error
    }
  }

  /** TAL-258: the session's WebUI record (absent for a CLI or gateway session) and the profile whose state.db holds its rows. */
  private async handoffTarget(sid: string): Promise<{ local: Session | null; profile: string; dbPath: string }> {
    sid = sid.trim()
    let local: Session | null = null
    try { local = (await this.store.get(sid)) } catch { /* a foreign session without a WebUI record */ }
    const profile = local?.profile ?? this.deps.activeProfile()
    return { local, profile, dbPath: this.stateDbPath(profile) }
  }

  /** Python `_handle_conversation_rounds` (TAL-258): the session's rounds and whether the handoff dock is due. */
  async conversationRounds(sid: string, since: number | null): Promise<{ ok: true; rounds: number; threshold: number; should_show: boolean }> {
    const rounds = await stateDbSessionReadAsync(0, 'countConversationRounds', (await this.handoffTarget(sid)).dbPath, sid, since)
    return { ok: true, rounds, threshold: CONVERSATION_ROUND_THRESHOLD, should_show: rounds >= CONVERSATION_ROUND_THRESHOLD }
  }

  /**
   * Python `_handle_handoff_summary` (TAL-258): the session's main model summarizes its last 50 state.db messages after
   * `since`, and the summary is appended as a display-only `handoff_summary` tool row. A failed or cut-off answer falls
   * back to a deterministic local summary rather than an error.
   */
  async handoffSummary(sid: string, since: number | null): Promise<{ ok: true; summary: string; message_count: number; rounds: number; fallback: boolean; warning?: string }> {
    const reads = this.sessionGateReads(sid.trim())
    sid = (await this.rejectViewOnly(sid, 'summarized', reads))
    const { local, profile, dbPath } = (await this.handoffTarget(sid))
    const rounds = await stateDbSessionReadAsync(0, 'countConversationRounds', dbPath, sid, since)
    if (rounds < CONVERSATION_ROUND_THRESHOLD) throw new HttpFailure(400, 'Not enough conversation rounds to generate a summary.')
    // A running turn settles the transcript it started from, which would drop a card appended meanwhile.
    if (local?.active_stream_id) throw new HttpFailure(409, 'Session is still streaming; wait for the current turn to finish.')
    const all = await stateDbSessionReadAsync([], 'stateDbSessionMessages', dbPath, sid, { stitch: true })
    const messages = (since === null ? all : all.filter((m) => { const ts = stateDbTimestampSeconds(m.timestamp); return ts !== null && ts > since })).slice(-50)
    if (messages.length < 2) throw new HttpFailure(400, 'Not enough messages to summarize.')
    const sidecar = this.deps.sidecar?.() ?? null
    await ensureAgentRuntimeCurrent(sidecar)
    const meta = local ? null : (await reads.meta())
    const generated = await this.generateHandoffSummary(sidecar, profile, local, meta, messages, [...all, ...(local?.messages ?? []), ...(local?.context_messages ?? [])])
    const pick = (row: Record<string, unknown> | null, ...keys: string[]): string => { for (const key of keys) { const v = str(row?.[key]).trim(); if (v) return v } return '' }
    // Python `get_cli_sessions` never listed WebUI's own state.db rows, so they name no channel.
    const cliRow = meta ?? (await reads.meta())
    const channel = pick(local as unknown as Record<string, unknown> | null, 'source_label', 'raw_source', 'source_tag', 'session_source') || (str(cliRow?.raw_source || cliRow?.source).trim().toLowerCase() === 'webui' ? '' : pick(cliRow, 'source_label', 'raw_source', 'source_tag', 'source')) || null
    await this.persistHandoffMarker(sid, profile, handoffMarker(sid, generated.summary, channel, rounds, generated.fallback, this.deps.now()))
    return { ok: true, summary: generated.summary, message_count: messages.length, rounds, fallback: generated.fallback, ...(generated.warning ? { warning: generated.warning } : {}) }
  }

  /** The main model's summary at 700 tokens, once more at 1400 when it was cut off, else the local fallback. */
  private async generateHandoffSummary(sidecar: SidecarLike | null, profile: string, local: Session | null, meta: Row | null, messages: Message[], source: Message[]): Promise<{ summary: string; fallback: boolean; warning?: string }> {
    const fallback = (warning?: string) => ({ summary: fallbackHandoffSummary(messages), fallback: true, ...(warning ? { warning: `Summary generation used local fallback: ${warning}` } : {}) })
    if (!sidecar) return fallback('the Agent sidecar is not running')
    const [model, provider] = local ? this.deps.modelStateFromRequest(local.model, local.model_provider, local.model_provider) : [str(meta?.model).trim() || null, null]
    const prompt = withDataUseRequirements([{ role: 'system', content: HANDOFF_SYSTEM_PROMPT }, { role: 'user', content: `Conversation transcript:\n${handoffTranscript(messages)}` }], source)
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
      await this.rejectViewOnly(sid, 'summarized')
      if (sameHandoff(handoffPayload(await stateDbSessionReadAsync(null, 'stateDbTailToolContent', this.stateDbPath(profile), sid)), card)) return true
      const sidecar = this.deps.sidecar?.()
      if (!sidecar) return false
      try {
        return (await sidecar.call('state_db.append_message', { profile_home: this.deps.profileHome(profile), session_id: sid, role: 'tool', content: str(marker.content), tool_name: 'handoff_summary', timestamp: Number(marker.timestamp) })).ok
      } catch {
        return false
      }
    }
    await this.withMutationLock(sid, async () => {
      let live: Session | null = null
      try { live = (await this.store.get(sid)) } catch { /* no WebUI record */ }
      // A turn that started while the summary was generated would drop the card when it settles.
      if (live?.active_stream_id) throw new HttpFailure(409, 'Session is still streaming; wait for the current turn to finish.')
      const toLocal = async (): Promise<boolean> => {
        await this.rejectViewOnly(sid, 'summarized')
        if (!live) return false
        if (sameHandoff(messageHandoffPayload(live.messages.at(-1)), card)) return true
        live.messages.push(marker)
        await this.store.save(live)
        return true
      }
      const messaging = (await this.isMessagingSession(sid))
      const saved = messaging ? [await toStateDb(), (await toLocal())].some(Boolean) : (await toLocal()) || await toStateDb()
      // The caller may switch away on success, so a card saved nowhere is an error, not a summary.
      if (!saved) throw new HttpFailure(503, 'The handoff summary could not be saved; please retry.')
    }, { allowReadOnly: true })
  }

  /** The same live presentation for session detail and journal snapshot recovery. */
  currentRunStatus(sid: string, streamId: string | null): RunStatus | null {
    const job = this.compressionJobs.get(sid)
    return job?.status === 'running' ? { phase: 'compressing' } : streamId ? (this.deps.runtime.runStatus?.(streamId) ?? null) : null
  }

  /** The session's compression job; a deleted session's finished result is dropped rather than served. */
  async compressionJob(sid: string): Promise<CompressionJob | undefined> {
    try { (await this.store.get(sid, { metadataOnly: true })) } catch { this.compressionJobs.delete(sid); throw new HttpFailure(404, 'Session not found') }
    return this.compressionJobs.get(sid)
  }

  /**
   * Python `_handle_session_compress`: compress the sanitized transcript in the sidecar outside the lock, then under the
   * session lock refuse a result the session moved past (another stream, or a transcript changed) and install it as the
   * model context with the manual anchor and the #4836 boundary that keeps state.db from replaying compressed rows.
   * The guards run again first: a stream may have started while the caller awaited the runtime check. TAL-1005: rows
   * the job's waiting turns added meanwhile (a prompt, a Stop) stay after the compressed context.
   */
  private async compressSession(job: CompressionJob): Promise<Record<string, unknown>> {
    const { session_id: sid, focus_topic: focusTopic } = job
    const { s, history, context, stateRows: seenRows } = (await this.compressionTarget(sid))
    const ownRows = (m: Message): boolean => !s.active_stream_id || m._turn_id !== s.active_stream_id
    // The display transcript and the model context must both still start where the compression found them, followed
    // only by the waiting turns' rows; the context is the exact history sent, so a state.db row that lands after this
    // read fails the commit instead of being dropped.
    // A turn still waiting to join (it started its own start meanwhile) joins this job, so it counts as one of its turns.
    const waited = (id: unknown): boolean => job.turns.has(str(id)) || this.compactionWaiters.has(str(id))
    const sameRows = (a: Message[], b: Message[]): boolean => JSON.stringify(a) === JSON.stringify(b)
    const turnTail = (rows: Message[], base: Message[]): Message[] | null => (sameRows(rows.slice(0, base.length), base) && rows.slice(base.length).every((m) => waited(m._turn_id)) ? rows.slice(base.length) : null)
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
    let keptTurnRows = false
    try {
      const current = await this.withMutationLock(sid, async () => {
        let live: Session
        try { live = (await this.store.get(sid)) } catch { throw new HttpFailure(404, 'Session not found') }
        // One state.db read serves the check, the kept display rows, and the boundary; every gate below decides after it.
        const read = await this.stateDbRead(live)
        const turn = live.active_stream_id
        if (turn && !waited(turn)) throw new HttpFailure(409, 'Session stream state changed during compression; please retry.')
        const stateRows = read.rows
        const tail = turnTail(this.modelContext(live, stateRows).filter((m) => !turn || m._turn_id !== turn), context)
        if (!tail || !turnTail(live.messages, s.messages)) throw new HttpFailure(409, 'Session was modified during compression; please retry.')
        // Rows the sidecar returns without a timestamp take the newest one this compression saw, never the clock: the
        // boundary then hides no state.db row the append-only merge would still show (it already drops rows at or
        // before the newest local row), so a CLI row committed after the read follows the compressed context.
        const seen = [...s.messages, ...s.context_messages, ...seenRows].filter(ownRows).map((m) => Number(m.timestamp)).filter(Number.isFinite)
        const stamp = seen.length ? Math.max(...seen) : this.deps.now()
        const compressed = copyJson(result.messages) as Message[]
        for (const m of compressed) m.timestamp ??= stamp
        live.context_messages = [...compressed, ...copyJson(tail)]
        keptTurnRows = tail.length > 0
        if (!turn) {
          live.pending_user_message = null
          live.pending_attachments = []
          live.pending_started_at = null
          live.pending_user_source = null
        }
        // The compressed history included any state.db-only continuation; the new boundary would hide those rows from
        // the display, so the transcript keeps them before it is applied (and the anchor counts them).
        const display = this.mergedTranscript(live, live.messages, stateRows)
        if (display.length > live.messages.length) live.messages = copyJson(display)
        // The anchor is the newest row the compression covered: never a waiting turn's own.
        const visible = visibleMessagesForAnchor(live.messages)
        const anchor = visible.findLast((m) => !waited(m._turn_id))
        live.compression_anchor_visible_idx = anchor ? visible.lastIndexOf(anchor) : null
        live.compression_anchor_message_key = anchorMessageKey(anchor)
        live.compression_anchor_summary = anchorSummary(summary, compressed)
        live.compression_anchor_mode = 'manual'
        // #4836: an intentional-shrink boundary, so append-only state.db reconciliation does not replay compressed rows.
        live.truncation_watermark = truncationWatermarkFor(compressed)
        live.truncation_boundary = live.truncation_watermark
        live.truncation_watermark_compressed = true
        this.markStateDbSeen(live, read, { boundary: true })
        live.last_prompt_tokens = result.after_tokens
        live.post_compression_context_tokens_estimate = result.after_tokens
        // An automatic job is maintenance, not activity: it leaves the session's place in the list alone.
        await this.store.save(live, { touchUpdatedAt: !job.automatic })
        // A backup from before the compression would restore the uncompressed context.
        try { await this.store.shrinkBackup.discard(sid) } catch { /* ignore */ }
        return live
      })
      committed = true
      // The estimate covers the compressed rows only; a stopped turn's kept prompt is measured with them (a waiting turn
      // settles its own figures instead).
      if (keptTurnRows) await this.remeasureContext(sid)
      // Open chats refetch the session for its new context figures; the list order stays (no recency change).
      this.publish('session_compress', current.profile, sid)
      // The cached turn agent still carries the uncompressed state; the next turn builds a fresh one (gateway parity).
      // Awaited, so a turn sent right after the reply cannot reuse the old agent.
      try { await sidecar.call('chat.evict_agent', { session_id: sid }) } catch (error) { this.deps.log(`[webui] agent eviction after compression of ${sid} failed: ${(error as Error).message}`) }
      return { ok: true, session: (await this.publicSession(current)), summary, focus_topic: focusTopic }
    } finally {
      // Second phase: the Agent's context-engine notification fires only for a result the session now holds.
      if (result.commit_token) {
        const readOnly = committed ? (await this.readOnlyReason(s)) : null
        if (readOnly) committed = false
        try { await sidecar.call('chat.compress_finalize', { commit_token: result.commit_token, committed }) } catch (error) { this.deps.log(`[webui] compression finalize for ${sid} failed: ${(error as Error).message}`) }
        if (readOnly) throw new HttpFailure(403, readOnly)
      }
    }
  }

  /** Profile-scoped, best-effort lifecycle delivery; archive only notifies plugins. */
  private async finalizeSession(sid: string, profile: string | null, reason: 'clear' | 'delete' | 'archive', lineage?: string[]): Promise<string[]> {
    const sidecar = this.deps.sidecar?.()
    if (!sidecar || this.deps.profileDeleting?.(profile)) return []
    const release = this.deps.profileActivity?.(profile)
    try {
      return (await sidecar.call('chat.finalize_session', {
        session_id: sid, profile_home: this.deps.profileHome(profile ?? this.deps.activeProfile()), reason,
        ...(lineage ? { lineage } : {}),
      }, { timeoutMs: 12_000 })).messages
    } catch {
      this.deps.log(`[webui] session lifecycle (${reason}) failed`)
      return []
    } finally { release?.() }
  }

  async clear(sid: string): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'modified')
    const s = (await this.mutationTarget(sid, 'modified'))
    await this.withMutationLock(sid, async () => {
      const messages = await this.finalizeSession(sid, s.profile, 'clear')
      // The boundary covers every row this read saw, the session's finalization rows included.
      const read = await this.stateDbRead(s)
      const hadMessages = s.messages.length > 0
      truncateSessionAtKeep(s, 0)
      s.messages = messages.map((content) => ({ role: 'local_notice', content, _notice_kind: 'session_finalize', timestamp: this.deps.now() }))
      s.tool_calls = []
      if (s.parent_session_id) {
        let parentIsSnapshot = false
        try { parentIsSnapshot = (await this.store.get(s.parent_session_id, { metadataOnly: true })).pre_compression_snapshot } catch { parentIsSnapshot = false }
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
      this.markStateDbSeen(s, read, { boundary: true })
      await this.store.save(s)
      if (hadMessages) { try { await this.store.shrinkBackup.discard(sid) } catch { /* ignore */ } }
    })
    await this.deps.runtime.evictAgent(sid, true)
    return { ok: true, session: (await this.wireRow(s)) }
  }

  async retry(sid: string): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'modified')
    return this.withMutationLock(sid, async () => {
      const s = (await this.mutationTarget(sid, 'modified'))
      const read = await this.stateDbRead(s)
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
      this.markStateDbSeen(s, read, { boundary: true })
      await this.store.save(s)
      return { ok: true, last_user_text: lastUserText, last_user_prompt: lastUserPrompt, last_user_attachments: lastUserAttachments, removed_count: removed }
    })
  }

  async undo(sid: string): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'modified')
    return this.withMutationLock(sid, async () => {
      const s = (await this.mutationTarget(sid, 'modified'))
      const read = await this.stateDbRead(s)
      const history = s.messages
      const lastUser = findLastUserIndex(history)
      if (lastUser === null) return { error: 'Nothing to undo.' }
      const removedText = extractText(history[lastUser]?.content)
      const removed = history.length - lastUser
      shrinkTo(s, lastUser)
      this.markStateDbSeen(s, read, { boundary: true })
      await this.store.save(s)
      const preview = removedText.length > 40 ? `${removedText.slice(0, 40)}...` : removedText
      return { ok: true, removed_count: removed, removed_preview: preview }
    })
  }

  async duplicate(sid: string): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'duplicated')
    const session = (await this.store.load(sid))
    if (!session) throw new HttpFailure(404, 'Session not found')
    const now = this.deps.now()
    // A truncation cut names deleted state.db rows of the source; the copy's own state.db rows are all genuine (TAL-504).
    const watermark = session.truncation_watermark_compressed ? { truncation_watermark: session.truncation_watermark, truncation_boundary: session.truncation_boundary, truncation_watermark_compressed: true } : {}
    const copied = new Session(
      {
        title: `${session.title || 'Untitled'} (copy)`, workspace: session.workspace, model: session.model, model_provider: session.model_provider,
        messages: withMirrorSources(copyJson(session.messages), session), tool_calls: copyJson(session.tool_calls), pinned: false, archived: false, project_id: session.project_id, profile: session.profile,
        input_tokens: session.input_tokens, output_tokens: session.output_tokens, estimated_cost: session.estimated_cost, cache_read_tokens: session.cache_read_tokens, cache_write_tokens: session.cache_write_tokens,
        personality: session.personality, enabled_toolsets: session.enabled_toolsets, context_length: session.context_length, threshold_tokens: session.threshold_tokens,
        ...watermark, context_messages: copyJson(session.context_messages),
        gateway_routing: copyJson(session.gateway_routing), gateway_routing_history: copyJson(session.gateway_routing_history), llm_title_generated: session.llm_title_generated,
        manual_title: session.manual_title, composer_draft: copyJson(session.composer_draft), context_engine: session.context_engine, context_engine_state: copyJson(session.context_engine_state),
        created_at: now, updated_at: now,
      },
      { workspace: session.workspace, model: session.model },
    )
    await this.store.touch(copied)
    await this.store.save(copied)
    this.publish('session_duplicate', copied.profile, copied.session_id)
    return { session: (await this.publicSession(copied)) }
  }

  async branch(sid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.rejectViewOnly(sid, 'branched')
    const source = (await this.get404(sid))
    if ((await this.isReadOnly(source))) {
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
    if (!source.branchSourceReadonly) { try { (await this.store.save(source)) } catch { /* ignore */ } }
    // Python: `keep_count` indexes the merged display transcript, never the raw sidecar array.
    const stateRows = await this.stateDbRows(source)
    const sourceMessages = this.mergedTranscript(source, source.messages, stateRows)
    const forked = keepCount !== null ? sourceMessages.slice(0, keepCount) : [...sourceMessages]
    const title = customTitle ?? `${source.title || 'Untitled'} (fork)`
    const forkKeep = keepCount ?? sourceMessages.length
    // The branch's model context must carry the retained state.db rows too: the new id has no state.db rows of its
    // own, and the runner prefers a non-empty context over the displayed messages.
    const sourceContext = stateRows.length ? this.mergedTranscript(source, source.context_messages.length ? source.context_messages : source.messages, stateRows) : source.context_messages
    const forkedContext = copyJson(truncateContextForDisplayKeep(sourceContext, sourceMessages, forkKeep))
    const branch = new Session(
      {
        workspace: source.workspace, model: source.model, model_provider: source.model_provider, profile: source.profile, title, messages: withMirrorSources(forked, source), project_id: source.project_id,
        personality: source.personality, enabled_toolsets: source.enabled_toolsets, context_length: source.context_length, threshold_tokens: source.threshold_tokens,
        context_messages: forkedContext, gateway_routing: copyJson(source.gateway_routing), context_engine: source.context_engine, context_engine_state: copyJson(source.context_engine_state),
        parent_session_id: source.session_id, session_source: 'fork',
      },
      { workspace: source.workspace, model: source.model },
    )
    await this.store.touch(branch)
    if (forked.length) {
      await this.store.save(branch)
      this.publish('session_branch', branch.profile, branch.session_id)
    }
    return { session_id: branch.session_id, title, parent_session_id: source.session_id }
  }

  /** Python `read_session_lineage_report` on the active profile's state.db. */
  lineageReport(sid: string): Promise<Record<string, unknown>> {
    return stateDbSessionReadAsync(emptyLineageReport(sid.trim()), 'stateDbLineageReport', this.stateDbPath(null), sid)
  }

  /** TAL-259: recovery reads the active profile's state.db, and a recovered sidecar joins that profile. */
  private async recoveryDeps(): Promise<RecoveryDeps> {
    return { store: this.store, stateDbPath: this.stateDbPath(null), profile: this.deps.activeProfile(), stampingSince: await this.deps.recoveryStampingSince(), isReadOnly: async (sid, profile) => Boolean((await this.ownerLocked([{ session_id: sid, profile }]))[0]?.read_only), log: this.deps.log }
  }

  async recoveryAudit(): Promise<RecoveryAudit> {
    return (await auditSessionRecovery(await this.recoveryDeps()))
  }

  async recoveryRepairSafe(): Promise<RecoveryRepair> {
    return repairSafeSessionRecovery(await this.recoveryDeps())
  }

  /**
   * Python `_handle_session_compression_recovery_start`: open a compression-exhausted session's focused continuation, an
   * empty fork keeping its workspace, model, profile, toolsets and worktree. A retry opens the oldest continuation
   * already started from it in the same profile; the source's lock makes concurrent starts converge on one child.
   */
  async compressionRecoveryStart(sid: string): Promise<Record<string, unknown>> {
    if ((await this.isSubagentViewOnly(sid))) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot start compression recovery from WebUI')
    const action = COMPRESSION_RECOVERY_ACTION_START_FOCUSED
    let created = false
    const child = await this.withMutationLock(sid, async () => {
      // Validated under the lock: a delete that won it leaves no source to fork.
      const source = (await this.store.get(sid))
      if (!this.visibleToActiveProfile(source.profile)) throw new HttpFailure(404, 'Session not found')
      if (!compressionRecoveryPayload(source)) throw new HttpFailure(409, 'Session does not have a compression recovery action.')
      const existing = (await this.compressionRecoveryChild(sid, action, source.profile))
      if (existing) return existing
      const base = (source.title || 'Untitled').trim() || 'Untitled'
      const fresh = new Session(
        {
          title: base.endsWith(' (focused continuation)') ? base : `${base} (focused continuation)`, workspace: source.workspace, model: source.model, model_provider: source.model_provider,
          project_id: source.project_id, profile: source.profile, session_source: 'fork', personality: source.personality, enabled_toolsets: copyJson(source.enabled_toolsets),
          context_length: source.context_length, threshold_tokens: source.threshold_tokens, gateway_routing: copyJson(source.gateway_routing), gateway_routing_history: copyJson(source.gateway_routing_history),
          parent_session_id: source.session_id, worktree_path: source.worktree_path, worktree_branch: source.worktree_branch, worktree_repo_root: source.worktree_repo_root, worktree_created_at: source.worktree_created_at,
          ...(source.extra[WORKTREE_RETAINED_KEY] === true ? { [WORKTREE_RETAINED_KEY]: true } : {}),
          compression_recovery_source_session_id: sid, compression_recovery_action: action,
          // An empty model-facing transcript: the focused follow-up must not replay the exhausted context.
          messages: [], context_messages: [], composer_draft: { text: '', files: [] },
        },
        { workspace: source.workspace, model: source.model },
      )
      try {
        await this.store.save(fresh)
      } catch (error) {
        throw new HttpFailure(500, `Failed to start compression recovery: ${sanitizePaths(error)}`)
      }
      await this.store.touch(fresh)
      created = true
      return fresh
    }, { allowReadOnly: true })
    if (created) this.publish('session_compression_recovery', child.profile, child.session_id)
    return {
      ok: true, session: (await this.publicSession(child)), source_session_id: sid, recommended_recovery_action: action,
      message: created ? 'Started a focused continuation. Describe the next narrow task to continue.' : 'Opened the existing focused continuation for this exhausted session.',
    }
  }

  /** Python `find_compression_recovery_session`: the oldest same-profile continuation started from `sid`, cached or persisted. */
  private async compressionRecoveryChild(sid: string, action: string, profile: string | null): Promise<Session | null> {
    const matches = (s: Session): boolean => s.compression_recovery_source_session_id === sid && s.compression_recovery_action === action && this.deps.profilesMatch(s.profile, profile)
    const found = new Map<string, Session>()
    for (const s of this.store.sessions.values()) if (matches(s)) found.set(s.session_id, s)
    for (const id of (await this.store.persistedIds())) {
      if (found.has(id) || this.store.sessions.has(id)) continue
      try {
        const meta = (await this.store.get(id, { metadataOnly: true, promote: false, cacheOnMiss: false }))
        if (matches(meta)) found.set(id, meta)
      } catch { /* unreadable: not a match */ }
    }
    const [oldest] = [...found.values()].sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || (a.updated_at || 0) - (b.updated_at || 0) || (a.session_id < b.session_id ? -1 : 1))
    return oldest ? (await this.store.get(oldest.session_id)) : null
  }

  /** The run that keeps `delete` answering 409, if any; stream status reports it so a draining client can wait on it (TAL-622). */
  async activeRunBlocking(sid: string): Promise<string | null> {
    const live = this.deps.runtime.activeRunStream(sid)
    if (live) return live
    try {
      const candidate = str((await this.store.get(sid, { metadataOnly: true, promote: false, cacheOnMiss: false })).active_stream_id).trim()
      if (candidate && this.deps.runtime.activeStreamIds.has(candidate)) return candidate
    } catch { /* absent */ }
    return null
  }

  async delete(sid: string): Promise<Record<string, unknown>> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    if (!isSafeSessionId(sid)) throw new HttpFailure(400, 'Invalid session_id')
    const reads = this.sessionGateReads(sid)
    await this.rejectViewOnly(sid, 'deleted', reads)
    // Python: a read-only import (persisted sidecar flag, sidebar metadata, or a foreign state.db owner such as a
    // Claude Code session) is never deleted — that would erase the owner's authoritative transcript. An orphan has none.
    const orphaned = (await this.isOrphanedImport(sid, reads))
    if (!orphaned && (await this.isReadOnlyImport(sid, reads))) throw new HttpFailure(400, 'Read-only imported sessions cannot be deleted from WebUI')
    if ((await this.isSubagentViewOnly(sid, reads))) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot be deleted from WebUI')
    const retained = (await (async () => { try { return worktreeRetainedPayload((await this.store.get(sid, { metadataOnly: true }))) } catch { return {} } })())
    let eventProfile: string | null = null
    try { eventProfile = (await this.store.get(sid, { metadataOnly: true })).profile } catch { eventProfile = null }
    // Python `_is_messaging_session_id`: decided before the JSON is gone, from WebUI metadata or the Agent's row.
    const isMessaging = (await this.isMessagingSession(sid, reads))
    const knownIds = !isMessaging && !orphaned ? await stateDbSessionReadAsync([sid], 'stateDbCompressionLineage', this.stateDbPath(eventProfile), sid) : [sid]
    const assertIdle = async () => { for (const id of knownIds) if (await this.activeRunBlocking(id)) throw new HttpFailure(409, 'Session has an active run; stop it before deleting') }
    await assertIdle()
    let stateDbCleanupFailed = false
    let removedIds = [sid]
    try {
      await this.withMutationLock(sid, async () => {
        await assertIdle()
        // TAL-792: state.db goes first, so another Agent process running or compressing the session refuses the delete
        // before anything of Talaria's is removed. Python: the Agent/CLI transcript goes too (else a claimable CLI row
        // resurfaces in the sidebar), but a messaging channel's memory is never erased from the WebUI.
        if (!isMessaging && !orphaned) {
          const result = await this.deleteStateDbRows(eventProfile, sid)
          stateDbCleanupFailed = !result.ok
          removedIds = [...new Set([sid, ...(result.deleted_ids ?? (result.ok ? knownIds : []))])]
        }
        if (removedIds.some((id) => !isSafeSessionId(id))) throw new HttpFailure(503, 'Session cleanup could not finish because the Agent returned invalid session IDs.')
        removedIds = (await filterAsync(removedIds, async (id) => {
          try { return this.deps.profilesMatch((await this.store.get(id, { metadataOnly: true })).profile, eventProfile ?? this.deps.activeProfile()) } catch { return true }
        }))
        for (const id of removedIds) {
          // Revoke before removing each persisted alias; UI cleanup follows the Agent's committed target set.
          try {
            const session = (await this.store.get(id, { metadataOnly: true }))
            if (!Object.keys(retained).length) Object.assign(retained, worktreeRetainedPayload(session))
            await this.deps.shares.revoke(session)
            await this.deps.clearRelayCompletions?.(id, session.profile)
          } catch (error) { if (!(error instanceof SessionNotFound)) throw error }
          const finalize = id === sid && !(await this.store.wasDeleted(id))
          if (!(await this.store.delete(id))) throw new HttpFailure(500, 'Failed to delete session data')
          if (finalize) await this.finalizeSession(sid, eventProfile, 'delete')
        }
      }, { timeoutMs: 5000, allowReadOnly: orphaned })
    } catch (error) {
      if (error instanceof SessionBusy) throw new HttpFailure(503, 'Session busy, try again')
      throw error
    }
    for (const id of removedIds) {
      await this.deps.runtime.evictAgent(id, true)
      try { rmSync(this.deps.attachmentDir(id), { recursive: true, force: true }) } catch { /* ignore */ }
      // Python `delete_run_journal` (#3802): a deleted session leaves no replayable run journal behind.
      try { (await this.deps.journal?.deleteSession(id)) } catch { /* ignore */ }
      this.deps.runtime.closeTerminal(id)
    }
    this.publish('session_delete', eventProfile)
    return { ok: true, state_db_cleanup_failed: stateDbCleanupFailed, ...retained }
  }

  /** The committed Agent deletion targets and cleanup outcome; throws 409 `refused` while an Agent process holds a row. */
  private async deleteStateDbRows(profile: string | null, sid: string): Promise<SidecarResult<'state_db.delete_cli_session'>> {
    // TAL-529: the compression continuations go too; the Agent's delete keeps and detaches them otherwise. TAL-792: the
    // sidecar resolves them inside its delete transaction, so a guard on any of them refuses before anything is removed.
    let result: SidecarResult<'state_db.delete_cli_session'>
    try { result = await this.deps.runtime.deleteCliSession(profile, sid) } catch { return { ok: false } }
    if (result.refused) {
      const message = result.refused === 'runtime_history_unsupported'
        ? 'This Agent cannot retire the session\'s retained runtime history. Use an Agent that supports retiring this history, or explicitly restore a pre-upgrade backup before deleting it.'
        : 'In use by another Agent process. Try again later.'
      throw new HttpFailure(409, message, { refused: result.refused })
    }
    return result
  }

  async cleanup(zeroOnly: boolean): Promise<Record<string, unknown>> {
    let cleaned = 0
    const removed = new Set<string>()
    for (const s of (await this.store.scanAll())) {
      const shouldDelete = zeroOnly ? s.messages.length === 0 : s.title === 'Untitled' && s.messages.length === 0
      if (!shouldDelete || (await this.isReadOnly(s))) continue
      // A cleared session keeps its share; keep the session (and its revoke route) if the share cannot be revoked.
      try { (await this.deps.shares.revoke(s)) } catch { continue }
      this.store.sessions.delete(s.session_id)
      await this.store.delete(s.session_id, { tombstone: false })
      cleaned += 1
      removed.add(s.session_id)
    }
    let rewroteIndex = false
    try {
      const rows = (await this.store.readIndexEntries())
      const live = (await this.store.persistedIds())
      const survivors = rows.filter((entry) => {
        const id = str(entry.session_id)
        if (!id || live.has(id) || this.store.sessions.has(id)) return true
        if (removed.has(id)) return false
        cleaned += 1
        return false
      })
      if (survivors.length < rows.length) {
        await this.store.writeIndex()
        rewroteIndex = true
      }
    } catch { /* corrupt index is rebuilt below */ }
    if (removed.size && !rewroteIndex) { try { (await this.store.writeIndex()) } catch { /* ignore */ } }
    return { ok: true, cleaned }
  }

  async import(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const messages = stripPublicInternalFields(body.messages, { messageRecords: true })
    if (!Array.isArray(messages)) throw new HttpFailure(400, 'JSON must contain a "messages" array')
    const rawToolCalls = body.tool_calls ?? []
    if (!Array.isArray(rawToolCalls)) throw new HttpFailure(400, 'JSON "tool_calls" must be an array')
    let workspace: string
    try {
      workspace = (await this.deps.workspaces.resolveTrusted(typeof body.workspace === 'string' ? body.workspace : null))
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const defaults = (await this.store.deps.defaults(this.deps.activeProfile()))
    const s = new Session(
      { title: typeof body.title === 'string' ? body.title : 'Imported session', workspace, model: typeof body.model === 'string' ? body.model : defaults.model, messages: messages as Message[], tool_calls: stripPublicInternalFields(rawToolCalls) as Record<string, unknown>[], profile: this.deps.activeProfile() },
      defaults,
    )
    s.pinned = Boolean(body.pinned)
    await this.store.touch(s)
    await this.store.save(s)
    this.publish('session_import')
    return { ok: true, session: (await this.publicSession(s)) }
  }

  // ── drafts ───────────────────────────────────────────────────────────────

  async readDraft(sid: string): Promise<Record<string, unknown>> {
    if (!sid) throw new HttpFailure(400, 'session_id is required')
    try { this.deps.drafts.validate(sid) } catch { throw new HttpFailure(400, 'Invalid session_id') }
    const hasSidecar = await this.deps.drafts.exists(sid)
    if (hasSidecar) {
      const cached = this.store.sessions.get(sid)
      if (!cached && !(await existsSessionFile(this.store, sid))) throw new HttpFailure(404, 'Session not found')
      const [draft, version] = (await this.deps.drafts.readState(sid))
      if (cached) cached.composer_draft = draft
      return { draft, draft_version: version }
    }
    const s = (await this.get404(sid, { metadataOnly: true }))
    const [draft, version] = (await this.deps.drafts.readState(sid, s.composer_draft))
    return { draft, draft_version: version }
  }

  async writeDraft(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sid = str(body.session_id)
    if (!sid) throw new HttpFailure(400, 'Missing required field(s): session_id')
    if ((await this.isSubagentViewOnly(sid))) throw new HttpFailure(400, 'Subagent sessions are view-only and cannot store a draft from WebUI')
    let text = body.text
    let files = body.files
    if (text !== null && text !== undefined && typeof text !== 'string') text = ''
    if (typeof text === 'string' && text.length > 50_000) text = text.slice(0, 50_000)
    if (files !== null && files !== undefined && !Array.isArray(files)) files = []
    if (Array.isArray(files) && files.length > 50) files = files.slice(0, 50)
    try { this.deps.drafts.validate(sid) } catch { throw new HttpFailure(400, 'Invalid session_id') }
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
    return this.store.withLock(sid, async () => {
      let s = this.store.sessions.get(sid) ?? null
      if (s && s.session_id !== sid) s = null
      const sessionExists = (await existsSessionFile(this.store, sid))
      if (!s) {
        if (!sessionExists) throw new HttpFailure(404, 'Session not found')
        if (!(await this.deps.drafts.exists(sid))) s = (await this.get404(sid, { metadataOnly: true }))
      }
      const [currentDraft, currentVersion] = (await this.deps.drafts.readState(sid, s?.composer_draft))
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
          await this.store.save(s, { touchUpdatedAt: false })
        }
        try {
          saved = (await this.deps.drafts.write(sid, next, draftVersion))
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
      s = (await this.getForMutation(sid))
    } catch (error) {
      if (error instanceof SessionNotFound) throw new HttpFailure(404, 'Session not found')
      if (error instanceof HttpFailure && error.status === 403) throw new HttpFailure(403, 'Read-only imported sessions cannot persist anchor scenes')
      throw error
    }
    if (!this.visibleToActiveProfile(s.profile)) throw new HttpFailure(404, 'Session not found')
    return this.withMutationLock(sid, async () => {
      let placement
      try {
        placement = storeAnchorScene(s, body, this.deps.now())
      } catch (error) {
        throw new HttpFailure(400, (error as Error).message)
      }
      if (!placement) throw new HttpFailure(404, 'Assistant message not found')
      await this.store.save(s, { touchUpdatedAt: false, skipIndex: true })
      return { ok: true, ...placement }
    })
  }

  /** The session and the full transcript its detail is built from; a state.db-only session gives its synthesized one. */
  private async fullTranscript(sid: string): Promise<{ session: Session; transcript: Message[]; stored: boolean }> {
    try {
      let session = (await this.store.get(sid))
      if (session.loadedMetadataOnly) session = (await this.store.load(sid)) ?? session
      if (!this.visibleToActiveProfile(session.profile)) throw new HttpFailure(404, 'Session not found')
      return { session, transcript: this.mergedTranscript(session, session.messages, await this.stateDbRows(session)), stored: true }
    } catch (error) {
      if (error instanceof HttpFailure) throw error
      const session = (await this.foreignSession(sid)).synth
      return { session, transcript: session.messages, stored: false }
    }
  }

  async readAnchorScene(query: Record<string, string | null | undefined>): Promise<Record<string, unknown>> {
    const sid = str(query.session_id).trim()
    const messageRef = normalizeAnchorSceneMessageRef(query.message_ref)
    const messageIndex = anchorSceneIntOrNull(query.message_index)
    if (!sid || (!messageRef && messageIndex === null)) throw new HttpFailure(400, 'session_id and message_ref or message_index are required')
    const { session, transcript, stored } = (await this.fullTranscript(sid))
    const result = readAnchorSceneRows(session, { messageRef, messageIndex, before: anchorSceneIntOrNull(query.before), limit: anchorSceneIntOrNull(query.limit) }, withToolCallOutcomes(withTurnIds(transcript), session.tool_calls, session.active_stream_id))
    if (!result) throw new HttpFailure(404, 'Anchor activity scene not found')
    // Paged rows come from the raw transcript, so they take the same credential redaction as the detail's preview.
    const enabled = this.deps.redactEnabled()
    const redacted = redactValue(result, enabled) as typeof result
    const rows = withSceneToolDisplay(result.rows, redacted.rows as unknown[], enabled)
    // `/api/media` serves stored sessions only, so a state.db-only session's rows stay as written, as its detail does.
    return { ...redacted, rows: stored ? withSceneRowMedia(rows, (await this.mediaProjector(session))) : rows }
  }

  /** TAL-331: one tool call's whole result, which a limited response clipped (`result_truncated`), redacted like the detail. */
  async readToolResult(query: { session_id: string; tool_call_id: string }): Promise<{ tool_call_id: string; result: string; result_view: ToolResultView }> {
    const sid = query.session_id.trim()
    const id = query.tool_call_id.trim()
    if (!sid || !id) throw new HttpFailure(400, 'session_id and tool_call_id are required')
    const full = fullToolResult((await this.fullTranscript(sid)).transcript, id)
    if (full === null) throw new HttpFailure(404, 'Tool result not found')
    return { tool_call_id: id, ...redactValue(full, this.deps.redactEnabled()) as typeof full }
  }

  // ── shares ───────────────────────────────────────────────────────────────

  async createShare(sid: string): Promise<Record<string, unknown>> {
    this.rejectClaudeCode(sid, 'shared')
    let s = (await this.get404(sid))
    if (!this.visibleToActiveProfile(s.profile)) throw new HttpFailure(404, 'Session not found')
    s = (await this.store.ensureFull(sid, s))
    let snapshot
    try {
      snapshot = buildShareSnapshot(s, s.messages, { hermesHome: this.deps.hermesHome, attachmentRoot: this.deps.attachmentDir('').replace(/\/[^/]*$/, ''), home: this.deps.home })
    } catch (error) {
      throw new HttpFailure(400, (error as Error).message)
    }
    const meta = (await this.deps.shares.createOrRefresh(s, snapshot))
    s.share_token = meta.share_token
    s.share_created_at = meta.share_created_at
    await this.store.save(s, { touchUpdatedAt: false })
    this.publish('session_share_create', s.profile, sid)
    return {
      ok: true,
      share: { token: meta.share_token, url: sharePath(meta.share_token) ?? '', title: meta.share_title, message_count: meta.share_message_count, created_at: meta.share_created_at, updated_at: meta.share_updated_at },
      session: (await this.publicSession(s)),
    }
  }

  async revokeShare(sid: string): Promise<Record<string, unknown>> {
    let s = (await this.get404(sid))
    if (!this.visibleToActiveProfile(s.profile)) throw new HttpFailure(404, 'Session not found')
    s = (await this.store.ensureFull(sid, s))
    await this.deps.shares.revoke(s)
    s.share_token = null
    s.share_created_at = null
    await this.store.save(s, { touchUpdatedAt: false })
    this.publish('session_share_revoke', s.profile, sid)
    return { ok: true, session: (await this.publicSession(s)) }
  }

  async loadShare(token: string): Promise<Record<string, unknown>> {
    const share = (await this.deps.shares.load(token))
    if (!share) throw new HttpFailure(404, 'Shared conversation not found')
    return { share }
  }

  // ── yolo ─────────────────────────────────────────────────────────────────

  yolo(sid: string): Record<string, unknown> {
    if (!sid) throw new HttpFailure(400, 'Missing session_id')
    return { yolo_enabled: this.deps.yolo.isEnabled(sid) }
  }

  async setYolo(sid: string, enabled: boolean): Promise<Record<string, unknown>> {
    if (!sid) throw new HttpFailure(400, 'Missing required field(s): session_id')
    await this.assertWritable(sid)
    this.deps.yolo.set(sid, enabled)
    return { ok: true, yolo_enabled: this.deps.yolo.isEnabled(sid) }
  }
}

async function existsSessionFile(store: SessionStore, sid: string): Promise<boolean> {
  return (await store.persistedIds()).has(sid)
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

/** A failed state.db read says nothing (TAL-493). */
function failedStateDbRead(): StateDbRead {
  return { rows: [], idCapable: false, ok: false, reason: null, generation: null }
}

/** TAL-529: after a compression rotation the Agent writes to the continuation, so a read follows the recorded lineage. */
function stateDbReadLineage(s: Session): string[] | null {
  return s.state_db_lineage?.[0] === s.session_id ? s.state_db_lineage : null
}

/** A delegated child's view, which never merges state.db rows. */
function isSubagentView(s: Session): boolean {
  return str(s.source_tag || s.raw_source || s.session_source).trim().toLowerCase() === 'subagent'
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

/** `rows` minus one occurrence of each base row, retaining its numeric provenance on the Agent's history copy. */
function withoutRows(rows: Message[], base: Message[]): Message[] {
  const left = new Map<string, { rows: Message[]; at: number }>()
  for (const m of base) {
    const key = settledIdentity(m)
    const entry = left.get(key) ?? { rows: [], at: 0 }
    entry.rows.push(m)
    left.set(key, entry)
  }
  return rows.filter((m) => {
    const entry = left.get(settledIdentity(m))
    if (!entry || entry.at === entry.rows.length) return true
    const original = entry.rows[entry.at++]!
    if (!('_state_db_generation' in m) && '_state_db_generation' in original) m._state_db_generation = original._state_db_generation
    return false
  })
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
