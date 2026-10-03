/**
 * The sidebar list (Python `all_sessions`, `_build_session_list_cache_payload`,
 * `_session_list_payload_to_response`) built from the sidebar index, resident
 * sessions, and sidecar metadata refreshes. CLI / messaging rows from
 * state.db are not merged yet (P7 pending); the shape and every filter that
 * does not depend on them are kept so that layer slots in unchanged.
 */
import { str } from '../util.js'
import { createHash } from 'node:crypto'
import { redactText } from '../redact.js'
import { Session, stripSidebarHeavyMetadata } from './session.js'
import type { SessionStore } from './store.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isCliSessionRow as isStateDbCliRow, isCliSessionRowVisible, normalizeAgentSessionSource } from './state-db.js'
import { MESSAGING_SOURCES, sourceKind } from './source-kind.js'

export type Row = Record<string, unknown>
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) && n > 0 ? n : 0 }

export function sessionSortTimestamp(row: Row): number {
  return num(row.last_message_at) || num(row.updated_at)
}

export function sidebarMessageCount(row: Row): number {
  for (const key of ['message_count', 'actual_message_count']) {
    const value = Math.trunc(Number(row[key] ?? 0)) || 0
    if (value > 0) return value
  }
  return 0
}

function sourceOf(row: Row): string {
  return str(row.source_tag || row.source || row.raw_source || row.session_source)
}

export function hideFromDefaultSidebar(row: Row, opts: { showCron?: boolean; showWebhook?: boolean; showKanban?: boolean } = {}): boolean {
  const sid = str(row.session_id)
  const source = sourceOf(row)
  if (!opts.showCron && (source === 'cron' || sid.startsWith('cron_'))) return true
  if (!opts.showWebhook && source === 'webhook') return true
  if (!opts.showKanban && source === 'kanban') return true
  if (row.pre_compression_snapshot) return !row._show_pre_compression_snapshot
  return false
}

export function isIntentionallyBackground(row: Row): boolean {
  const source = sourceOf(row)
  return ['cron', 'webhook', 'kanban'].includes(source) || str(row.session_id).startsWith('cron_')
}

function hasLiveState(row: Row): boolean {
  return Boolean(row.active_stream_id || row.has_pending_user_message || row.pending_user_message)
}

export function lineageRootId(row: Row, byId: Map<string, Row>): string {
  const sid = str(row.session_id)
  const explicit = str(row._lineage_root_id).trim()
  if (explicit) return explicit
  if (str(row.relationship_type).trim().toLowerCase() === 'child_session') return sid
  let root = sid
  let parent = str(row.parent_session_id)
  if (str(row.session_source).trim().toLowerCase() === 'fork') return root
  const seen = new Set([sid])
  while (parent && !seen.has(parent) && byId.has(parent)) {
    root = parent
    seen.add(root)
    parent = str(byId.get(root)?.parent_session_id)
  }
  return root
}

function includeProjectHiddenBackground(candidates: Row[], visible: Row[]): Row[] {
  const visibleIds = new Set(visible.map((r) => str(r.session_id)).filter(Boolean))
  const out = [...visible]
  for (const row of candidates) {
    const sid = str(row.session_id)
    if (!sid || visibleIds.has(sid) || !isIntentionallyBackground(row) || !row.project_id || sidebarMessageCount(row) <= 0) continue
    out.push({ ...row, default_hidden: true })
  }
  return out
}

function preserveMessagefulDiscoverability(candidates: Row[], visible: Row[]): Row[] {
  const byId = new Map(candidates.filter((r) => r.session_id).map((r) => [str(r.session_id), r]))
  const coveredRoots = new Set(visible.filter((r) => sidebarMessageCount(r) > 0).map((r) => lineageRootId(r, byId)))
  const visibleIds = new Set(visible.map((r) => str(r.session_id)).filter(Boolean))
  const rescue = new Map<string, Row>()
  for (const row of candidates) {
    const sid = str(row.session_id)
    if (!sid || visibleIds.has(sid) || sidebarMessageCount(row) <= 0 || isIntentionallyBackground(row)) continue
    const root = lineageRootId(row, byId)
    if (coveredRoots.has(root)) continue
    const current = rescue.get(root)
    const better = !current || sidebarMessageCount(row) > sidebarMessageCount(current) || (sidebarMessageCount(row) === sidebarMessageCount(current) && sessionSortTimestamp(row) > sessionSortTimestamp(current))
    if (better) rescue.set(root, { ...row, discoverability_warning: 'rescued_messageful_hidden_session' })
  }
  if (!rescue.size) return visible
  const rescued = [...rescue.values()].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || sessionSortTimestamp(b) - sessionSortTimestamp(a))
  return [...visible, ...rescued]
}

function preferFullerSnapshots(rows: Row[]): Row[] {
  const byId = new Map(rows.filter((r) => r.session_id).map((r) => [str(r.session_id), r]))
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const sid = str(row.session_id)
    const source = str(row.source_tag || row.source)
    if (source === 'cron' || sid.startsWith('cron_')) continue
    const root = lineageRootId(row, byId)
    const group = groups.get(root) ?? []
    group.push(row)
    groups.set(root, group)
  }
  const show = new Set<string>()
  const hide = new Set<string>()
  for (const group of groups.values()) {
    const visible = group.filter((r) => !r.pre_compression_snapshot)
    const snapshots = group.filter((r) => Boolean(r.pre_compression_snapshot))
    if (!visible.length || !snapshots.length || visible.some(hasLiveState)) continue
    const bestVisibleCount = Math.max(...visible.map(sidebarMessageCount))
    const bestSnapshot = snapshots.reduce((a, b) => (sidebarMessageCount(b) > sidebarMessageCount(a) || (sidebarMessageCount(b) === sidebarMessageCount(a) && sessionSortTimestamp(b) > sessionSortTimestamp(a)) ? b : a))
    if (sidebarMessageCount(bestSnapshot) <= bestVisibleCount) continue
    const newestVisibleTs = Math.max(...visible.map(sessionSortTimestamp))
    const snapshotId = str(bestSnapshot.session_id)
    if (!snapshotId) continue
    show.add(snapshotId)
    if (newestVisibleTs > sessionSortTimestamp(bestSnapshot)) continue
    if (visible.filter((r) => sidebarMessageCount(r) > 0).length > 1) continue
    for (const r of visible) if (r.session_id) hide.add(str(r.session_id))
  }
  if (!show.size && !hide.size) return rows
  const out: Row[] = []
  for (const row of rows) {
    const sid = str(row.session_id)
    if (hide.has(sid)) continue
    out.push(show.has(sid) ? { ...row, _show_pre_compression_snapshot: true } : row)
  }
  return out
}

