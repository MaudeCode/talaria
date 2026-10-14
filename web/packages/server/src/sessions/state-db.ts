/**
 * Read-only projection of the Agent's `state.db` (Python `api/agent_sessions.py`):
 * importable agent session rows with compression-chain collapse, CLI visibility
 * rules, the O(1) change fingerprint used by the gateway watcher, and existence
 * probes. Uses `node:sqlite`; every read opens a short-lived read-only handle
 * with a bounded busy timeout, and no path here ever writes to the database.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { str } from '../util.js'
import { stateDbMessageFingerprint } from './state-db-identity.js'
import { MESSAGING_SOURCES } from './source-kind.js'
import { looksLikeDefaultCliTitle, normalizeSourceName } from './titles.js'

export type Dict = Record<string, unknown>

export const CLI_MIN_UNTITLED_USER_MESSAGE_COUNT = 2
const STATE_DB_BUSY_TIMEOUT_MS = 500

const SOURCE_LABELS: Record<string, string> = {
  acp: 'ACP', api_server: 'API', cli: 'CLI', cron: 'Cron', discord: 'Discord', email: 'Email', kanban: 'Kanban', wecom: 'WeCom', wecom_callback: 'WeCom Callback',
  slack: 'Slack', telegram: 'Telegram', tool: 'Tool', tui: 'TUI', webhook: 'Webhook', webui: 'WebUI', weixin: 'Weixin', matrix: 'Matrix', signal: 'Signal',
}

const lower = (v: unknown): string => str(v).trim().toLowerCase()

/** Python `normalize_agent_session_source`: the durable `{raw_source, session_source, source_label}` contract. */
export function normalizeAgentSessionSource(rawSource: unknown): { raw_source: string | null; session_source: string; source_label: string } {
  const raw = lower(rawSource) || 'unknown'
  let sessionSource: string
  if (raw === 'webui') sessionSource = 'webui'
  else if (['acp', 'cli', 'tui'].includes(raw)) sessionSource = 'cli'
  else if (MESSAGING_SOURCES.has(raw)) sessionSource = 'messaging'
  else if (raw === 'cron') sessionSource = 'cron'
  else if (raw === 'webhook') sessionSource = 'webhook'
  else if (raw === 'kanban') sessionSource = 'kanban'
  else if (raw === 'tool') sessionSource = 'tool'
  else if (raw === 'api_server') sessionSource = 'api'
  else sessionSource = 'other'
  const label = SOURCE_LABELS[raw] ?? (raw === 'unknown' ? 'Agent' : raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
  return { raw_source: raw === 'unknown' ? null : raw, session_source: sessionSource, source_label: label }
}

const positiveInt = (v: unknown): number => { const n = Number.parseFloat(str(v)); return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0 }
const score = (...values: unknown[]): number => { for (const v of values) { if (v === null || v === undefined || v === '') continue; const n = Number.parseFloat(str(v)); if (Number.isFinite(n)) return n } return 0 }

function countUserTurns(row: Dict): number {
  const explicit = row.actual_user_message_count ?? row.user_message_count
  if (explicit !== null && explicit !== undefined) return positiveInt(explicit)
  const messages = row.messages
  return Array.isArray(messages) ? messages.filter((m) => lower(m && typeof m === 'object' ? (m as Dict).role : m) === 'user').length : 0
}

function hasCliLineage(row: Dict): boolean {
  return positiveInt(row._compression_segment_count) > 1 || Boolean(row._lineage_root_id)
}

/** Python `is_cli_session_row`: rows that get the CLI-imported treatment. */
export function isCliSessionRow(row: Dict): boolean {
  const source = lower(row.session_source)
  const sourceTag = lower(row.source_tag)
  const rawSource = lower(row.raw_source)
  const sourceName = lower(row.source)
  const sourceLabel = lower(row.source_label)
  const all = new Set([source, sourceTag, rawSource, sourceName, sourceLabel])
  if (all.has('webui')) return false
  const nonCli = new Set([...MESSAGING_SOURCES, 'cron', 'webhook', 'kanban', 'tool', 'api', 'api_server', 'subagent'])
  for (const v of all) if (v && nonCli.has(v)) return false
  if (source === 'messaging') return false
  if (source === 'cli') return true
  if (source === 'external_agent' || source === 'external-agent') return true
  const interactive = new Set(['acp', 'cli', 'tui'])
  if ([sourceTag, rawSource, sourceName, sourceLabel].some((v) => interactive.has(v))) return true
  return Boolean(row.is_cli_session) && ![source, sourceTag, rawSource, sourceName].some((v) => MESSAGING_SOURCES.has(v)) && looksLikeDefaultCliTitle(row)
}

/** Python `is_cli_session_row_visible`. */
export function isCliSessionRowVisible(row: Dict): boolean {
  if (!isCliSessionRow(row)) return true
  const actual = positiveInt(row.actual_message_count)
  const messageCount = actual || positiveInt(row.message_count)
  if (messageCount <= 0) return false
  if (actual > 0 && countUserTurns(row) > 0 && (row.ended_at === null || row.ended_at === undefined) && !row.end_reason) return true
  const interactive = new Set([row.source, row.source_tag, row.raw_source, row.source_label].map(normalizeSourceName))
  if (interactive.has('tui')) return true
  if (interactive.has('acp')) return countUserTurns(row) > 0
  if (hasCliLineage(row)) return true
  if (!looksLikeDefaultCliTitle(row)) return true
  return countUserTurns(row) >= CLI_MIN_UNTITLED_USER_MESSAGE_COUNT
}

// ── compression-chain projection ─────────────────────────────────────────

/** The Agent's `_CHAIN_CAP`: the most hops a walk along a compression lineage takes. Its visited check stops a cycle sooner. */
const COMPRESSION_CHAIN_CAP = 1000

function isContinuationSession(parent: Dict | undefined, child: Dict | undefined): boolean {
  if (!parent || !child) return false
  if (lower(child.session_source) === 'fork') return false
  const parentSource = lower(parent.source)
  const childSource = lower(child.source)
  if (parentSource && childSource && parentSource !== childSource) return false
  if (!['compression', 'cli_close'].includes(str(parent.end_reason))) return false
  const endedAt = parent.ended_at
  if (endedAt === null || endedAt === undefined) return true
  const started = Number.parseFloat(str(child.started_at || 0))
  const ended = Number.parseFloat(str(endedAt))
  return Number.isFinite(started) && Number.isFinite(ended) && started + 1.0 >= ended
}

function continuationRootId(rowsById: Map<string, Dict>, sessionId: string | null): string | null {
  if (!sessionId) return null
  let rootId = sessionId
  let currentId = rootId
  const seen = new Set([currentId])
  for (let i = 0; i <= rowsById.size; i += 1) {
    const current = rowsById.get(currentId)
    const parentId = str(current?.parent_session_id)
    const parent = parentId ? rowsById.get(parentId) : undefined
    if (!parent || !isContinuationSession(parent, current)) return rootId
    if (seen.has(parentId)) return rootId
    rootId = parentId
    currentId = parentId
    seen.add(currentId)
  }
  return rootId
}

/** Python `_project_agent_session_rows`: collapse compression chains into one sidebar row pointing at the freshest importable tip. */
export function projectAgentSessionRows(rows: Dict[]): Dict[] {
  const rowsById = new Map(rows.map((r) => [str(r.id), r]))
  const childrenByParent = new Map<string, Dict[]>()
  const continuationChildIds = new Set<string>()
  for (const row of rows) {
    const parentId = str(row.parent_session_id)
    if (!parentId) continue
    const list = childrenByParent.get(parentId) ?? []
    list.push(row)
    childrenByParent.set(parentId, list)
    const parent = rowsById.get(parentId)
    if (isContinuationSession(parent, row)) continuationChildIds.add(str(row.id))
    else {
      row.relationship_type = 'child_session'
      row.parent_title = parent?.title ?? null
      row.parent_source = parent?.source ?? null
      const parentRoot = continuationRootId(rowsById, parentId)
      if (parentRoot) row._parent_lineage_root_id = parentRoot
    }
  }
  for (const children of childrenByParent.values()) children.sort((a, b) => score(b.started_at) - score(a.started_at))
  const compressionTip = (row: Dict): [Dict | null, number] => {
    let latest: Dict | null = positiveInt(row.actual_message_count) > 0 ? row : null
    let segments = 0
    let bestDepth = 1
    let bestScore = latest ? score(latest.last_activity, latest.started_at) : 0
    const stack: [Dict, number][] = [[row, 1]]
    const seen = new Set<string>()
    while (stack.length) {
      const [current, depth] = stack.pop()!
      const currentId = str(current.id)
      if (!currentId || seen.has(currentId)) continue
      seen.add(currentId)
      segments += 1
      const currentScore = score(current.last_activity, current.started_at)
      if (positiveInt(current.actual_message_count) > 0 && (currentScore > bestScore || (currentScore === bestScore && depth >= bestDepth))) {
        latest = current
        bestDepth = depth
        bestScore = currentScore
      }
      for (const child of childrenByParent.get(currentId) ?? []) {
        const childId = str(child.id)
        if (!childId || seen.has(childId) || !isContinuationSession(current, child)) continue
        stack.push([child, depth + 1])
      }
    }
    return [latest, Math.max(segments, 1)]
  }
  const projected: Dict[] = []
  for (const row of rows) {
    if (continuationChildIds.has(str(row.id))) continue
    let segments = 1
    let tip: Dict | null = row
    if (['compression', 'cli_close'].includes(str(row.end_reason))) [tip, segments] = compressionTip(row)
    if (!tip || positiveInt(tip.actual_message_count) <= 0) continue
    if (tip === row) { projected.push({ ...row }); continue }
    const merged: Dict = { ...row }
    for (const key of ['id', 'model', 'message_count', 'actual_message_count', 'actual_user_message_count', 'ended_at', 'end_reason', 'last_activity']) if (key in tip) merged[key] = tip[key]
    if (lower(tip.source) === 'tui') {
      if (tip.title) merged.title = tip.title
      if (tip.source) merged.source = tip.source
    } else {
      if (!merged.title) merged.title = tip.title
      if (!merged.source) merged.source = tip.source
    }
    merged._lineage_root_id = row.id
    merged._lineage_tip_id = tip.id
    merged._compression_segment_count = segments
    projected.push(merged)
  }
  projected.sort((a, b) => score(b.last_activity, b.started_at) - score(a.last_activity, a.started_at))
  return projected
}

// ── sqlite access ─────────────────────────────────────────────────────────

/** Python `open_state_db_readonly`: read-only URI open with a bounded busy timeout; the caller closes it. */
export function openStateDbReadonly(dbPath: string, busyTimeoutMs = STATE_DB_BUSY_TIMEOUT_MS): DatabaseSync {
  if (!existsSync(dbPath)) throw new Error(`agent state.db not found: ${dbPath}`)
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: busyTimeoutMs })
  return db
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
  } catch {
    return new Set()
  }
}

