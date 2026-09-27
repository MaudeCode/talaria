/**
 * Read-only projection of the Agent's `state.db` (Python `api/agent_sessions.py`):
 * importable agent session rows with compression-chain collapse, CLI visibility
 * rules, the O(1) change fingerprint used by the gateway watcher, and existence
 * probes. Uses `node:sqlite`; every read opens a short-lived read-only handle
 * with a bounded busy timeout, and no path here ever writes to the database.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { str } from '../util.js'

export type Dict = Record<string, unknown>

export const MESSAGING_SOURCES = new Set(['discord', 'email', 'wecom', 'wecom_callback', 'slack', 'telegram', 'weixin', 'matrix', 'signal'])
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

function normalizeSourceName(value: unknown): string {
  let source = lower(value)
  if (source.endsWith(' session')) source = source.slice(0, -' session'.length).trim()
  return source
}

function looksLikeDefaultCliTitle(row: Dict): boolean {
  const title = lower(row.title)
  if (!title || title === 'untitled' || title === 'cli' || title === 'cli session') return true
  const candidates = new Set([row.source, row.session_source, row.source_tag, row.raw_source, row.source_label].map(normalizeSourceName).filter(Boolean))
  candidates.add('cli')
  return [...candidates].some((c) => title === `${c} session`)
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

/**
 * TAL-358: the `sessions.source` owner of each present id, in one chunked read. A missing state.db (or one without a
 * `source` column) owns nothing; an unreadable one answers null, so callers fail closed on an unknown owner.
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
    return sources
  } catch {
    return null
  } finally {
    db.close()
  }
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

// ── message reader ────────────────────────────────────────────────────────

const STATE_DB_CONTENT_JSON_PREFIX = '\0json:'
const OPTIONAL_MESSAGE_COLUMNS = ['tool_call_id', 'tool_calls', 'tool_name', 'reasoning', 'reasoning_details', 'codex_reasoning_items', 'reasoning_content', 'codex_message_items', 'api_content'] as const
const JSON_MESSAGE_COLUMNS = new Set(['tool_calls', 'reasoning_details', 'codex_reasoning_items', 'codex_message_items'])

/** Python `_decode_state_db_content`: the Agent's sentinel-prefixed structured content, left untouched otherwise. */
function decodeStateDbContent(value: unknown): unknown {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value
  if (typeof text !== 'string' || !text.startsWith(STATE_DB_CONTENT_JSON_PREFIX)) return text
  try {
    const decoded: unknown = JSON.parse(text.slice(STATE_DB_CONTENT_JSON_PREFIX.length))
    return Array.isArray(decoded) ? decoded : text
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
  if (hasId && row.id !== null && row.id !== undefined && typeof msg.api_content === 'string' && msg.api_content) msg._state_db_row_id = row.id
  if (msg.role === 'tool' && msg.tool_name && !msg.name) msg.name = msg.tool_name
  return msg
}

/**
 * Python `get_state_db_session_messages(sid, stitch_continuations=True)`: the session's active rows in durable order,
 * walking compatible compression/close parents so a continued CLI conversation reads as one transcript.
 */
export function stateDbSessionMessages(dbPath: string, sid: string, opts: { stitch?: boolean } = {}): Dict[] {
  const id = sid.trim()
  if (!id || !existsSync(dbPath)) return []
  let db: DatabaseSync
  try { db = openStateDbReadonly(dbPath) } catch { return [] }
  try {
    const available = tableColumns(db, 'messages')
    if (!['role', 'content', 'timestamp'].every((c) => available.has(c))) return []
    const hasId = available.has('id')
    const selected = [...(hasId ? ['id'] : []), 'role', 'content', 'timestamp', ...OPTIONAL_MESSAGE_COLUMNS.filter((c) => available.has(c))]
    const chain = [id]
    if (opts.stitch ?? true) {
      const sessionCols = tableColumns(db, 'sessions')
      if (['parent_session_id', 'end_reason', 'started_at', 'source'].every((c) => sessionCols.has(c))) {
        const select = db.prepare('SELECT id, source, started_at, parent_session_id, ended_at, end_reason FROM sessions WHERE id = ?')
        let current = select.get(id) as Dict | undefined
        const seen = new Set([id])
        for (let hop = 0; hop < 20 && current; hop += 1) {
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
    return rows.map((row) => projectStateDbMessage(row, hasId))
  } catch {
    return []
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
