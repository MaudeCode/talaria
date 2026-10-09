/**
 * Session recovery audit and safe repair (Python `api/session_recovery.py`, TAL-259). The store writes
 * `<sid>.json.bak` before any save that shrinks a transcript; the audit classifies every backup, index row, WebUI-origin
 * state.db row without a sidecar, and pending turn-journal entry as `repairable` or `unsafe_to_repair`, and safe repair
 * restores, materializes, and reindexes only what is repairable.
 *
 * A backup never undoes a deliberate shrink: clear, manual compression, and truncate/retry/undo each leave provenance on
 * the live sidecar (`clear_generation`, the compression anchor, `intentional_shrink_generation`). A backup older than the
 * `recovery_stamping_since` marker may predate that provenance, so next to a readable live transcript it goes to manual
 * review instead.
 */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RecoveryAudit, RecoveryAuditItem, RecoveryRepair } from '@maudecode/talaria-web-contracts'
import { atomicWriteText, writeFully } from '../fs/atomic.js'
import { str } from '../util.js'
import { isContextCompressionMarker } from './merge.js'
import { isSafeSessionId, Session, type Message } from './session.js'
import { normalizeAgentSessionSource, openStateDbReadonly } from './state-db.js'
import type { SessionStore } from './store.js'

type Dict = Record<string, unknown>
type RecoveryItem = RecoveryAuditItem
type RecoveryCategory = RecoveryItem['category']

export interface RecoveryDeps {
  store: SessionStore
  /** The active profile's `state.db`; recovered sessions belong to `profile`. */
  stateDbPath: string
  profile: string
  stampingSince: number
  log: (line: string) => void
}

const STAMPING_MARKER = 'recovery_stamping_since'
/** Python `STATE_DB_RECOVERY_BUSY_TIMEOUT_MS`: a recovery scan waits out a writer rather than read a lock as "nothing missing". */
const STATE_DB_RECOVERY_BUSY_TIMEOUT_MS = 5000
const SHRINK_GENERATION_RE = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/
const TURN_JOURNAL_DIR = '_turn_journal'
const TURN_JOURNAL_ID_RE = /^[A-Za-z0-9_.-]+$/
const TERMINAL_TURN_EVENTS = new Set(['completed', 'interrupted'])
const WORKTREE_FIELDS = ['worktree_path', 'worktree_branch', 'worktree_repo_root', 'worktree_created_at'] as const
let tmpCounter = 0

const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length === 0

/**
 * Epoch seconds since which this server stamps every deliberate shrink, recorded in the state directory on first start.
 * A missing or unreadable marker is recorded anew: a later marker only sends more backups to manual review.
 */
export function recoveryStampingSince(stateDir: string): number {
  const path = join(stateDir, STAMPING_MARKER)
  try {
    const value = Number(readFileSync(path, 'utf8').trim())
    if (Number.isFinite(value) && value > 0) return value
  } catch { /* record it below */ }
  const now = Date.now() / 1000
  mkdirSync(stateDir, { recursive: true })
  atomicWriteText(path, `${String(now)}\n`)
  return now
}

function readDoc(path: string): Dict | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isDict(value) ? value : null
  } catch {
    return null
  }
}

/** Python `_msg_count`: the transcript length, or -1 when the file is missing, unparseable, or not a session. */
function messageCount(doc: Dict | null): number {
  return doc && Array.isArray(doc.messages) ? doc.messages.length : -1
}

// ── deliberate-shrink provenance ─────────────────────────────────────────

/**
 * Python `_session_records_clear_sentinel` / `_live_supersedes_backup_by_clear_generation`: the live sidecar carries a
 * clear generation the backup lacks and the clear's boundary reset, and is either the exact cleared shape or has new
 * messages since.
 */
function clearedAfterBackup(live: Dict, bak: Dict): boolean {
  const generation = live.clear_generation
  if (typeof generation !== 'string' || !generation || bak.clear_generation === generation) return false
  if (live.truncation_watermark !== 0 || live.truncation_boundary !== 0) return false
  if (Array.isArray(live.messages) && live.messages.length > 0) return true
  const nulls = ['active_stream_id', 'pending_user_message', 'pending_started_at', 'pending_user_source']
  const lists = ['messages', 'context_messages', 'pending_attachments']
  return nulls.every((k) => k in live && live[k] === null) && lists.every((k) => isEmptyList(live[k]))
}