export interface ReadRowsOptions {
  limit?: number | null
  excludeSources?: readonly string[] | null
  includeSources?: readonly string[] | null
  log?: (line: string) => void
}

const warnedNoSourceColumn = new Set<string>()
let readDelayMs = 0

/** Test hook: each listing read (and each listing worker request) blocks its thread this long first, standing in for a slow `state.db` (TAL-920). */
export function setStateDbReadDelayForTests(ms: number): void { readDelayMs = ms }

/**
 * Python `read_importable_agent_session_rows`. The recency slice is bounded to
 * `limit * 8` candidates before the messages aggregate runs; subagent parents
 * already in the candidate set are re-added after the slice, so the result can
 * exceed `limit`. Missing-index self-heal is not attempted: this handle is
 * read-only, so the pre-aggregated join path serves databases without
 * `idx_messages_session` exactly as Python does when its heal fails.
 */
export function readImportableAgentSessionRows(dbPath: string, opts: ReadRowsOptions = {}): Dict[] {
  if (!existsSync(dbPath)) return []
  const limit = opts.limit === undefined ? 200 : opts.limit
  const exclude = opts.excludeSources === undefined ? ['cron', 'webui'] : opts.excludeSources
  const include = opts.includeSources ?? null
  if (readDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, readDelayMs)
  const db = openStateDbReadonly(dbPath)
  try {
    const sessionCols = tableColumns(db, 'sessions')
    const messageCols = tableColumns(db, 'messages')
    if (!sessionCols.has('source')) {
      if (!warnedNoSourceColumn.has(dbPath)) {
        warnedNoSourceColumn.add(dbPath)
        opts.log?.(`[webui] agent session listing skipped: state.db at ${dbPath} has no 'source' column (older hermes-agent?). Agent sessions unavailable. Upgrade hermes-agent to fix this.`)
      }
      return []
    }
    const col = (name: string): string => (sessionCols.has(name) ? `s.${name}` : `NULL AS ${name}`)
    const messagesHasSessionId = messageCols.has('session_id')
    const messagesHasTimestamp = messageCols.has('timestamp')
    const countCol = messageCols.has('id') ? 'id' : 'session_id'
    let messagesIndexPresent = false
    let userMessagesIndexPresent = false
    if (messagesHasSessionId && messagesHasTimestamp) {
      try {
        const indexes = new Set((db.prepare('PRAGMA index_list(messages)').all() as { name: string }[]).map((r) => r.name))
        messagesIndexPresent = indexes.has('idx_messages_session')
        userMessagesIndexPresent = indexes.has('idx_messages_session_user')
      } catch { messagesIndexPresent = false }
    }
    let actualCountExpr: string
    let userCountExpr: string
    let lastActivityExpr: string
    let joinClause = ''
    let groupByClause = ''
    if (messagesHasSessionId) {
      if (messagesIndexPresent) {
        actualCountExpr = 'CASE WHEN NOT EXISTS(SELECT 1 FROM messages am WHERE am.session_id = s.id) THEN 0 WHEN COALESCE(s.message_count, 0) > 0 THEN s.message_count ELSE (SELECT COUNT(*) FROM (SELECT 1 FROM messages ac WHERE ac.session_id = s.id LIMIT 2)) END'
        if (messageCols.has('role')) {
          userCountExpr = userMessagesIndexPresent
            ? "(SELECT COUNT(*) FROM (SELECT 1 FROM messages um WHERE um.session_id = s.id AND um.role = 'user' LIMIT 2))"
            : "EXISTS(SELECT 1 FROM messages um WHERE um.session_id = s.id AND LOWER(um.role) = 'user')"
        } else userCountExpr = actualCountExpr
        lastActivityExpr = messagesHasTimestamp ? '(SELECT MAX(lm.timestamp) FROM messages lm WHERE lm.session_id = s.id)' : 'NULL'
      } else {
        actualCountExpr = `COUNT(m.${countCol})`
        userCountExpr = messageCols.has('role') ? "EXISTS(SELECT 1 FROM messages um WHERE um.session_id = s.id AND LOWER(um.role) = 'user')" : `COUNT(m.${countCol})`
        lastActivityExpr = messagesHasTimestamp ? 'MAX(m.timestamp)' : 'NULL'
        joinClause = 'LEFT JOIN messages m ON m.session_id = s.id'
        groupByClause = 'GROUP BY s.id'
      }
    } else {
      actualCountExpr = 's.message_count'
      userCountExpr = 's.message_count'
      lastActivityExpr = 'NULL'
    }
    let orderBy = 'ORDER BY s.started_at DESC'
    let latestMessagesCte: string | null = null
    let candidateOrder = 'ORDER BY s.started_at DESC'
    const where = ['s.source IS NOT NULL']
    const params: string[] = []
    const included = (include ?? []).map(String).filter(Boolean)
    if (included.length) { where.push(`s.source IN (${included.map(() => '?').join(', ')})`); params.push(...included) }
    const excluded = (exclude ?? []).map(String).filter(Boolean)
    if (excluded.length) { where.push(`s.source NOT IN (${excluded.map(() => '?').join(', ')})`); params.push(...excluded) }
    const preaggregated = messagesHasSessionId && messagesHasTimestamp && included.length === 1 && included[0] === 'cron' && !messagesIndexPresent
    if (preaggregated) {
      orderBy = 'ORDER BY COALESCE(MAX(m.timestamp), s.started_at) DESC'
      latestMessagesCte = 'latest_messages AS (SELECT mx.session_id AS session_id, MAX(mx.timestamp) AS last_message_at FROM messages mx GROUP BY mx.session_id)'
      candidateOrder = 'ORDER BY COALESCE(lm.last_message_at, s.started_at) DESC, s.started_at DESC'
    } else if (messagesHasSessionId && messagesHasTimestamp) {
      orderBy = messagesIndexPresent ? 'ORDER BY COALESCE(last_activity, s.started_at) DESC' : 'ORDER BY COALESCE(MAX(m.timestamp), s.started_at) DESC'
      candidateOrder = 'ORDER BY COALESCE((SELECT MAX(mx.timestamp) FROM messages mx WHERE mx.session_id = s.id), s.started_at) DESC, s.started_at DESC'
    }
    const selectSql = `SELECT s.id, s.title, s.model, s.message_count, s.started_at, s.source, ${['session_source', 'user_id', 'chat_id', 'chat_type', 'thread_id', 'session_key', 'origin_chat_id', 'origin_user_id', 'platform', 'parent_session_id', 'ended_at', 'end_reason'].map(col).join(', ')}, ${actualCountExpr} AS actual_message_count, ${userCountExpr} AS actual_user_message_count, ${lastActivityExpr} AS last_activity`
    let raw: Dict[]
    if (limit !== null) {
      const resultLimit = Math.max(0, Math.trunc(limit))
      if (resultLimit === 0) return []
      const candidateLimit = Math.max(resultLimit * 8, resultLimit)
      const candidateCte = latestMessagesCte
        ? `WITH ${latestMessagesCte}, candidates AS (SELECT s.id FROM sessions s LEFT JOIN latest_messages lm ON lm.session_id = s.id WHERE ${where.join(' AND ')} ${candidateOrder} LIMIT ?)`
        : `WITH candidates AS (SELECT s.id FROM sessions s WHERE ${where.join(' AND ')} ${candidateOrder} LIMIT ?)`
      raw = db.prepare(`${candidateCte} ${selectSql} FROM sessions s JOIN candidates c ON c.id = s.id ${joinClause} ${groupByClause} ${orderBy}`).all(...params, candidateLimit)
    } else {
      raw = db.prepare(`${selectSql} FROM sessions s ${joinClause} WHERE ${where.join(' AND ')} ${groupByClause} ${orderBy}`).all(...params)
    }
    let projected = projectAgentSessionRows(raw.map((r) => ({ ...r })))
    projected = projected.map((r) => ({ ...r, ...normalizeAgentSessionSource(r.source) }))
    projected = projected.filter(isCliSessionRowVisible)
    if (limit === null) return projected
    const selected = projected.slice(0, Math.max(0, Math.trunc(limit)))
    const have = new Set(selected.map((r) => str(r.id)))
    const byId = new Map(projected.filter((r) => r.id).map((r) => [str(r.id), r]))
    const pending = [...selected]
    while (pending.length) {
      const row = pending.pop()!
      if (lower(row.raw_source || row.source) !== 'subagent') continue
      const parentId = str(row.parent_session_id)
      if (!parentId || have.has(parentId)) continue
      const parent = byId.get(parentId)
      if (!parent || lower(parent.raw_source || parent.source) !== 'subagent') continue
      selected.push(parent)
      have.add(parentId)
      pending.push(parent)
    }
    return selected
  } finally {
    db.close()
  }
}