function looksLikeStaleZeroMessageRow(row: Row): boolean {
  return Math.trunc(Number(row.message_count ?? 0)) === 0 && Math.trunc(Number(row.user_message_count ?? 0)) > 0
}

function isEmptyUntitledDraft(row: Row): boolean {
  return str(row.title || 'Untitled') === 'Untitled' && Math.trunc(Number(row.message_count ?? 0)) === 0 && !row.active_stream_id && !row.has_pending_user_message && !row.worktree_path
}

export interface AllSessionsOptions { sidebarMetadataOnly?: boolean }

/** Python `all_sessions` without the state.db lineage overlay. */
export function allSessions(store: SessionStore, opts: AllSessionsOptions = {}): Row[] {
  const activeStreamIds = store.deps.activeStreamIds()
  const finish = (result: Row[]): Row[] => {
    result = preferFullerSnapshots(result)
    const candidates = result
    const visible = candidates.filter((r) => !hideFromDefaultSidebar(r))
    let rows = preserveMessagefulDiscoverability(candidates, visible)
    rows = includeProjectHiddenBackground(candidates, rows)
    for (const r of rows) {
      Reflect.deleteProperty(r, '_show_pre_compression_snapshot')
      if (!r.profile) r.profile = 'default'
      if (opts.sidebarMetadataOnly) stripSidebarHeavyMetadata(r)
    }
    return rows
  }
  const sortRows = (rows: Row[]) => rows.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || sessionSortTimestamp(b) - sessionSortTimestamp(a))
  const indexExists = (() => { try { return Boolean(store.readIndexEntries()) } catch { return false } })()
  if (!indexExists) {
    try { store.writeIndex() } catch { /* fall through to the scan */ }
  }
  try {
    let index = store.readIndexEntries().map((row) => ({ ...row }))
    const inMemory = new Set(store.sessions.keys())
    const persisted = store.persistedIds()
    if (!index.length && store.hasPersistedSessionFiles()) throw new Error('empty session index while session files exist')
    index = index.filter((r) => inMemory.has(str(r.session_id)) || persisted.has(str(r.session_id)))
    if (!index.length && store.hasPersistedSessionFiles()) throw new Error('session index has no live rows while session files exist')
    const backfilled: Session[] = []
    index = index.map((r) => {
      if ('last_message_at' in r) return r
      const full = store.load(str(r.session_id))
      if (!full) return r
      backfilled.push(full)
      return full.compact({ sidebarMetadataOnly: opts.sidebarMetadataOnly ?? false })
    })
    if (backfilled.length) { try { store.writeIndex(backfilled) } catch { /* ignore */ } }
    for (const r of index) r.is_streaming = Boolean(r.active_stream_id && activeStreamIds.has(str(r.active_stream_id)))
    const indexMap = new Map(index.map((r) => [str(r.session_id), r]))
    for (const s of store.sessions.values()) indexMap.set(s.session_id, s.compact({ includeRuntime: true, activeStreamIds, sidebarMetadataOnly: opts.sidebarMetadataOnly ?? false }))
    const missing = [...persisted].filter((sid) => !indexMap.has(sid)).sort()
    const recovered: Session[] = []
    for (const sid of missing) {
      const sidecar = store.loadMetadataOnly(sid)
      if (!sidecar) continue
      indexMap.set(sidecar.session_id, sidecar.compact({ includeRuntime: true, activeStreamIds, sidebarMetadataOnly: opts.sidebarMetadataOnly ?? false }))
      recovered.push(sidecar)
    }
    if (recovered.length) { try { store.writeIndex(recovered) } catch { /* ignore */ } }
    const indexCounts = store.indexMessageCounts(index)
    const refreshed = refreshIndexRowsFromSidecarMetadata(store, [...indexMap.values()], indexCounts, activeStreamIds)
    let result = sortRows(refreshed.filter((r) => r.session_id))
    result = result.filter((r) => !isEmptyUntitledDraft(r))
    return finish(result)
  } catch {
    /* fall back to the full scan */
  }
  const out = store.scanAll()
  for (const s of store.sessions.values()) if (!out.some((x) => x.session_id === s.session_id)) out.push(s)
  const rows = out
    .filter((s) => !(s.title === 'Untitled' && s.messages.length === 0 && !s.active_stream_id && !s.pending_user_message && !s.worktree_path))
    .map((s) => s.compact({ includeRuntime: true, activeStreamIds, sidebarMetadataOnly: opts.sidebarMetadataOnly ?? false }))
  return finish(sortRows(rows))
}

function sidecarMtimeAfterIndexTimestamp(store: SessionStore, row: Row): boolean {
  const sid = str(row.session_id)
  if (!sid) return false
  try {
    const mtime = statSyncMtime(store.pathFor(sid))
    return mtime > sessionSortTimestamp(row) + 0.001
  } catch {
    return false
  }
}

function statSyncMtime(path: string): number {
  return statSync(path).mtimeMs / 1000
}

function rowMayNeedSidecarRefresh(store: SessionStore, row: Row, staleSnapshotIds: Set<string>): boolean {
  if (hasLiveState(row)) return true
  const sid = str(row.session_id)
  if (!row.pre_compression_snapshot) {
    if (str(row.session_source).trim().toLowerCase() === 'fork') return false
    if (row.message_count === null || row.message_count === undefined || row.last_message_at === null || row.last_message_at === undefined) return true
    const lineageShaped = Boolean(row.parent_session_id || row._lineage_root_id || row._compression_segment_count)
    const needsMtime = Boolean(sid) && (looksLikeStaleZeroMessageRow(row) || (lineageShaped && (row.user_message_count === null || row.user_message_count === undefined)))
    return needsMtime && sidecarMtimeAfterIndexTimestamp(store, row)
  }
  if (sid && looksLikeStaleZeroMessageRow(row) && str(row.session_source).trim().toLowerCase() !== 'fork' && sidecarMtimeAfterIndexTimestamp(store, row)) return true
  if (row.message_count === null || row.message_count === undefined || row.last_message_at === null || row.last_message_at === undefined) return true
  return Boolean(sid) && staleSnapshotIds.has(sid)
}