/** Python `_session_records_intentional_compress_shrink`: the live sidecar records a context compression. */
function recordsCompression(live: Dict): boolean {
  if (str(live.compression_anchor_mode).trim().toLowerCase() === 'manual') return true
  const shorter = Array.isArray(live.context_messages) && Array.isArray(live.messages) && live.context_messages.length < live.messages.length
  if (!shorter) return false
  const anchored = str(live.compression_anchor_summary).trim() !== '' && live.compression_anchor_message_key !== null && live.compression_anchor_message_key !== undefined
  return anchored || (live.truncation_watermark !== null && live.truncation_watermark !== undefined)
}

/**
 * Python `_backup_predates_intentional_shrink`: the backup still holds the uncompressed context. A backup whose context
 * carries the compaction marker was written after the compression and stays recoverable.
 */
function backupPredatesCompression(live: Dict, bak: Dict): boolean {
  const bakContext = Array.isArray(bak.context_messages) ? bak.context_messages : []
  if (bakContext.some(isContextCompressionMarker)) return false
  return bakContext.length > (Array.isArray(live.context_messages) ? live.context_messages.length : 0)
}

/** Python `_session_records_intentional_message_shrink`: truncate, retry, or undo stamped a generation the backup lacks. */
function recordsMessageShrink(live: Dict, bak: Dict): boolean {
  const isGeneration = (v: unknown): boolean => typeof v === 'string' && SHRINK_GENERATION_RE.test(v)
  if (!isGeneration(live.intentional_shrink_generation)) return false
  const backup = bak.intentional_shrink_generation
  if (backup === undefined || backup === null) return true
  return isGeneration(backup) && backup !== live.intentional_shrink_generation
}

interface BackupStatus {
  session_id: string
  live_messages: number
  bak_messages: number
  recommend: 'restore' | 'no_action' | 'no_backup' | 'manual_review'
  reason?: 'intentional_clear_truncate' | 'intentional_compress_shrink' | 'intentional_message_shrink' | 'unstamped_legacy_backup'
}

/** Python `inspect_session_recovery_status`: whether `<sid>.json.bak` should replace `<sid>.json`. */
function inspectBackup(dir: string, sid: string, stampingSince: number): BackupStatus {
  const livePath = join(dir, `${sid}.json`)
  let bakMtime: number
  try { bakMtime = statSync(`${livePath}.bak`).mtimeMs / 1000 } catch { return { session_id: sid, live_messages: messageCount(readDoc(livePath)), bak_messages: -1, recommend: 'no_backup' } }
  const live = readDoc(livePath)
  const bak = readDoc(`${livePath}.bak`)
  const base = { session_id: sid, live_messages: messageCount(live), bak_messages: messageCount(bak) }
  if (base.bak_messages <= base.live_messages) return { ...base, recommend: 'no_action' }
  // Every guard needs both documents; an unreadable live file is a real loss and restores.
  if (live && bak) {
    if (clearedAfterBackup(live, bak)) return { ...base, recommend: 'no_action', reason: 'intentional_clear_truncate' }
    if (recordsCompression(live) && backupPredatesCompression(live, bak)) return { ...base, recommend: 'no_action', reason: 'intentional_compress_shrink' }
    if (recordsMessageShrink(live, bak)) return { ...base, recommend: 'no_action', reason: 'intentional_message_shrink' }
    if (base.live_messages >= 0 && bakMtime < stampingSince) return { ...base, recommend: 'manual_review', reason: 'unstamped_legacy_backup' }
  }
  return { ...base, recommend: 'restore' }
}

// ── state.db ─────────────────────────────────────────────────────────────

interface MissingRow extends Dict { id: string; messages: Message[] }
interface StateDbView {
  /** Python `_state_db_has_session`: fail-open, so a missing, older, or unreadable db never blocks a backup restore. */
  has: (sid: string) => boolean
  /** WebUI-origin rows whose sidecar is missing, each with its transcript. */
  missing: MissingRow[]
  /** The db exists but could not be read; the audit reports it rather than call the scan clean. */
  unreadable: boolean
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
}