/** Python `agent_session_rows_existing`: batch existence probe; assumes present on any failure so nothing is pruned by mistake. */
export function agentSessionRowsExisting(dbPath: string, sessionIds: Iterable<string>): Set<string> {
  const wanted = new Set([...sessionIds].map((s) => s.trim()).filter(Boolean))
  if (!wanted.size || !existsSync(dbPath)) return wanted
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return wanted }
  try {
    if (!tableColumns(db, 'sessions').has('id')) return wanted
    const existing = new Set<string>()
    const ids = [...wanted]
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const row of db.prepare(`SELECT id FROM sessions WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { id: string }[]) existing.add(row.id)
    }
    return existing
  } catch {
    return wanted
  } finally {
    db.close()
  }
}

export interface CronSessionInfo { session_id: string; message_count: number | null }

/**
 * Python `_latest_cron_session_info_for_jobs`: the newest-started cron session for each completed job. A session id
 * belongs to the job with the longest matching `cron_{job_id}_` prefix, so `a` never claims `a_b`'s sessions. A
 * missing, locked, or unrecognized state.db answers an empty map; callers send no enrichment.
 */
export function latestCronSessionInfo(dbPath: string, jobIds: Iterable<string>, completedIds: Iterable<string>): Map<string, CronSessionInfo> {
  const found = new Map<string, CronSessionInfo>()
  const ids = [...new Set([...jobIds].map((id) => id.trim()).filter(Boolean))]
  const wanted = new Set([...completedIds].map((id) => id.trim()).filter(Boolean))
  if (!ids.length || !wanted.size || !existsSync(dbPath)) return found
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return found }
  try {
    const cols = tableColumns(db, 'sessions')
    if (!cols.has('id') || !cols.has('source')) return found
    const count = cols.has('message_count') ? 's.message_count' : 'NULL'
    const order = cols.has('started_at') ? 'COALESCE(s.started_at, 0) DESC, s.id DESC' : 's.id DESC'
    const rows = db.prepare(`SELECT s.id AS id, ${count} AS message_count FROM sessions s WHERE LOWER(COALESCE(s.source, '')) = 'cron' ORDER BY ${order}`).all() as { id: unknown; message_count: unknown }[]
    for (const row of rows) {
      const sid = typeof row.id === 'string' ? row.id : ''
      const owner = ids.filter((id) => sid.startsWith(`cron_${id}_`)).reduce<string | null>((best, id) => (best === null || id.length > best.length ? id : best), null)
      if (owner === null || !wanted.has(owner) || found.has(owner)) continue
      found.set(owner, { session_id: sid, message_count: Number.isFinite(Number(row.message_count)) && row.message_count !== null ? Math.trunc(Number(row.message_count)) : null })
      if (found.size === wanted.size) break
    }
    return found
  } catch {
    return new Map()
  } finally {
    db.close()
  }
}

/**
 * TAL-358: the `sessions.source` owner of each present id, in one chunked read; a Kanban-owned lineage answers `kanban`
 * (TAL-793). A missing state.db (or one without a `source` column) owns nothing; an unreadable one answers null, so
 * callers fail closed on an unknown owner.
 */
export function stateDbSessionSources(dbPath: string, sessionIds: Iterable<string>): Map<string, string> | null {
  const sources = new Map<string, string>()
  const ids = [...new Set([...sessionIds].map((s) => s.trim()).filter(Boolean))]
  if (!ids.length || !existsSync(dbPath)) return sources
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return null }
  try {
    const cols = tableColumns(db, 'sessions')
    if (!cols.has('id') || !cols.has('source')) return sources
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const row of db.prepare(`SELECT id, source FROM sessions WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { id: string; source: unknown }[]) sources.set(row.id, str(row.source))
    }
    for (const id of kanbanOwnedIds(db, cols, [...sources.keys()])) sources.set(id, 'kanban')
    return sources
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Python `_is_explicit_fork_child_row`: a tool child, or a branch/delegate (`includeReset`: also reset) fork of its parent. */
function isExplicitForkChild(row: Dict, includeReset: boolean): boolean {
  if (str(row.source) === 'tool') return true
  let cfg: unknown = row.model_config
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { return false } }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false
  const c = cfg as Dict
  const markers = [c._branched_from, c._delegate_from, ...(includeReset ? [c._reset_from] : [])]
  const parentId = row.parent_session_id
  return parentId ? markers.includes(parentId) : markers.some((m) => m !== undefined && m !== null)
}