function staleSnapshotRefreshIds(store: SessionStore, rows: Row[]): Set<string> {
  const byId = new Map(rows.filter((r) => r.session_id).map((r) => [str(r.session_id), r]))
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const sid = str(row.session_id)
    const source = str(row.source_tag || row.source)
    if (source === 'cron' || sid.startsWith('cron_')) continue
    const root = lineageRootId(row, byId)
    groups.set(root, [...(groups.get(root) ?? []), row])
  }
  const ids = new Set<string>()
  for (const group of groups.values()) {
    const visible = group.filter((r) => !r.pre_compression_snapshot)
    const snapshots = group.filter((r) => Boolean(r.pre_compression_snapshot))
    if (!visible.length || !snapshots.length || visible.some(hasLiveState)) continue
    const bestVisible = Math.max(...visible.map(sidebarMessageCount))
    for (const snapshot of snapshots) {
      const sid = str(snapshot.session_id)
      if (!sid || sidebarMessageCount(snapshot) > bestVisible) continue
      if (snapshot.user_message_count !== null && snapshot.user_message_count !== undefined && Math.trunc(Number(snapshot.message_count ?? 0)) > 0 && snapshot.last_message_at !== null && snapshot.last_message_at !== undefined) continue
      if (sidecarMtimeAfterIndexTimestamp(store, snapshot)) ids.add(sid)
    }
  }
  return ids
}

const REFRESH_KEYS = ['message_count', 'updated_at', 'last_message_at', 'title', 'workspace', 'model', 'model_provider', 'created_at', 'pinned', 'archived', 'project_id', 'profile', 'pre_compression_snapshot', 'parent_session_id', 'source_tag', 'raw_source', 'session_source', 'source_label', 'active_stream_id', 'has_pending_user_message', 'pending_user_message', 'pending_started_at']

function refreshIndexRowsFromSidecarMetadata(store: SessionStore, rows: Row[], indexCounts: Map<string, number>, activeStreamIds: Set<string>): Row[] {
  const stale = staleSnapshotRefreshIds(store, rows)
  const out: Row[] = []
  for (const row of rows) {
    const sid = str(row.session_id)
    if (!rowMayNeedSidecarRefresh(store, row, stale) || !sid) { out.push(row); continue }
    const sidecar = store.loadMetadataOnly(sid, { indexMessageCounts: indexCounts })
    if (!sidecar) { out.push(row); continue }
    const compact = sidecar.compact({ includeRuntime: true, activeStreamIds })
    const refreshed = { ...row }
    for (const key of REFRESH_KEYS) if (compact[key] !== null && compact[key] !== undefined) refreshed[key] = compact[key]
    refreshed.message_count = Math.max(Math.trunc(Number(row.message_count ?? 0)) || 0, Math.trunc(Number(compact.message_count ?? 0)) || 0)
    if (sessionSortTimestamp(compact) > sessionSortTimestamp(row)) {
      refreshed.updated_at = compact.updated_at ?? refreshed.updated_at
      refreshed.last_message_at = compact.last_message_at ?? refreshed.last_message_at
    }
    out.push(refreshed)
  }
  return out
}

// ── /api/sessions payload ─────────────────────────────────────────────────

export const SIDEBAR_SESSION_RESPONSE_FIELDS = new Set([
  'session_id', 'title', 'display_title', '_state_db_title', 'workspace', 'model', 'model_provider', 'message_count', 'user_message_count', 'created_at', 'updated_at',
  'last_message_at', 'pinned', 'archived', 'project_id', 'profile', 'input_tokens', 'output_tokens', 'estimated_cost', 'cache_read_tokens', 'cache_write_tokens',
  'cache_hit_percent', 'personality', 'context_length', 'config_context_length', 'window_usage_percent', 'source_tag', 'raw_source', 'session_source', 'source_label',
  'is_cli_session', 'is_messaging_session', 'is_streaming', 'cron_running', 'active_stream_id', 'has_pending_user_message', 'pending_started_at', 'default_hidden',
  'worktree_path', 'worktree_branch', 'parent_session_id', 'parent_title', 'parent_source', 'relationship_type', 'pre_compression_snapshot', '_lineage_root_id',
  '_lineage_tip_id', '_compression_segment_count', '_lineage_collapsed_count', '_parent_lineage_root_id', '_parent_lineage_tip_id', '_cross_surface_child_session',
  'match_type', 'match_preview', 'read_only', 'can_branch', 'can_pin', 'can_archive', 'can_duplicate', 'gateway_routing',
])

export function isCliSessionRow(row: Row): boolean {
  const lower = (v: unknown) => str(v).trim().toLowerCase()
  const source = lower(row.session_source)
  const sourceTag = lower(row.source_tag)
  const rawSource = lower(row.raw_source)
  const sourceName = lower(row.source)
  const sourceLabel = lower(row.source_label)
  const all = new Set([source, sourceTag, rawSource, sourceName, sourceLabel])
  if (all.has('webui')) return false
  const nonCli = new Set([...MESSAGING_SOURCES, 'messaging', 'cron', 'webhook', 'kanban', 'tool', 'api', 'api_server', 'subagent'])
  for (const v of all) if (v && nonCli.has(v)) return false
  if (source === 'cli') return true
  if (source === 'external_agent' || source === 'external-agent') return true
  const interactive = new Set(['acp', 'cli', 'tui'])
  return [sourceTag, rawSource, sourceName, sourceLabel].some((v) => interactive.has(v))
}

function isCliSessionForSettings(row: Row): boolean {
  // TAL-310: never count or filter as CLI a row the wire files under another kind.
  const kind = sourceKind(row)
  if (kind !== 'cli' && kind !== 'claude_code') return false
  if (isCliSessionRow(row)) return true
  if (!row.is_cli_session) return false
  const source = str(row.source).trim().toLowerCase()
  if (MESSAGING_SOURCES.has(source) || source === 'messaging') return false
  const title = str(row.title).trim().toLowerCase()
  return ['', 'untitled', 'cli', 'cli session'].includes(title) || (title.endsWith(' session') && (!source || source === 'cli'))
}