/** Python `_read_state_db_missing_sidecar_rows` (with empty rows) plus the session ids, from one read-only handle. */
function readStateDb(path: string, sessionDir: string): StateDbView {
  const absent: StateDbView = { has: () => true, missing: [], unreadable: false }
  if (!existsSync(path)) return absent
  let db: DatabaseSync
  try { db = openStateDbReadonly(path, STATE_DB_RECOVERY_BUSY_TIMEOUT_MS) } catch { return { ...absent, unreadable: true } }
  try {
    const cols = columns(db, 'sessions')
    if (!cols.has('id')) return absent
    const ids = new Set((db.prepare('SELECT id FROM sessions').all() as Dict[]).map((r) => str(r.id)))
    const view: StateDbView = { has: (sid) => ids.has(sid), missing: [], unreadable: false }
    if (!cols.has('source')) return view
    const opt = (name: string, fallback = 'NULL'): string => (cols.has(name) ? name : `${fallback} AS ${name}`)
    const select = ['id', opt('title'), opt('model'), opt('started_at', '0'), opt('parent_session_id'), opt('workspace'), ...WORKTREE_FIELDS.map((f) => opt(f))]
    const order = cols.has('started_at') ? 'COALESCE(started_at, 0) DESC' : 'rowid'
    const rows = db.prepare(`SELECT ${select.join(', ')} FROM sessions WHERE source = 'webui' ORDER BY ${order}`).all() as Dict[]
    const msgCols = columns(db, 'messages')
    const messages = ['session_id', 'role', 'content'].every((c) => msgCols.has(c))
      ? db.prepare(`SELECT role, content, ${msgCols.has('timestamp') ? 'timestamp' : 'NULL AS timestamp'} FROM messages WHERE session_id = ? ORDER BY ${msgCols.has('timestamp') && msgCols.has('id') ? 'timestamp, id' : 'rowid'}`)
      : null
    for (const row of rows) {
      const sid = str(row.id).trim()
      if (!isSafeSessionId(sid) || existsSync(join(sessionDir, `${sid}.json`))) continue
      const transcript = ((messages?.all(sid) as Dict[] | undefined) ?? []).map((m) => ({ role: m.role, content: m.content || '', ...(m.timestamp !== null ? { timestamp: m.timestamp } : {}) }))
      view.missing.push({ ...row, id: sid, messages: transcript })
    }
    return view
  } catch {
    return { ...absent, unreadable: true }
  } finally {
    db.close()
  }
}

/** Python `_state_db_row_to_sidecar`, through `Session` so the document matches every field the store persists. */
function sidecarFromStateDbRow(row: MissingRow, store: SessionStore, profile: string): Dict {
  const source = 'webui' // the scan reads only WebUI-origin rows
  const started = Number(row.started_at) || 0
  const last = Number(row.messages.at(-1)?.timestamp) || 0
  const workspace = typeof row.workspace === 'string' && row.workspace ? { workspace: row.workspace } : {}
  const worktree = Object.fromEntries(WORKTREE_FIELDS.map((f) => [f, row[f] || null]))
  const session = new Session({
    session_id: row.id, title: str(row.title) || 'Recovered WebUI Session', ...workspace, model: str(row.model) || 'unknown', profile,
    created_at: started, updated_at: last || started, parent_session_id: row.parent_session_id ?? null, ...worktree,
    source_tag: source, ...normalizeAgentSessionSource(source), messages: row.messages,
  }, store.deps.defaults(profile))
  return session.toDocument()
}

// ── turn journal (read-only) ─────────────────────────────────────────────

const createdAt = (event: Dict): number => { const n = Number(event.created_at ?? 0); return Number.isFinite(n) ? n : 0 }

/**
 * Python `iter_turn_journal_session_ids` + `read_turn_journal`: each session's events across its pid shards
 * (`<sid>~<pid>.jsonl`) and legacy file, oldest first. Only journals an earlier backend left behind exist; this server
 * never writes one.
 */
function readTurnJournals(sessionDir: string): Map<string, Dict[]> {
  const dir = join(sessionDir, TURN_JOURNAL_DIR)
  const out = new Map<string, Dict[]>()
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return out }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const stem = name.slice(0, -'.jsonl'.length)
    const tilde = stem.indexOf('~')
    const sid = tilde > 0 ? stem.slice(0, tilde) : stem
    if (!TURN_JOURNAL_ID_RE.test(sid)) continue
    let text: string
    try {
      if (!statSync(join(dir, name)).isFile()) continue
      text = readFileSync(join(dir, name), 'utf8')
    } catch { continue }
    const events = out.get(sid) ?? []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { const event = JSON.parse(line) as unknown; if (isDict(event)) events.push(event) } catch { /* a torn line */ }
    }
    out.set(sid, events)
  }
  for (const events of out.values()) events.sort((a, b) => createdAt(a) - createdAt(b))
  return out
}