/**
 * Python `_resume_lineage_ids`: `sid` and the compression ancestors a resume loads, root first. Each hop's parent ended
 * `compression` and the child is no branch, reset, delegate or tool fork. The walk stops at a cycle or the Agent's
 * 1000-hop `_CHAIN_CAP`; without the lineage columns it is `[sid]`.
 */
function resumeLineageWalker(db: DatabaseSync, cols: Set<string>): (sid: string) => string[] {
  if (!['parent_session_id', 'end_reason'].every((c) => cols.has(c))) return (sid) => [sid]
  const select = db.prepare(`SELECT id, source, parent_session_id, end_reason, ${cols.has('model_config') ? 'model_config' : 'NULL AS model_config'} FROM sessions WHERE id = ?`)
  return (sid) => {
    const chain = [sid]
    let current = select.get(sid) as Dict | undefined
    if (!current || isExplicitForkChild(current, false)) return chain
    while (chain.length < 1000) {
      const parentId = str(current.parent_session_id)
      if (!parentId || chain.includes(parentId) || isExplicitForkChild(current, true)) break
      const parent = select.get(parentId) as Dict | undefined
      if (str(parent?.end_reason) !== 'compression') break
      chain.push(parentId)
      current = parent!
    }
    return chain.reverse()
  }
}

/**
 * TAL-793 (Agent `is_kanban_owned_session`): the `ids` whose compression lineage has a `kanban` `source` or
 * `created_source` (schema v31; `source` alone decides before it), a Kanban worker's transcript only its dispatcher continues.
 */
function kanbanOwnedIds(db: DatabaseSync, cols: Set<string>, ids: string[]): string[] {
  if (!ids.length) return []
  const walk = resumeLineageWalker(db, cols)
  const lineages = ids.map(walk)
  const segments = [...new Set(lineages.flat())]
  const match = cols.has('created_source') ? "(source = 'kanban' OR created_source = 'kanban')" : "source = 'kanban'"
  const kanban = new Set<string>()
  for (let i = 0; i < segments.length; i += 500) {
    const chunk = segments.slice(i, i + 500)
    for (const row of db.prepare(`SELECT id FROM sessions WHERE id IN (${chunk.map(() => '?').join(',')}) AND ${match}`).all(...chunk) as { id: string }[]) kanban.add(row.id)
  }
  return ids.filter((_, i) => lineages[i]!.some((sid) => kanban.has(sid)))
}

/** Python `state_db_has_session`: true only when `sid` is a row of the sessions table; a missing or unreadable db is false. */
export function stateDbHasSession(dbPath: string, sid: string): boolean {
  const id = sid.trim()
  if (!id || !existsSync(dbPath)) return false
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return false }
  try {
    if (!tableColumns(db, 'sessions').has('id')) return false
    return db.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1').get(id) !== undefined
  } catch {
    return false
  } finally {
    db.close()
  }
}

/**
 * Python `_cheap_change_fingerprint`: `MAX(rowid)` of both tables, the file
 * stamps of the DB and its WAL, and the SQLite change counter (header bytes
 * 24..28). Returns null when unreadable so the caller projects instead.
 */
export function cheapChangeFingerprint(dbPath: string, onError?: (reason: string, error: unknown) => void): string | null {
  try {
    const parts: unknown[] = []
    const db = openStateDbReadonly(dbPath)
    try {
      for (const table of ['sessions', 'messages']) {
        try { parts.push((db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() as { m: number | null } | undefined)?.m ?? null) } catch { parts.push(null) }
      }
    } finally {
      db.close()
    }
    for (const path of [dbPath, `${dbPath}-wal`]) {
      try { const st = statSync(path, { bigint: true }); parts.push([Number(st.size), st.mtimeNs.toString()]) } catch { parts.push(null) }
    }
    try {
      const fd = openSync(dbPath, 'r')
      try {
        const header = Buffer.alloc(28)
        const n = readSync(fd, header, 0, 28, 0)
        parts.push(n >= 28 ? header.readUInt32BE(24) : null)
      } finally { closeSync(fd) }
    } catch { parts.push(null) }
    return JSON.stringify(parts)
  } catch (error) {
    onError?.('change check failed', error)
    return null
  }
}

// ── off-thread listing (TAL-920) ──────────────────────────────────────────