export interface ListParams {
  activeProfile: string
  allProfiles: boolean
  includeArchived: boolean
  excludeHidden: boolean
  visibleOnly: boolean
  showCliSessions: boolean
  showClaudeCodeSessions: boolean
  showPreviousMessagingSessions: boolean
  showCronSessions: boolean
  showWebhookSessions: boolean
  showKanbanSessions: boolean
  requestVisibilityOverrides: boolean
  sidebarSource: 'webui' | 'cli' | null
  archivedLimit: number | null
  archivedOffset: number
  isolatedProfileMode: boolean
  profilesMatch: (a: string | null | undefined, b: string | null | undefined) => boolean
  /** state.db rows for the sidebar (Python `get_cli_sessions`); omitted when no non-WebUI source is shown. */
  cliRows?: Row[]
  /** Gateway `sessions.json` identity map for the messaging dedupe (Python `_load_gateway_session_identity_map`). */
  gatewayIdentity?: Map<string, GatewayIdentity>
  sourceFilter?: string | null
  /** TAL-358: batched active-profile state.db owner lookup (`stateDbSessionSources`) for the sidecar owner lock. */
  stateDbSources?: (ids: string[]) => Map<string, string> | null
  /** TAL-482: background kinds whose state.db rows stopped at the per-kind cap, so more exist than `cliRows` holds. */
  truncatedSources?: ReadonlySet<string>
}

export interface GatewayIdentity { session_key: string; chat_id: string; thread_id: string; chat_type: string; user_id: string; platform: string; raw_source: string }

const first = (...values: unknown[]): string => { for (const v of values) { if (v === null || v === undefined) continue; const t = str(v).trim(); if (t) return t } return '' }
const STALE_MESSAGING_END_REASONS = new Set(['session_reset', 'session_switch'])
const identityCache = new Map<string, { mtime: number; map: Map<string, GatewayIdentity> }>()

/** Python `_load_gateway_session_identity_map`: `<home>/sessions/sessions.json` keyed by session id, cached on mtime. */
export function loadGatewaySessionIdentityMap(path: string): Map<string, GatewayIdentity> {
  if (!existsSync(path)) return new Map()
  let mtime: number
  try { mtime = statSync(path).mtimeMs } catch { return new Map() }
  const hit = identityCache.get(path)
  if (hit?.mtime === mtime) return new Map(hit.map)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return new Map() }
  const map = new Map<string, GatewayIdentity>()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const entry of Object.values(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const e = entry as Row
      const sid = first(e.session_id)
      if (!sid) continue
      const origin = (e.origin && typeof e.origin === 'object' && !Array.isArray(e.origin) ? e.origin : {}) as Row
      const platform = first(origin.platform, e.platform)
      map.set(sid, { session_key: first(e.session_key, e.key), chat_id: first(origin.chat_id, e.chat_id), thread_id: first(origin.thread_id, e.thread_id), chat_type: first(origin.chat_type, e.chat_type), user_id: first(origin.user_id, e.user_id), platform, raw_source: platform })
    }
  }
  identityCache.set(path, { mtime, map })
  return new Map(map)
}

const isKnownMessagingSource = (raw: string): boolean => MESSAGING_SOURCES.has(raw.trim().toLowerCase())

function sessionMessagingRawSource(row: Row): string {
  const raw = first(row.raw_source, row.source_tag, row.source, row.platform) || first(row.source_label) || 'messaging'
  return raw.toLowerCase()
}

/** Python `_is_messaging_session_record`. */
export function isMessagingSessionRecord(row: Row): boolean {
  if (str(row.session_source) === 'messaging') return true
  return isKnownMessagingSource(first(row.raw_source, row.source_tag, row.source, row.source_label))
}

/** Python `_is_claimable_cli_source`: a denylist of foreign families that own their sessions. */
export function isClaimableCliSource(meta: Row, stateDbSource: string): boolean {
  if (meta.read_only) return false
  const sessionSource = str(meta.session_source).trim().toLowerCase()
  if (['messaging', 'external_agent'].includes(sessionSource)) return false
  const tag = str(meta.source_tag || meta.raw_source).trim().toLowerCase()
  const refused = new Set(['claude_code', 'cron', 'external_agent', 'gateway', 'messaging', 'subagent', 'unknown'])
  if (tag && refused.has(tag)) return false
  if (isMessagingSessionRecord(meta)) return false
  if (!tag && stateDbSource && refused.has(stateDbSource.trim().toLowerCase())) return false
  return true
}

/**
 * TAL-358: marks read-only each WebUI sidecar row whose active-profile state.db owner (`sessions.source`) refuses
 * claiming, as a sidecar-less row from that owner is. A sidecar persisted as WebUI- or fork-born stays WebUI-owned
 * whatever state.db mirrors for its id. `stateDbSources` reads every candidate's owner in one batch, not per row; an
 * unreadable state.db (null) locks every candidate, since an unknown owner is not a released one.
 */
export function withOwnerLocks(rows: Row[], stateDbSources: (ids: string[]) => Map<string, string> | null): Row[] {
  const webuiOwned = (r: Row): boolean => ['source_tag', 'raw_source', 'session_source'].some((k) => ['webui', 'fork'].includes(str(r[k]).trim().toLowerCase()))
  const candidates = rows.filter((r) => !r.read_only && !webuiOwned(r)).map((r) => str(r.session_id))
  if (!candidates.length) return rows
  const owners = stateDbSources(candidates)
  const locked = new Set(candidates.filter((sid) => {
    if (!owners) return true
    const source = str(owners.get(sid)).trim().toLowerCase()
    return Boolean(source) && !isClaimableCliSource({ source_tag: source, ...normalizeAgentSessionSource(source) }, source)
  }))
  return locked.size ? rows.map((r) => (locked.has(str(r.session_id)) ? { ...r, read_only: true } : r)) : rows
}

/** Python `_session_is_subagent_view_only` on a row: a delegated child by any source marker. */
export function isSubagentRow(row: Row): boolean {
  return str(row.source_tag || row.raw_source || row.session_source || row.source).trim().toLowerCase() === 'subagent'
}

/**
 * TAL-312: the streaming and read-only flags every session payload ships. `is_streaming` holds only while the row's
 * `active_stream_id` is a live runtime stream, and a stale id goes out as `null`; `read_only` folds the persisted flag
 * with the view-only subagent rule (a not-claimable foreign row or owner-locked sidecar arrives already marked); the
 * `can_*` flags mirror the branch, pin, archive and duplicate gates. Clients render these as-is.
 */