/** What a turn sent: its trimmed text and attachment names, or null when it sent nothing identifiable. */
function turnKey(content: unknown, attachments: unknown): string | null {
  const text = str(content || '').trim()
  const files = (Array.isArray(attachments) ? attachments : []).map((a) => (isDict(a) ? str(a.name || a.filename || a.path) : str(a))).filter(Boolean).sort()
  return text || files.length ? JSON.stringify([text, files]) : null
}

/** A sidecar user row this long before a journaled turn predates it, so it cannot be that turn's row. */
const TURN_ROW_CLOCK_SLACK_S = 5

/**
 * Turns whose latest event is not terminal and whose user message never reached the sidecar. A row stamped with the
 * turn's id (or stream id) is that turn; otherwise rows and turns with the same text and attachments pair up in order,
 * one row per turn, so a repeated message ("continue") or an attachment-only turn still counts as missing.
 */
function pendingJournalTurns(sessionDir: string, sid: string, events: Dict[]): RecoveryItem[] {
  interface Turn { id: string; ids: Set<string>; first: number; latest: Dict; key: string | null }
  const turns = new Map<string, Turn>()
  for (const event of events) {
    const id = str(event.turn_id).trim()
    if (!id) continue
    const turn = turns.get(id) ?? { id, ids: new Set([id]), first: createdAt(event), latest: event, key: null }
    if (createdAt(event) >= createdAt(turn.latest)) turn.latest = event
    turn.key ??= turnKey(event.content, event.attachments)
    const streamId = str(event.stream_id).trim()
    if (streamId) turn.ids.add(streamId)
    turns.set(id, turn)
  }
  if (!turns.size) return []
  const live = readDoc(join(sessionDir, `${sid}.json`))
  const rows = (Array.isArray(live?.messages) ? live.messages : []).filter((m): m is Dict => isDict(m) && m.role === 'user')
  const rowTurnIds = new Set(rows.map((m) => str(m._turn_id)).filter(Boolean))
  const journaled = new Set([...turns.values()].flatMap((t) => [...t.ids]))
  const unmatched = [...turns.values()].filter((t) => ![...t.ids].some((id) => rowTurnIds.has(id))).sort((a, b) => a.first - b.first)
  const missing = new Set<Turn>()
  for (const key of new Set(unmatched.map((t) => t.key))) {
    if (key === null) continue
    const keyed = unmatched.filter((t) => t.key === key)
    const earliest = keyed[0]!.first - TURN_ROW_CLOCK_SLACK_S
    const available = rows.filter((m) => !journaled.has(str(m._turn_id)) && turnKey(m.content, m.attachments) === key && !(Number(m.timestamp) < earliest)).length
    for (const turn of keyed.slice(available)) missing.add(turn)
  }
  const items: RecoveryItem[] = []
  for (const turn of [...missing].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (TERMINAL_TURN_EVENTS.has(str(turn.latest.event))) continue
    items.push({ ...item(sid, 'turn_journal_pending_turn', 'repairable', 'audit_only_pending_turn_journal', messageCount(live)), turn_id: turn.id, event: str(turn.latest.event) })
  }
  return items
}

// ── audit ────────────────────────────────────────────────────────────────

function item(session_id: string, kind: RecoveryItem['kind'], category: RecoveryCategory, recommendation: RecoveryItem['recommendation'], live_messages = -1, bak_messages = -1): RecoveryItem {
  return { session_id, kind, category, recommendation, live_messages, bak_messages }
}

interface Scan { dir: string; liveIds: string[]; backupIds: string[]; db: StateDbView; tombstoned: Set<string> }

function scan(deps: RecoveryDeps): Scan {
  const dir = deps.store.sessionDir
  let names: string[] = []
  try { names = readdirSync(dir).sort() } catch { /* no sessions yet; state.db may still hold some */ }
  const ids = (suffix: string): string[] => names.filter((n) => n.endsWith(suffix) && !n.startsWith('_')).map((n) => n.slice(0, -suffix.length))
  return { dir, liveIds: ids('.json'), backupIds: ids('.json.bak'), db: readStateDb(deps.stateDbPath, dir), tombstoned: deps.store.loadDeletedTombstone() }
}