type ListingCall =
  | { op: 'rows'; dbPath: string; opts: Omit<ReadRowsOptions, 'log'> }
  | { op: 'fingerprint'; dbPath: string }
  | { op: 'sources' | 'existing'; dbPath: string; ids: string[] }
  | { op: 'crash' }
/** A request to the listing worker; `delayMs` carries the test read delay across the thread boundary. */
export type StateDbWorkerRequest = ListingCall & { id: number; delayMs: number }
/** The call's result or error message, plus the log lines and `[reason, message]` failures it reported in the worker. */
export interface StateDbWorkerReply { id: number; value?: unknown; error?: string; logs: string[]; failures: [string, string][] }

interface PendingCall { resolve: (reply: StateDbWorkerReply) => void; reject: (error: Error) => void }
interface ListingWorker { worker: Worker; pending: Map<number, PendingCall> }

let listingWorker: ListingWorker | null = null
let nextCallId = 0
/** Set while `stopStateDbWorker` waits for the worker to exit; calls then reject instead of starting another worker. */
let stoppingWorker = false

/** Reject every call still waiting on `current` and forget it, so the next call starts a fresh worker. */
function retireListingWorker(current: ListingWorker, error: Error): void {
  if (listingWorker === current) listingWorker = null
  for (const call of current.pending.values()) call.reject(error)
  current.pending.clear()
}

/** The lazily started, long-lived listing worker; requests run one at a time in arrival order. */
function startedListingWorker(): ListingWorker {
  if (listingWorker) return listingWorker
  // Source runs (vitest) load the TypeScript worker; the build runs the compiled one beside this module.
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const current: ListingWorker = { worker: new Worker(new URL(`./state-db-worker.${ext}`, import.meta.url)), pending: new Map() }
  current.worker.unref()
  current.worker.on('message', (reply: StateDbWorkerReply) => {
    const call = current.pending.get(reply.id)
    if (!call) return
    current.pending.delete(reply.id)
    if (!current.pending.size) current.worker.unref()
    call.resolve(reply)
  })
  current.worker.on('error', (error: Error) => { retireListingWorker(current, error) })
  current.worker.on('exit', (code) => { retireListingWorker(current, new Error(`state.db worker exited with code ${String(code)}`)) })
  listingWorker = current
  return current
}

function callListingWorker(call: ListingCall): Promise<StateDbWorkerReply> {
  // A multi-read caller the stop interrupted goes on to its next read; that read must not restart the worker.
  if (stoppingWorker) return Promise.reject(new Error('state.db worker stopped'))
  const current = startedListingWorker()
  const id = ++nextCallId
  return new Promise((resolve, reject) => {
    current.pending.set(id, { resolve, reject })
    // A call in flight keeps the process alive until it settles; an idle worker never does.
    current.worker.ref()
    current.worker.postMessage({ ...call, id, delayMs: readDelayMs } satisfies StateDbWorkerRequest)
  })
}

/** `readImportableAgentSessionRows` on the listing worker, so a slow `state.db` never blocks the event loop. Rejects when the worker fails. */
export async function readImportableAgentSessionRowsAsync(dbPath: string, opts: ReadRowsOptions = {}): Promise<Dict[]> {
  const { log, ...query } = opts
  const reply = await callListingWorker({ op: 'rows', dbPath, opts: query })
  for (const line of reply.logs) log?.(line)
  if (reply.error !== undefined) throw new Error(reply.error)
  return reply.value as Dict[]
}

/** `cheapChangeFingerprint` on the listing worker; a worker failure reports as a failed change check. */
export async function cheapChangeFingerprintAsync(dbPath: string, onError?: (reason: string, error: unknown) => void): Promise<string | null> {
  let reply: StateDbWorkerReply
  try {
    reply = await callListingWorker({ op: 'fingerprint', dbPath })
  } catch (error) {
    onError?.('change check failed', error)
    return null
  }
  for (const [reason, message] of reply.failures) onError?.(reason, new Error(message))
  return reply.value as string | null
}

/** `stateDbSessionSources` on the listing worker; a worker failure is an unreadable state.db (null), so owners stay locked. */
export async function stateDbSessionSourcesAsync(dbPath: string, sessionIds: Iterable<string>): Promise<Map<string, string> | null> {
  try { return (await callListingWorker({ op: 'sources', dbPath, ids: [...sessionIds] })).value as Map<string, string> | null } catch { return null }
}

/** `agentSessionRowsExisting` on the listing worker; a worker failure assumes every row present, so nothing is pruned. */
export async function agentSessionRowsExistingAsync(dbPath: string, sessionIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...sessionIds]
  try { return (await callListingWorker({ op: 'existing', dbPath, ids })).value as Set<string> } catch { return new Set(ids.map((s) => s.trim()).filter(Boolean)) }
}

/** Test hook: the listing worker exits abruptly while this call is in flight. */
export function crashStateDbWorkerForTests(): Promise<unknown> {
  return callListingWorker({ op: 'crash' })
}

/** Stop the listing worker (server shutdown). Calls in flight reject; a later call starts a new worker. */
export async function stopStateDbWorker(): Promise<void> {
  const current = listingWorker
  if (!current) return
  stoppingWorker = true
  try {
    retireListingWorker(current, new Error('state.db worker stopped'))
    await current.worker.terminate()
  } finally {
    stoppingWorker = false
  }
}

// ── message reader ────────────────────────────────────────────────────────

const STATE_DB_CONTENT_JSON_PREFIX = '\0json:'
// `display_kind` / `display_metadata`: the Agent's own tag for rows it writes itself (steers, delivered notifications; TAL-371).
const OPTIONAL_MESSAGE_COLUMNS = ['tool_call_id', 'tool_calls', 'tool_name', 'reasoning', 'reasoning_details', 'codex_reasoning_items', 'reasoning_content', 'codex_message_items', 'api_content', 'display_kind', 'display_metadata'] as const
const JSON_MESSAGE_COLUMNS = new Set(['tool_calls', 'reasoning_details', 'codex_reasoning_items', 'codex_message_items', 'display_metadata'])

/** Python `_decode_state_db_content`: the Agent's sentinel-prefixed structured content, left untouched otherwise. */
function decodeStateDbContent(value: unknown): unknown {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value
  if (typeof text !== 'string' || !text.startsWith(STATE_DB_CONTENT_JSON_PREFIX)) return text
  try {
    const payload = text.slice(STATE_DB_CONTENT_JSON_PREFIX.length)
    let unsafeInteger = false
    const decoded: unknown = JSON.parse(payload, (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')) unsafeInteger = true
      return value
    })
    // Python keeps arbitrary-precision integers. Retain the JSON text rather than silently rounding any of them.
    return unsafeInteger ? payload : decoded
  } catch {
    return text
  }
}

function jsonLoadsIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** Python `_project_state_db_message`: one row → WebUI message (`tool_name → name`, empty optionals omitted). */
function projectStateDbMessage(row: Dict, hasId: boolean): Dict {
  const msg: Dict = { role: row.role, content: decodeStateDbContent(row.content), timestamp: row.timestamp }
  for (const col of OPTIONAL_MESSAGE_COLUMNS) {
    if (!(col in row)) continue
    const value = row[col]
    if (value === null || value === undefined || value === '') continue
    msg[col] = JSON_MESSAGE_COLUMNS.has(col) ? jsonLoadsIfString(value) : value
  }
  // TAL-493: the merge tells rows committed after the session's last read by this id.
  if (hasId && row.id !== null && row.id !== undefined) msg._state_db_row_id = row.id
  if (msg.role === 'tool' && msg.tool_name && !msg.name) msg.name = msg.tool_name
  return msg
}