export function withSessionWireFlags<T extends Row>(row: T, activeStreamIds: ReadonlySet<string>): T {
  const r: Row = row
  const streamId = str(r.active_stream_id)
  r.is_streaming = Boolean(streamId && activeStreamIds.has(streamId))
  if (!r.is_streaming) r.active_stream_id = null
  // TAL-460: who started the running turn; a `background` one gives way to the user's next message.
  if ('active_turn_origin' in r && !r.is_streaming) r.active_turn_origin = null
  // TAL-310: the source family clients file the row under; `is_cli_session` is derived from it.
  const kind = sourceKind(r)
  r.source_kind = kind
  r.is_messaging_session = kind === 'messaging'
  r.is_cli_session = kind === 'cli' || kind === 'claude_code'
  const subagent = kind === 'subagent' || isSubagentRow(r)
  if (subagent) { r.read_only = true; r.is_cli_session = false } else r.read_only = Boolean(r.read_only)
  // The branch gate (`SessionService.branch`): never a subagent child, and a read-only source only when it is a cron run.
  r.can_branch = !subagent && (!r.read_only || str(r.source_tag || r.raw_source).trim().toLowerCase() === 'cron')
  // Pin and archive refuse only subagent children; duplicate also needs the WebUI sidecar it copies, so a sidecar-less
  // foreign row arrives with `can_duplicate: false`. Rename, move and delete follow `read_only` (the mutation gate).
  r.can_pin = !subagent
  r.can_archive = !subagent
  r.can_duplicate = !subagent && r.can_duplicate !== false
  return row
}

/** Channel identity a state.db row carries; sidebar rows overlay it and a claimed sidecar keeps it. */
export const CLI_IDENTITY_FIELDS = ['user_id', 'chat_id', 'chat_type', 'thread_id', 'session_key', 'platform'] as const

/** Python `_merge_cli_sidebar_metadata`: state.db truth for drifting metadata, UI-owned archived/pinned kept. */
export function mergeCliSidebarMetadata(ui: Row, meta: Row): Row {
  const merged: Row = { ...ui, is_cli_session: isStateDbCliRow(meta) }
  for (const key of ['source_tag', 'raw_source', 'session_source', 'source_label', ...CLI_IDENTITY_FIELDS, 'parent_session_id', 'end_reason', 'actual_message_count', '_lineage_root_id', '_lineage_tip_id', '_compression_segment_count']) {
    const value = first(meta[key])
    if (value) merged[key] = value
  }
  if (meta.created_at !== null && meta.created_at !== undefined) merged.created_at = meta.created_at
  if (meta.updated_at !== null && meta.updated_at !== undefined) merged.updated_at = meta.updated_at
  if (meta.last_message_at !== null && meta.last_message_at !== undefined) merged.last_message_at = meta.last_message_at
  if (meta.message_count !== null && meta.message_count !== undefined) merged.message_count = Math.max(num(merged.message_count), num(meta.message_count))
  else if (meta.actual_message_count !== null && meta.actual_message_count !== undefined) merged.message_count = Math.max(num(merged.message_count), num(meta.actual_message_count))
  if (meta.title && (!merged.title || merged.title === 'Untitled')) merged.title = meta.title
  if (meta.model && (!merged.model || merged.model === 'unknown')) merged.model = meta.model
  return merged
}

function sessionSourceIsWebui(row: Row): boolean {
  return ['source_tag', 'raw_source', 'session_source', 'source'].some((k) => str(row[k]).trim().toLowerCase() === 'webui')
}

function sessionLineageIds(row: Row): Set<string> {
  const ids = new Set<string>()
  for (const key of ['session_id', '_lineage_root_id', '_lineage_tip_id']) if (row[key]) ids.add(str(row[key]))
  return ids
}

/** Python `_dedupe_cli_sidebar_sessions_for_api`: additive state rows, keeping project-hidden background rows addressable. */
export function dedupeCliSidebarSessions(cli: Row[], represented: Set<string>, opts: { showCli: boolean; showCron: boolean; showWebhook: boolean; showKanban: boolean; sourceFilter: string | null; requestVisibilityOverrides: boolean }): Row[] {
  const sf = str(opts.sourceFilter).trim().toLowerCase()
  const showCron = opts.showCron || sf === 'cron'
  const showWebhook = opts.showWebhook || sf === 'webhook'
  const showKanban = opts.showKanban || sf === 'kanban'
  const candidates = cli.filter((r) => !represented.has(str(r.session_id)) && !(sessionSourceIsWebui(r) && [...sessionLineageIds(r)].some((id) => represented.has(id))) && isCliSessionRowVisible(r))
  const visible = candidates.filter((r) => (!isIntentionallyBackground(r) && opts.showCli) || (isIntentionallyBackground(r) && !hideFromDefaultSidebar(r, { showCron, showWebhook, showKanban })))
  if (opts.requestVisibilityOverrides) return visible
  return includeProjectHiddenBackground(candidates, visible)
}

function messagingSessionIdentity(row: Row, raw: string, identity: Map<string, GatewayIdentity>, isPreCompressionContinuation: (row: Row) => boolean): string {
  const sid = first(row.session_id)
  if (sid && isPreCompressionContinuation(row)) return `${raw}|session_id:${sid}`
  const meta = identity.get(sid) ?? null
  const sessionKey = first(meta?.session_key, row.session_key, row.gateway_session_key)
  if (sessionKey) return `${raw}|session_key:${sessionKey}`
  const chatId = first(meta?.chat_id, row.chat_id, row.origin_chat_id)
  const threadId = first(meta?.thread_id, row.thread_id)
  const chatType = first(meta?.chat_type, row.chat_type)
  const userId = first(meta?.user_id, row.user_id, row.origin_user_id)
  const parts: string[] = []
  if (chatType) parts.push(`chat_type:${chatType}`)
  if (chatId) parts.push(`chat_id:${chatId}`)
  if (threadId) parts.push(`thread_id:${threadId}`)
  if (userId) parts.push(`user_id:${userId}`)
  return parts.length ? `${raw}|${parts.join('|')}` : raw
}