/** Python `audit_session_recovery`: a read-only classification of every recovery finding. */
export function auditSessionRecovery(deps: RecoveryDeps): RecoveryAudit {
  const s = scan(deps)
  const items: RecoveryItem[] = []
  const live = new Set(s.liveIds)
  for (const sid of s.backupIds.filter((id) => live.has(id))) {
    const status = inspectBackup(s.dir, sid, deps.stampingSince)
    if (status.recommend === 'restore') items.push(item(sid, 'shrunken_live', 'repairable', 'restore_from_bak', status.live_messages, status.bak_messages))
    if (status.recommend === 'manual_review') items.push(item(sid, 'unstamped_legacy_backup', 'unsafe_to_repair', 'manual_review', status.live_messages, status.bak_messages))
  }
  // A deleted session with both a surviving backup and a state.db row is reported once (#5504).
  const reportedDeleted = new Set<string>()
  for (const sid of s.backupIds.filter((id) => !live.has(id))) {
    const bakMessages = messageCount(readDoc(join(s.dir, `${sid}.json.bak`)))
    if (bakMessages < 0 || !isSafeSessionId(sid)) items.push(item(sid, 'malformed_orphan_backup', 'unsafe_to_repair', 'manual_review', -1, bakMessages))
    else if (s.tombstoned.has(sid)) {
      reportedDeleted.add(sid)
      items.push(item(sid, 'state_db_deleted_webui_tombstone', 'unsafe_to_repair', 'deleted_session_skipped', -1, bakMessages))
    } else if (s.db.has(sid)) items.push(item(sid, 'orphan_backup', 'repairable', 'restore_from_bak', -1, bakMessages))
    else items.push(item(sid, 'orphan_backup_without_state_row', 'unsafe_to_repair', 'manual_review', -1, bakMessages))
  }
  if (existsSync(deps.store.indexFile)) {
    let indexed: Set<string> | null = null
    try { indexed = new Set(deps.store.readIndexEntries().map((e) => e.session_id).filter((id): id is string => typeof id === 'string')) } catch { items.push(item('', 'index_unreadable', 'repairable', 'rebuild_index')) }
    if (indexed) for (const sid of [...indexed].filter((id) => !live.has(id) && !s.tombstoned.has(id)).sort()) items.push(item(sid, 'index_missing_file', 'repairable', 'rebuild_index'))
    if (indexed) for (const sid of s.liveIds.filter((id) => !indexed.has(id))) items.push(item(sid, 'index_missing_entry', 'repairable', 'rebuild_index', messageCount(readDoc(join(s.dir, `${sid}.json`)))))
  }
  for (const row of s.db.missing) {
    if (reportedDeleted.has(row.id)) continue
    if (s.tombstoned.has(row.id)) items.push(item(row.id, 'state_db_deleted_webui_tombstone', 'unsafe_to_repair', 'deleted_session_skipped'))
    else if (!row.messages.length) items.push(item(row.id, 'state_db_orphan_webui_row', 'unsafe_to_repair', 'manual_review'))
    else items.push(item(row.id, 'state_db_missing_sidecar', 'repairable', 'materialize_from_state_db'))
  }
  if (s.db.unreadable) items.push(item('', 'state_db_unreadable', 'unsafe_to_repair', 'manual_review'))
  for (const [sid, events] of readTurnJournals(s.dir)) items.push(...pendingJournalTurns(s.dir, sid, events))
  const summary = { ok: s.liveIds.length, repairable: 0, unsafe_to_repair: 0 }
  for (const i of items) summary[i.category] += 1
  return { status: summary.unsafe_to_repair ? 'needs_manual_review' : summary.repairable ? 'warn' : 'ok', summary, items }
}

// ── repair ───────────────────────────────────────────────────────────────