/**
 * Python `get_state_db_session_messages(sid, stitch_continuations=True)`: the session's active rows in durable order,
 * walking compatible compression/close parents so a continued CLI conversation reads as one transcript.
 */
/** The state.db file's identity (inode and creation time); a recreated or replaced database gets a new one. */
function stateDbGeneration(dbPath: string): string | null {
  try { const st = statSync(dbPath); return `${String(st.ino)}:${String(st.birthtimeMs)}` } catch { return null }
}

// Agent v0.21.6's exact in-flight request wrapper. Unknown rewrites are not copy evidence.
const INFLIGHT_REPLAY_HEADER = '[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]'

/** The payload comparison ignores only the Agent's documented replay wrapper and dropped api_content. */
function replayPayload(row: Dict): { copyKey: string; replayKey: string; replay: boolean } {
  const message = projectStateDbMessage(row, false)
  delete message.timestamp
  const copyKey = JSON.stringify(message)
  let content = message.content
  let replay = false
  if (row.role === 'user') {
    if (typeof content === 'string') {
      replay = content.startsWith(`${INFLIGHT_REPLAY_HEADER}\n`)
      content = (replay ? content.slice(INFLIGHT_REPLAY_HEADER.length + 1) : content).trim()
    } else if (Array.isArray(content)) {
      // Multimodal replays prepend a text block and retain all original parts, including media.
      const parts: unknown[] = content
      let start = 0
      while (start < parts.length) {
        const first = parts[start]
        if (!first || typeof first !== 'object' || Array.isArray(first)) break
        const part = first as Dict
        if (part.type !== 'text' || part.text !== `${INFLIGHT_REPLAY_HEADER}\n` || Object.keys(part).some((k) => k !== 'type' && k !== 'text')) break
        start += 1
      }
      replay = start > 0
      content = parts.slice(start)
    }
  }
  message.content = content
  delete message.api_content // _reappend_inflight_user_task drops this stale model-facing sidecar.
  return { copyKey, replayKey: JSON.stringify(message), replay }
}

/**
 * Compare adjacent generations, never all rows of one UID with its oldest archive. The archive retains
 * authored payload changes even after active/compacted flags change. Only unchanged timestamp copies or
 * exact request restatements inherit identity; edits (including A -> B -> A) start at their own row ID.
 */
function replayIdentities(db: DatabaseSync, chain: string[], rows: Dict[], available: Set<string>): Map<number, { id: number; changed: boolean; sourceKey: string }> {
  const identities = new Map<number, { id: number; changed: boolean; sourceKey: string }>()
  // Tool-result text can be pruned without changing its tool-call identity; retain the existing rule.
  const uids = [...new Set(rows.filter((row) => row.role !== 'tool').map((row) => row.message_uid).filter((uid): uid is string => typeof uid === 'string' && uid.length > 0))]
  if (!uids.length) return identities
  const liveIds = new Set(rows.map((row) => row.id))
  type Previous = ReturnType<typeof replayPayload> & { identity: number; changed: boolean; sourceKey: string; timestamp: unknown; active: unknown; compacted: unknown }
  const previous = new Map<string, Previous>()
  const columns = ['id', 'message_uid', 'active', 'compacted', 'role', 'content', 'timestamp', ...OPTIONAL_MESSAGE_COLUMNS.filter((c) => available.has(c))]
  // One ordered scan of the selected sessions, filtering against a materialized UID set. Stream the rows;
  // memory holds only the preceding payload per live UID, not the accumulated archive. NULL/nonstandard
  // active flags take exactly the same path and do not depend on the Agent's partial active=1 UID index.
  const history = db.prepare(`SELECT ${columns.join(', ')} FROM messages WHERE session_id IN (${chain.map(() => '?').join(', ')}) AND message_uid IN (SELECT value FROM json_each(?)) ORDER BY id`)
  for (const row of history.iterate(...chain, JSON.stringify(uids)) as Iterable<Dict>) {
    const uid = row.message_uid as string
    const payload = replayPayload(row)
    const prior = previous.get(uid)
    const copy = payload.copyKey === prior?.copyKey && row.timestamp === prior.timestamp
    const restatement = prior && payload.replay && payload.replayKey === prior.replayKey && (prior.active !== 0 || prior.compacted === 1)
    const identity = prior && (copy || restatement) ? prior.identity : Number(row.id)
    const changed = prior ? (copy || restatement ? prior.changed : true) : false
    const sourceKey = prior && (copy || restatement) ? prior.sourceKey : stateDbMessageFingerprint(projectStateDbMessage(row, false))
    if (prior && row.role !== 'tool' && liveIds.has(row.id)) identities.set(Number(row.id), { id: identity, changed, sourceKey })
    previous.set(uid, { ...payload, identity, changed, sourceKey, timestamp: row.timestamp, active: row.active, compacted: row.compacted })
  }
  return identities
}

export interface StateDbRead { rows: Dict[]; idCapable: boolean; ok: boolean }

export function stateDbSessionMessages(dbPath: string, sid: string, opts: { stitch?: boolean } = {}): Dict[] {
  return stateDbSessionRead(dbPath, sid, opts).rows
}

/**
 * `stateDbSessionMessages`, whether the read succeeded (`ok`), and whether its `messages` table has an `id` column
 * (TAL-493: an empty id-capable read is a baseline of 0; a missing database or a failed read says nothing).
 */