/** Python `_keep_latest_messaging_session_per_source`. */
export function keepLatestMessagingSessionPerSource(rows: Row[], opts: { showPrevious: boolean; identity: Map<string, GatewayIdentity>; isPreCompressionSnapshotId: (sid: string) => boolean }): Row[] {
  if (opts.showPrevious) return [...rows].sort((a, b) => sessionSortTimestamp(b) - sessionSortTimestamp(a))
  const isPreCompressionContinuation = (row: Row): boolean => { const parent = first(row.parent_session_id); return Boolean(parent && opts.isPreCompressionSnapshotId(parent)) }
  const activeIds = new Set([...opts.identity.keys()].filter(Boolean))
  const sessionIds = new Set(rows.map((r) => first(r.session_id)))
  const visibleActiveIds = new Set([...activeIds].filter((id) => sessionIds.has(id)))
  const activeSources = new Set([...opts.identity.entries()].filter(([sid]) => visibleActiveIds.has(sid)).map(([, m]) => first(m.raw_source, m.platform).toLowerCase()).filter(isKnownMessagingSource))
  const shouldHideStale = (row: Row): boolean => {
    const raw = sessionMessagingRawSource(row)
    if (!isKnownMessagingSource(raw) || !visibleActiveIds.size || !activeSources.has(raw)) return false
    const sid = first(row.session_id)
    if (sid && visibleActiveIds.has(sid)) return false
    if (STALE_MESSAGING_END_REASONS.has(first(row.end_reason))) return true
    const meta = opts.identity.get(sid) ?? null
    const durable = Boolean(first(meta?.session_key, row.session_key, row.gateway_session_key, meta?.chat_id, row.chat_id, row.origin_chat_id, meta?.thread_id, row.thread_id))
    if (!durable) return !isPreCompressionContinuation(row)
    if (row.parent_session_id && !isPreCompressionContinuation(row)) return true
    return num(row.message_count) <= 0 && num(row.actual_message_count) <= 0
  }
  const kept: Row[] = []
  const bestBySource = new Map<string, Row>()
  for (const row of rows) {
    const raw = sessionMessagingRawSource(row)
    const key = isKnownMessagingSource(raw) ? messagingSessionIdentity(row, raw, opts.identity, isPreCompressionContinuation) : null
    if (!key) { kept.push(row); continue }
    if (shouldHideStale(row)) continue
    const current = bestBySource.get(key)
    if (!current || sessionSortTimestamp(row) > sessionSortTimestamp(current)) bestBySource.set(key, row)
  }
  kept.push(...bestBySource.values())
  kept.sort((a, b) => sessionSortTimestamp(b) - sessionSortTimestamp(a))
  return kept
}

export const CLI_VISIBLE_SESSION_CAP = 20

/** Python `_cap_recent_cli_sessions`. */
export function capRecentCliSessions(rows: Row[], cap = CLI_VISIBLE_SESSION_CAP): Row[] {
  if (cap <= 0) return rows
  let seen = 0
  return rows.filter((r) => { if (!isCliSessionForSettings(r)) return true; seen += 1; return seen <= cap })
}

function sessionHasServerVisibleMessages(row: Row): boolean {
  if (sidebarMessageCount(row) > 0) return true
  const attention = row.attention
  if (attention && typeof attention === 'object' && (attention as Row).kind && num((attention as Row).count) > 0) return true
  return Boolean(row.is_streaming || row.active_stream_id || row.pending_user_message || row.has_pending_user_message)
}

function hiddenArchivedReferences(visible: Row[], archived: Row[]): Row[] {
  const archivedById = new Map(archived.filter((r) => r.archived && r.session_id).map((r) => [str(r.session_id), r]))
  if (!archivedById.size) return []
  const references: Row[] = []
  const added = new Set<string>()
  const visibleIds = new Set(visible.map((r) => str(r.session_id)))
  for (const row of visible) {
    let parentId = str(row.parent_session_id).trim()
    const seen = new Set<string>()
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      if (visibleIds.has(parentId)) break
      const parent = archivedById.get(parentId)
      if (!parent) break
      if (!added.has(parentId)) { references.push(parent); added.add(parentId) }
      parentId = str(parent.parent_session_id).trim()
    }
  }
  return references
}

export interface ListPayload {
  sessions: Row[]
  sidebar_reference_sessions: Row[]
  cli_count: number
  archived_count: number
  archived_webui_count: number
  archived_cli_count: number
  webui_session_count: number
  cli_session_count: number
  scheduled_session_count: number
  scheduled_sessions_truncated: boolean
  webhook_session_count: number
  webhook_sessions_truncated: boolean
  include_archived: boolean
  archived_limit: number | null
  archived_offset: number
  all_profiles: boolean
  active_profile: string
  other_profile_count: number
  settings: Record<string, boolean>
}