/** Write `text` to a synced sibling temp file and publish it: replace `target`, or with `create` only when it is absent. */
function publish(target: string, text: string, create: boolean): boolean {
  const tmp = `${target}.recover.tmp.${String(process.pid)}.${String(++tmpCounter)}`
  try {
    const fd = openSync(tmp, 'w')
    try { writeFully(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
    if (!create) { renameSync(tmp, target); return true }
    // A link never replaces a sidecar a concurrent save created after the check.
    try { linkSync(tmp, target); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
  } finally {
    try { unlinkSync(tmp) } catch { /* renamed */ }
  }
}

/** A resident session with a live turn would overwrite any restored file on its next save. */
function busy(store: SessionStore, sid: string): boolean {
  const s = store.sessions.get(sid)
  return Boolean(s && (s.active_stream_id || s.pending_user_message || s.pending_started_at))
}

/** Restore shrunken and orphaned sidecars from their backups, each re-checked under the session lock. */
async function restoreBackups(deps: RecoveryDeps, s: Scan): Promise<RecoveryRepair['backup_repair']> {
  const { store } = deps
  const live = new Set(s.liveIds)
  const orphans = s.backupIds.filter((sid) => !live.has(sid) && isSafeSessionId(sid) && !s.tombstoned.has(sid) && s.db.has(sid) && messageCount(readDoc(join(s.dir, `${sid}.json.bak`))) >= 0)
  const result: RecoveryRepair['backup_repair'] = { scanned: s.liveIds.length + orphans.length, restored: 0, orphaned_backups: orphans.length, details: [] }
  for (const sid of [...s.backupIds.filter((id) => live.has(id) && isSafeSessionId(id)), ...orphans]) {
    await store.withLock(sid, () => {
      const status = inspectBackup(s.dir, sid, deps.stampingSince)
      const path = store.pathFor(sid)
      if (status.recommend !== 'restore' || (!existsSync(path) && store.wasDeleted(sid))) return
      const counts = { live_messages: status.live_messages, bak_messages: status.bak_messages }
      if (busy(store, sid)) { result.details.push({ session_id: sid, restored: false, ...counts, skipped: 'session_active' }); return }
      try {
        if (!publish(path, readFileSync(`${path}.bak`, 'utf8'), !existsSync(path))) { result.details.push({ session_id: sid, restored: false, ...counts, skipped: 'sidecar_appeared' }); return }
      } catch (error) {
        result.details.push({ session_id: sid, restored: false, ...counts, error: (error as Error).message })
        return
      }
      store.sessions.delete(sid)
      store.invalidatePersistedIds()
      result.restored += 1
      result.details.push({ session_id: sid, restored: true, ...counts })
      deps.log(`[webui] WARNING: session recovery restored ${sid} from .bak (live=${String(status.live_messages)} -> bak=${String(status.bak_messages)} messages)`)
    })
  }
  return result
}

/** Python `recover_missing_sidecars_from_state_db`: create each missing WebUI sidecar that state.db can rebuild. */
async function materializeSidecars(deps: RecoveryDeps, s: Scan): Promise<RecoveryRepair['sidecar_repair']> {
  const { store } = deps
  const rows = s.db.missing.filter((row) => row.messages.length && !s.tombstoned.has(row.id))
  const result: RecoveryRepair['sidecar_repair'] = { scanned: rows.length, materialized: 0, details: [] }
  for (const row of rows) {
    await store.withLock(row.id, () => {
      if (store.wasDeleted(row.id)) return
      if (busy(store, row.id)) { result.details.push({ session_id: row.id, materialized: false, skipped: 'session_active' }); return }
      try {
        mkdirSync(s.dir, { recursive: true })
        if (!publish(store.pathFor(row.id), JSON.stringify(sidecarFromStateDbRow(row, store, deps.profile), null, 2), true)) {
          result.details.push({ session_id: row.id, materialized: false, skipped: 'sidecar_appeared_during_reconcile' })
          return
        }
      } catch (error) {
        result.details.push({ session_id: row.id, materialized: false, error: (error as Error).message })
        return
      }
      store.sessions.delete(row.id)
      store.invalidatePersistedIds()
      result.materialized += 1
      result.details.push({ session_id: row.id, materialized: true, messages: row.messages.length })
    })
  }
  return result
}

/**
 * Python `repair_safe_session_recovery`: restore repairable backups, materialize missing sidecars from state.db, rebuild
 * the index from the sidecars on disk, and audit again. `clean` holds only when the second audit has no finding.
 */
export async function repairSafeSessionRecovery(deps: RecoveryDeps): Promise<RecoveryRepair> {
  const before = auditSessionRecovery(deps)
  const s = scan(deps)
  const backupRepair = await restoreBackups(deps, s)
  const sidecarRepair = await materializeSidecars(deps, s)
  const reindex = backupRepair.restored || sidecarRepair.materialized || !existsSync(deps.store.indexFile) || before.items.some((i) => i.recommendation === 'rebuild_index')
  if (reindex && existsSync(s.dir)) {
    try { deps.store.rebuildIndex({ diskOnly: true }) } catch (error) { deps.log(`[webui] WARNING: session recovery index rebuild failed: ${(error as Error).message}`) }
  }
  const after = auditSessionRecovery(deps)
  const clean = after.summary.repairable === 0 && after.summary.unsafe_to_repair === 0
  return { clean, ok: clean, repaired: backupRepair.restored + sidecarRepair.materialized, before, backup_repair: backupRepair, sidecar_repair: sidecarRepair, after }
}