export function stateDbSessionRead(dbPath: string, sid: string, opts: { stitch?: boolean; lineage?: string[] | null } = {}): StateDbRead {
  const none = { rows: [], idCapable: false, ok: false }
  const id = sid.trim()
  if (!id || !existsSync(dbPath)) return none
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return none }
  try {
    db.exec('BEGIN') // The live rows and their archived predecessors must describe one snapshot.
    const available = tableColumns(db, 'messages')
    if (!['role', 'content', 'timestamp'].every((c) => available.has(c))) return { ...none, ok: available.size > 0 }
    const hasId = available.has('id')
    const selected = [...(hasId ? ['id'] : []), ...(available.has('message_uid') ? ['message_uid'] : []), 'role', 'content', 'timestamp', ...OPTIONAL_MESSAGE_COLUMNS.filter((c) => available.has(c))]
    // TAL-529: an explicit lineage (the session and its compression continuations) replaces the parent walk.
    const chain = opts.lineage?.length ? [...opts.lineage] : [id]
    if (!opts.lineage?.length && (opts.stitch ?? true)) {
      const sessionCols = tableColumns(db, 'sessions')
      if (['parent_session_id', 'end_reason', 'started_at', 'source'].every((c) => sessionCols.has(c))) {
        const select = db.prepare('SELECT id, source, started_at, parent_session_id, ended_at, end_reason FROM sessions WHERE id = ?')
        let current = select.get(id) as Dict | undefined
        const seen = new Set([id])
        for (let hop = 0; hop < COMPRESSION_CHAIN_CAP && current; hop += 1) {
          const parentId = str(current.parent_session_id)
          if (!parentId || seen.has(parentId)) break
          const parent = select.get(parentId) as Dict | undefined
          if (!parent || !isContinuationSession(parent, current)) break
          chain.unshift(parentId)
          seen.add(parentId)
          current = parent
        }
      }
    }
    const activeClause = available.has('active') ? ' AND (active IS NULL OR active != 0)' : ''
    const order = hasId ? 'id' : 'timestamp'
    const rows = db.prepare(`SELECT ${selected.join(', ')}, session_id FROM messages WHERE session_id IN (${chain.map(() => '?').join(', ')})${activeClause} ORDER BY ${order} ASC`).all(...chain) as Dict[]
    const projected = rows.map((row) => projectStateDbMessage(row, hasId))
    // TAL-709: an in-place compaction archives the live rows and re-inserts each as a copy that keeps its role and timestamp
    // (content may be pruned). A copy takes the id of the oldest archived row it copies, so the merge sees a row it has
    // already read instead of a new one. Only a compaction archive (`compacted = 1`) vouches for a changed copy: a rewound
    // row (`compacted = 0`, also the compaction's carried tail) counts only for the same tool call or the same content, so
    // an edit that kept its timestamp stays new.
    if (hasId && available.has('active')) {
      // One indexed lookup per live row ((session_id, active, timestamp)): the archive is never loaded, however many
      // compactions it holds.
      const sameCall = available.has('tool_call_id') ? " AND COALESCE(a.tool_call_id, '') = COALESCE(m.tool_call_id, '')" : ''
      const vouched = [available.has('compacted') ? 'a.compacted = 1' : '', available.has('tool_call_id') ? 'm.tool_call_id IS NOT NULL' : '', 'a.content = m.content'].filter(Boolean).join(' OR ')
      const twins = db.prepare(`SELECT m.id AS id, MIN(a.id) AS twin FROM messages m JOIN messages a ON a.session_id = m.session_id AND a.active = 0 AND a.role = m.role AND a.timestamp = m.timestamp AND a.id < m.id${sameCall} WHERE m.session_id IN (${chain.map(() => '?').join(', ')}) AND (m.active IS NULL OR m.active != 0) AND (${vouched}) GROUP BY m.id`).all(...chain) as Dict[]
      const twinOf = new Map(twins.map((row) => [row.id, row.twin]))
      for (const [i, row] of rows.entries()) {
        const twin = twinOf.get(row.id)
        if (typeof twin === 'number') projected[i]!._state_db_row_id = twin
      }
    }
    if (hasId && ['message_uid', 'active', 'compacted'].every((c) => available.has(c))) {
      const identities = replayIdentities(db, chain, rows, available)
      for (const [i, row] of rows.entries()) {
        const identity = identities.get(Number(row.id))
        // A known changed generation overrides even a coincidental legacy timestamp twin.
        if (identity !== undefined) {
          projected[i]!._state_db_row_id = identity.id
          if (identity.id !== row.id) projected[i]!._state_db_source_key = identity.sourceKey
          if (identity.changed) projected[i]!._state_db_authored_change = true
        }
      }
    }
    // TAL-493: the database file's identity, so a marker taken in a replaced state.db is never applied to its successor.
    if (hasId) {
      const generation = stateDbGeneration(dbPath)
      for (const m of projected) m._state_db_generation = generation
    }
    return { rows: projected, idCapable: hasId, ok: true }
  } catch {
    return none
  } finally {
    db.close()
  }
}

/**
 * TAL-529: `sid` and each compression continuation the Agent rotated it to, down to the live tip (Python
 * `resolve_live_compression_tip`). The walk stops at the last unambiguous row: no continuation, several, a cycle, or
 * `COMPRESSION_CHAIN_CAP` hops. A missing or unreadable database is `[sid]`.
 */
export function stateDbCompressionLineage(dbPath: string, sid: string): string[] {
  const lineage = [sid.trim()]
  if (!lineage[0] || !existsSync(dbPath)) return lineage
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return lineage }
  try {
    const sessionCols = tableColumns(db, 'sessions')
    if (!['id', 'parent_session_id', 'end_reason', 'ended_at', 'started_at', 'source'].every((c) => sessionCols.has(c))) return lineage
    const sessionSource = sessionCols.has('session_source') ? 'session_source' : 'NULL AS session_source'
    const cols = `id, source, ${sessionSource}, started_at, parent_session_id, ended_at, end_reason`
    let current = db.prepare(`SELECT ${cols} FROM sessions WHERE id = ?`).get(lineage[0]) as Dict | undefined
    const children = db.prepare(`SELECT ${cols} FROM sessions WHERE parent_session_id = ?`)
    for (let hop = 0; hop < COMPRESSION_CHAIN_CAP && current; hop += 1) {
      const parent = current
      const next = (children.all(str(parent.id)) as Dict[]).filter((child) => isContinuationSession(parent, child))
      if (next.length !== 1 || lineage.includes(str(next[0]!.id))) break
      current = next[0]
      lineage.push(str(current!.id))
    }
    return lineage
  } catch {
    return lineage.slice(0, 1)
  } finally {
    db.close()
  }
}

function lineageReportRow(row: Dict, role: 'tip' | 'hidden_segment' | 'child_session'): Dict {
  const ended = row.ended_at ?? null
  return {
    session_id: row.id, role, title: row.title ?? null, source: row.source ?? null, started_at: row.started_at ?? null, updated_at: ended ?? row.started_at ?? null,
    end_reason: row.end_reason ?? null, active: ended === null, archived: false,
  }
}

const emptyLineageReport = (sid: string): Dict => ({
  mutation: false, found: false, session_id: sid, lineage_key: sid, tip_session_id: sid, total_segments: 0, materialized_segments: 0, segments: [], children: [], manual_review: false,
})

/**
 * Python `read_session_lineage_report`: a read-only report of `sid`'s compression lineage. The walk follows up to
 * `maxHops` continuation parents (the tip first, the root last), then lists each segment's non-continuation children,
 * newest first. A cycle, a hop limit hit, or a continuation off the walked path marks `manual_review`. A missing,
 * unreadable, or too-old database, or an unknown id, answers `found: false`.
 */