/** Python `_build_session_list_cache_payload`; the orphaned-sidecar prune (#3238/#4985) is not applied. */
export function buildSessionListPayload(store: SessionStore, params: ListParams): ListPayload {
  let webuiSessions: Row[] = allSessions(store, { sidebarMetadataOnly: true }).map((r) => ({ ...r, is_cli_session: isCliSessionRow(r) }))
  // Before the state.db overlay below replaces the sidecar's own source fields, which the WebUI-born exception reads.
  if (params.stateDbSources) webuiSessions = withOwnerLocks(webuiSessions, params.stateDbSources)
  let dedupedCli: Row[] = []
  if (params.cliRows) {
    const cliById = new Map(params.cliRows.map((r) => [str(r.session_id), r]))
    webuiSessions = webuiSessions.map((s) => {
      const meta = cliById.get(str(s.session_id))
      if (!meta) return s
      if (isMessagingSessionRecord(meta)) { const merged = mergeCliSidebarMetadata(s, meta); if (merged.session_id !== meta.session_id) merged.session_id = meta.session_id; return merged }
      // Python `_apply_sidebar_state_db_overrides`: the state.db source classification is authoritative over stale sidecar JSON.
      for (const key of ['source_tag', 'raw_source', 'session_source', 'source_label']) if (meta[key]) s[key] = meta[key]
      return s
    })
    webuiSessions = webuiSessions.map((r) => ({ ...r, is_cli_session: isCliSessionRow(r) }))
    if (!params.showCliSessions) webuiSessions = webuiSessions.filter((r) => !isCliSessionForSettings(r))
    webuiSessions = webuiSessions.filter(isCliSessionRowVisible)
    const represented = new Set<string>()
    for (const s of webuiSessions) for (const id of sessionLineageIds(s)) represented.add(id)
    dedupedCli = dedupeCliSidebarSessions(params.cliRows, represented, { showCli: params.showCliSessions, showCron: params.showCronSessions, showWebhook: params.showWebhookSessions, showKanban: params.showKanbanSessions, sourceFilter: params.sourceFilter ?? null, requestVisibilityOverrides: params.requestVisibilityOverrides })
      // A sidecar-less foreign row whose owner refuses claiming is read-only, as its detail and mutations are.
      .map((r) => ({ ...r, read_only: !isClaimableCliSource(r, str(r.source)), can_duplicate: false }))
  } else {
    webuiSessions = webuiSessions.filter((r) => !isCliSessionForSettings(r))
  }
  if (params.requestVisibilityOverrides) {
    webuiSessions = webuiSessions.filter((r) => !hideFromDefaultSidebar(r, { showCron: params.showCronSessions, showWebhook: params.showWebhookSessions, showKanban: params.showKanbanSessions }))
  }
  const merged = [...webuiSessions, ...dedupedCli].sort((a, b) => (num(b.last_message_at) || num(b.updated_at)) - (num(a.last_message_at) || num(a.updated_at)))
  let scoped: Row[]
  let otherProfileCount = 0
  if (params.allProfiles) scoped = merged
  else {
    scoped = merged.filter((r) => params.profilesMatch(str(r.profile) || null, params.activeProfile))
    otherProfileCount = params.isolatedProfileMode ? 0 : merged.length - scoped.length
  }
  const identity = params.gatewayIdentity ?? new Map<string, GatewayIdentity>()
  const isPreCompressionSnapshotId = (sid: string): boolean => { if (!/^[a-z0-9_]+$/.test(sid)) return false; return Boolean(store.loadMetadataOnly(sid)?.pre_compression_snapshot) }
  const dedupeOpts = { showPrevious: params.showPreviousMessagingSessions, identity, isPreCompressionSnapshotId }
  let archivedScoped = keepLatestMessagingSessionPerSource([...scoped], dedupeOpts)
  let visibleScoped = keepLatestMessagingSessionPerSource(scoped.filter((r) => !r.archived), dedupeOpts)
  if (params.showCliSessions) {
    archivedScoped = capRecentCliSessions(archivedScoped)
    visibleScoped = capRecentCliSessions(visibleScoped)
  }
  if (params.visibleOnly) {
    archivedScoped = archivedScoped.filter(sessionHasServerVisibleMessages)
    visibleScoped = visibleScoped.filter(sessionHasServerVisibleMessages)
  }
  if (params.excludeHidden) {
    archivedScoped = archivedScoped.filter((r) => !r.default_hidden)
    visibleScoped = visibleScoped.filter((r) => !r.default_hidden)
  }
  const archivedWebuiCount = archivedScoped.filter((r) => r.archived && !isCliSessionForSettings(r)).length
  const archivedCliCount = archivedScoped.filter((r) => r.archived && isCliSessionForSettings(r)).length
  const filterSource = (rows: Row[]) => (params.sidebarSource === 'webui' ? rows.filter((r) => !isCliSessionForSettings(r)) : params.sidebarSource === 'cli' ? rows.filter((r) => isCliSessionForSettings(r)) : [...rows])
  const fullScoped = params.includeArchived ? archivedScoped : visibleScoped
  const webuiSessionCount = fullScoped.filter((r) => !isCliSessionForSettings(r)).length
  const cliSessionCount = fullScoped.filter((r) => isCliSessionForSettings(r)).length
  const visibleFiltered = filterSource(visibleScoped)
  const archivedFiltered = filterSource(archivedScoped)
  let result = filterSource(fullScoped)
  if (params.includeArchived && params.archivedLimit !== null) {
    const limit = Math.max(0, Math.trunc(params.archivedLimit))
    const offset = Math.max(0, Math.trunc(params.archivedOffset || 0))
    result = [...visibleFiltered.filter((r) => !r.archived), ...archivedFiltered.filter((r) => Boolean(r.archived)).slice(offset, offset + limit)]
  }
  const references = params.includeArchived ? [] : hiddenArchivedReferences(visibleFiltered, archivedFiltered)
  const truncated = params.truncatedSources ?? new Set<string>()
  return {
    sessions: result.map((r) => ({ ...r })),
    sidebar_reference_sessions: references.map((r) => ({ ...r })),
    cli_count: 0,
    archived_count: archivedWebuiCount + archivedCliCount,
    archived_webui_count: archivedWebuiCount,
    archived_cli_count: archivedCliCount,
    webui_session_count: webuiSessionCount,
    cli_session_count: cliSessionCount,
    scheduled_session_count: visibleFiltered.filter((r) => sourceKind(r) === 'cron').length,
    scheduled_sessions_truncated: params.showCronSessions && truncated.has('cron'),
    webhook_session_count: visibleFiltered.filter((r) => sourceKind(r) === 'webhook').length,
    webhook_sessions_truncated: params.showWebhookSessions && truncated.has('webhook'),
    include_archived: params.includeArchived,
    archived_limit: params.archivedLimit,
    archived_offset: params.archivedOffset,
    all_profiles: params.allProfiles,
    active_profile: params.activeProfile,
    other_profile_count: otherProfileCount,
    settings: {
      show_cli_sessions: params.showCliSessions,
      show_previous_messaging_sessions: params.showPreviousMessagingSessions,
      show_cron_sessions: params.showCronSessions,
      show_claude_code_sessions: params.showCliSessions ? params.showClaudeCodeSessions : false,
      show_webhook_sessions: params.showWebhookSessions,
      show_kanban_sessions: params.showKanbanSessions,
    },
  }
}

export interface RuntimeOverlay {
  activeStreamIds: Set<string>
  runningCronJobs: Map<string, number>
  live: (sid: string) => Session | undefined
  attention: (sid: string) => Row | null
}

const CRON_RUN_TS_RE = /^\d{8}_\d{6}$/

function cronRunning(sid: string, row: Row, prefixes: [string, string, number][]): boolean {
  if (!prefixes.length || !sid) return false
  const createdAt = num(row.created_at)
  for (const [, prefix, startedAt] of [...prefixes].sort((a, b) => b[1].length - a[1].length)) {
    if (sid.startsWith(prefix) && CRON_RUN_TS_RE.test(sid.slice(prefix.length))) return createdAt >= startedAt
  }
  return false
}

/** Overlay live runtime state and cron liveness, then sort (Python `_session_list_cache_overlay_runtime_rows`). */
export function overlayRuntimeRows(rows: Row[], overlay: RuntimeOverlay): Row[] {
  const prefixes: [string, string, number][] = [...overlay.runningCronJobs].map(([jid, started]) => [jid, `cron_${jid}_`, started])
  const out: Row[] = []
  for (const row of rows) {
    const item = { ...row }
    const sid = str(item.session_id).trim()
    const live = overlay.live(sid)
    if (live) {
      item.active_stream_id = live.active_stream_id || null
      item.has_pending_user_message = Boolean(live.pending_user_message)
      for (const key of ['pending_started_at', 'updated_at', 'last_message_at'] as const) {
        const current = num(item[key])
        const raw = key === 'last_message_at' ? live.compact().last_message_at : (live as unknown as Row)[key]
        if (num(raw) > current) item[key] = raw
      }
    }
    const streamId = str(item.active_stream_id)
    item.is_streaming = Boolean(streamId && overlay.activeStreamIds.has(streamId))
    item.cron_running = cronRunning(sid, item, prefixes)
    out.push(item)
  }
  const active = (r: Row) => Boolean(r.is_streaming || r.has_pending_user_message || r.pending_user_message)
  out.sort((a, b) => Number(active(b)) - Number(active(a)) || sessionSortTimestamp(b) - sessionSortTimestamp(a))
  return out
}

export function sidebarSessionResponseItem(row: Row, redactEnabled: boolean, attention: Row | null, activeStreamIds: ReadonlySet<string>): Row {
  const item: Row = {}
  for (const [k, v] of Object.entries(row)) if (SIDEBAR_SESSION_RESPONSE_FIELDS.has(k)) item[k] = v
  if (typeof item.title === 'string') item.title = redactText(item.title, redactEnabled)
  for (const field of ['display_title', '_state_db_title', 'parent_title']) if (typeof item[field] === 'string') item[field] = redactText(item[field], redactEnabled)
  // Python reconciles stale stream state before serialising (#2157): a dead stream id is not exposed as active.
  withSessionWireFlags(item, activeStreamIds)
  item.attention = attention
  return item
}

export interface ListResponse extends Record<string, unknown> {
  sessions: Row[]
  sidebar_reference_sessions: Row[]
  server_time: number
  server_tz: string
  active_profile: string
  all_profiles: boolean
  include_archived: boolean
  archived_count: number
  archived_webui_count: number
  archived_cli_count: number
  other_profile_count: number
  cli_count: number
  webui_session_count: number
  cli_session_count: number
  scheduled_session_count: number
  scheduled_sessions_truncated: boolean
  webhook_session_count: number
  webhook_sessions_truncated: boolean
  archived_limit?: number
  archived_offset?: number
}

export function serverTz(date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

/** Python `_session_list_payload_to_response`; the ETag covers everything but `server_time`. */
export function sessionListResponse(payload: ListPayload, overlay: RuntimeOverlay, redactEnabled: boolean, now: number): { body: ListResponse; etag: string } {
  const runtimeRows = overlayRuntimeRows(payload.sessions, overlay)
  const sessions = runtimeRows.map((r) => sidebarSessionResponseItem(r, redactEnabled, overlay.attention(str(r.session_id)), overlay.activeStreamIds))
  const references = payload.sidebar_reference_sessions.map((r) => ({ ...sidebarSessionResponseItem(r, redactEnabled, overlay.attention(str(r.session_id)), overlay.activeStreamIds), _sidebar_reference_only: true }))
  const tz = serverTz()
  const body: ListResponse = {
    server_time: now,
    server_tz: tz,
    sessions,
    sidebar_reference_sessions: references,
    cli_count: payload.cli_count,
    archived_count: payload.archived_count,
    archived_webui_count: payload.archived_webui_count,
    archived_cli_count: payload.archived_cli_count,
    include_archived: payload.include_archived,
    all_profiles: payload.all_profiles,
    active_profile: payload.active_profile,
    other_profile_count: payload.other_profile_count,
    webui_session_count: payload.webui_session_count,
    cli_session_count: payload.cli_session_count,
    scheduled_session_count: payload.scheduled_session_count,
    scheduled_sessions_truncated: payload.scheduled_sessions_truncated,
    webhook_session_count: payload.webhook_session_count,
    webhook_sessions_truncated: payload.webhook_sessions_truncated,
  }
  if (payload.archived_limit !== null) {
    body.archived_limit = Math.trunc(payload.archived_limit) || 0
    body.archived_offset = Math.trunc(payload.archived_offset) || 0
  }
  const tail = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'server_time' && k !== 'server_tz')))
  const etag = `"${createHash('sha256').update(tail, 'utf8').digest('hex')}-${tz}"`
  return { body, etag }
}

// ── search ────────────────────────────────────────────────────────────────

export function sessionSearchMessageText(message: unknown): string {
  const content = message && typeof message === 'object' ? (message as Row).content : ''
  if (Array.isArray(content)) return content.filter((p): p is Row => Boolean(p) && typeof p === 'object' && (p as Row).type === 'text').map((p) => str(p.text)).join(' ')
  return str(content)
}

export function sessionSearchPreview(text: string, query: string, maxLen = 124): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const q = query.replace(/\s+/g, ' ').trim()
  if (!normalized || !q) return ''
  const idx = normalized.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return ''
  const limit = Math.max(32, maxLen)
  if (normalized.length <= limit) return normalized
  const context = Math.max(12, Math.floor((limit - q.length) / 2))
  let start = Math.max(0, idx - context)
  let end = Math.min(normalized.length, idx + q.length + context)
  if (start > 0) {
    while (start < idx && normalized[start] !== ' ') start += 1
    if (start >= idx) start = Math.max(0, idx - context)
  }
  if (end < normalized.length) {
    while (end > idx + q.length && normalized[end - 1] !== ' ') end -= 1
    if (end <= idx + q.length) end = Math.min(normalized.length, idx + q.length + context)
  }
  let excerpt = normalized.slice(start, end).trim()
  if (start > 0) excerpt = '...' + excerpt
  if (end < normalized.length) excerpt += '...'
  return excerpt
}