export function stateDbLineageReport(dbPath: string, rawSid: string, maxHops = COMPRESSION_CHAIN_CAP): Dict {
  const sid = rawSid.trim()
  if (!sid || !existsSync(dbPath)) return emptyLineageReport(sid)
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return emptyLineageReport(sid) }
  try {
    const cols = tableColumns(db, 'sessions')
    if (!['id', 'parent_session_id', 'end_reason'].every((c) => cols.has(c))) return emptyLineageReport(sid)
    const col = (name: string, fallback = 'NULL'): string => (cols.has(name) ? `s.${name}` : `${fallback} AS ${name}`)
    const select = `SELECT s.id, ${col('source')}, ${col('session_source')}, ${col('title')}, ${col('started_at', '0')}, s.parent_session_id, ${col('ended_at')}, s.end_reason FROM sessions s`
    const byId = db.prepare(`${select} WHERE s.id = ?`)
    const fetch = (id: unknown): Dict | null => (id ? (byId.get(str(id)) as Dict | undefined) ?? null : null)
    const target = fetch(sid)
    if (!target) return emptyLineageReport(sid)
    const segments = [target]
    const seen = new Set([sid])
    let manualReview = true
    for (let hop = 0; hop < maxHops; hop += 1) {
      const current = segments[segments.length - 1]!
      const parentId = str(current.parent_session_id)
      const parent = fetch(parentId)
      if (!parent || seen.has(parentId)) { manualReview = Boolean(parentId && seen.has(parentId)); break }
      if (!isContinuationSession(parent, current)) { manualReview = false; break }
      segments.push(parent)
      seen.add(parentId)
    }
    const segmentIds = segments.map((row) => str(row.id))
    const children = (db.prepare(`${select} WHERE s.parent_session_id IN (${segmentIds.map(() => '?').join(', ')})`).all(...segmentIds) as Dict[])
    const childRows: Dict[] = []
    for (const parent of segments) {
      const own = children.filter((child) => str(child.parent_session_id) === str(parent.id) && !seen.has(str(child.id)))
      own.sort((a, b) => (Number(b.started_at) || 0) - (Number(a.started_at) || 0))
      for (const child of own) {
        // A continuation off the walked path means a branched lineage or an older selected segment: flag it, list nothing.
        if (isContinuationSession(parent, child)) manualReview = true
        else childRows.push(child)
      }
    }
    return {
      mutation: false, found: true, session_id: sid, lineage_key: segments[segments.length - 1]!.id, tip_session_id: segments[0]!.id,
      total_segments: segments.length, materialized_segments: segments.length,
      segments: segments.map((row, idx) => lineageReportRow(row, idx === 0 ? 'tip' : 'hidden_segment')),
      children: childRows.map((row) => lineageReportRow(row, 'child_session')),
      manual_review: manualReview,
    }
  } catch {
    return emptyLineageReport(sid)
  } finally {
    db.close()
  }
}

/** The `sessions` row for `sid` (source and lifecycle columns), or null. */
export function stateDbSessionRow(dbPath: string, sid: string): Dict | null {
  const id = sid.trim()
  if (!id || !existsSync(dbPath)) return null
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return null }
  try {
    const cols = tableColumns(db, 'sessions')
    const wanted = ['id', 'source', 'title', 'model', 'cwd', 'started_at', 'ended_at', 'parent_session_id', 'end_reason'].filter((c) => cols.has(c))
    if (!wanted.includes('id')) return null
    return (db.prepare(`SELECT ${wanted.join(', ')} FROM sessions WHERE id = ?`).get(id) as Dict | undefined) ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/**
 * TAL-550 (Python `_handle_insights`): usage of the non-Web sessions active since `cutoff`, shaped like session index
 * entries. Activity is the latest of start, end, and last message, so a long-lived gateway session still counts.
 * `webui` rows mirror index sessions and are skipped; a missing column reads as empty and a missing or unreadable
 * state.db answers no rows.
 */
export function insightsSessionRows(dbPath: string, cutoff: number): Dict[] {
  if (!existsSync(dbPath)) return []
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return [] }
  try {
    const cols = tableColumns(db, 'sessions')
    if (!cols.has('id') || !cols.has('started_at')) return []
    const col = (name: string): string => (cols.has(name) ? `s.${name}` : 'NULL')
    const messageCols = tableColumns(db, 'messages')
    const hasMessages = messageCols.has('session_id') && messageCols.has('timestamp')
    let indexed = false
    try { indexed = hasMessages && (db.prepare('PRAGMA index_list(messages)').all() as { name: string }[]).some((r) => r.name === 'idx_messages_session') } catch { indexed = false }
    // Without the index a per-session lookup scans messages once per session; one grouped scan replaces it.
    const lastMessage = !hasMessages ? 'NULL' : indexed ? '(SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id)' : 'lm.last_message_at'
    const join = hasMessages && !indexed ? 'LEFT JOIN (SELECT session_id, MAX(timestamp) AS last_message_at FROM messages GROUP BY session_id) lm ON lm.session_id = s.id' : ''
    const source = cols.has('source') ? "LOWER(COALESCE(s.source, '')) != 'webui'" : '1'
    const rows = db.prepare(`SELECT * FROM (SELECT s.id AS id, ${col('model')} AS model, ${col('message_count')} AS message_count, ${col('input_tokens')} AS input_tokens,
      ${col('output_tokens')} AS output_tokens, ${col('cache_read_tokens')} AS cache_read_tokens, ${col('estimated_cost_usd')} AS estimated_cost_usd, s.started_at AS started_at,
      MAX(COALESCE(s.started_at, 0), COALESCE(${col('ended_at')}, 0), COALESCE(${lastMessage}, 0)) AS last_activity
      FROM sessions s ${join} WHERE ${source}) WHERE last_activity >= ?`).all(cutoff) as Dict[]
    return rows.map((r) => ({
      session_id: str(r.id), model: r.model, message_count: r.message_count, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens, estimated_cost: r.estimated_cost_usd, created_at: r.started_at, updated_at: r.last_activity,
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** A state.db `timestamp` in unix seconds: a number, or an ISO-8601 string (Python `fromisoformat`); null when unreadable. */
export function stateDbTimestampSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value.trim())
  return Number.isFinite(ms) ? ms / 1000 : null
}

/** Python `CONVERSATION_ROUND_THRESHOLD`: the handoff dock is offered from this many rounds. */
export const CONVERSATION_ROUND_THRESHOLD = 10

/**
 * Python `count_conversation_rounds` (TAL-258): a round is a user message answered by the assistant; consecutive user
 * messages merge into one. With `since`, only rows stamped after it count (an unreadable stamp still counts). A missing
 * or unreadable database is 0.
 */
export function countConversationRounds(dbPath: string, sid: string, since: number | null = null): number {
  if (!existsSync(dbPath)) return 0
  let rows: Dict[]
  try {
    const db = openStateDbReadonly(dbPath)
    try { rows = db.prepare('SELECT role, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sid) } finally { db.close() }
  } catch {
    return 0
  }
  let rounds = 0
  let seenUser = false
  let answered = false
  for (const row of rows) {
    if (since !== null) {
      const ts = stateDbTimestampSeconds(row.timestamp)
      if (ts !== null && ts <= since) continue
    }
    const role = lower(row.role)
    if (role === 'user') {
      if (seenUser && answered) { rounds += 1; answered = false }
      seenUser = true
    } else if (role === 'assistant' && seenUser) {
      answered = true
    }
  }
  return seenUser && answered ? rounds + 1 : rounds
}

/** The content of the session's newest row when that row is a `tool` row (the handoff marker's tail dedupe, TAL-258); else null. */
export function stateDbTailToolContent(dbPath: string, sid: string): string | null {
  if (!existsSync(dbPath)) return null
  try {
    const db = openStateDbReadonly(dbPath)
    try {
      const row = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sid) as Dict | undefined
      const content = row?.role === 'tool' ? decodeStateDbContent(row.content) : null
      return typeof content === 'string' ? content : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}
