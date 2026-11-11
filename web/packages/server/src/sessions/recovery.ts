/**
 * Session recovery audit and safe repair (Python `api/session_recovery.py`, TAL-259). The store writes
 * a shrink backup before any save that shrinks a transcript; the audit classifies every backup, index row, WebUI-origin
 * state.db row without a sidecar, and pending turn-journal entry as `repairable` or `unsafe_to_repair`, and safe repair
 * restores, materializes, and reindexes only what is repairable.
 *
 * A backup never undoes a deliberate shrink: clear, manual compression, and truncate/retry/undo each leave provenance on
 * the live sidecar (`clear_generation`, the compression anchor, `intentional_shrink_generation`). A backup older than the
 * `recovery_stamping_since` marker may predate that provenance, so next to a readable live transcript it goes to manual
 * review instead.
 */
import type { RecoveryAudit, RecoveryAuditItem, RecoveryRepair } from '@maudecode/talaria-web-contracts'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import { str } from '../util.js'
import type { StorageIssue } from './storage/backend.js'
import { isSafeSessionId, Session, type Message } from './session.js'
import { normalizeAgentSessionSource, RECOVERY_WORKTREE_FIELDS, stateDbSessionReadAsync, type StateDbRecoveryRow, type StateDbRecoveryScan } from './state-db.js'
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
  isReadOnly: (sid: string, profile: string) => boolean | Promise<boolean>
  log: (line: string) => void
}

const TERMINAL_TURN_EVENTS = new Set(['completed', 'interrupted'])
const createdAt = (event: Dict): number => { const value = Number(event.created_at ?? 0); return Number.isFinite(value) ? value : 0 }

const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Epoch seconds since which this server stamps every deliberate shrink, recorded in the state directory on first start.
 * A missing or unreadable marker is recorded anew: a later marker only sends more backups to manual review.
 */
export async function recoveryStampingSince(documents: DocumentBackend): Promise<number> {
  return (await updateDocument(documents, 'recovery', 'stamping-since', (value) => {
    const stored = Number(typeof value === 'string' ? value.trim() : '')
    if (Number.isFinite(stored) && stored > 0) return { value, result: stored }
    const now = Date.now() / 1000
    return { value: `${String(now)}\n`, result: now }
  }, { replaceInvalid: true }))
}

// ── state.db ─────────────────────────────────────────────────────────────

interface StateDbView {
  /** Python `_state_db_has_session`: fail-open, so a missing, older, or unreadable db never blocks a backup restore. */
  has: (sid: string) => boolean
  /** WebUI-origin rows whose sidecar is missing, each with its transcript's length. */
  missing: StateDbRecoveryRow[]
  /** The db exists but could not be read; the audit reports it rather than call the scan clean. */
  unreadable: boolean
}

/** One read on the state.db worker: it may wait out a writer, so it never runs on the event loop (TAL-1745). */
async function readStateDb(path: string): Promise<StateDbRecoveryScan> {
  return await stateDbSessionReadAsync({ ids: null, rows: [], unreadable: true }, 'stateDbRecoveryCounts', path)
}

/** The scan against the sidecars that exist now; repair never writes state.db, so its read serves both audits. */
function stateDbView(read: StateDbRecoveryScan, persisted: Set<string>): StateDbView {
  const ids = read.ids && new Set(read.ids)
  return { has: (sid) => !ids || ids.has(sid), missing: read.rows.filter((row) => isSafeSessionId(row.id) && !persisted.has(row.id)), unreadable: read.unreadable }
}

/** Python `_state_db_row_to_sidecar`, through `Session` so the document matches every field the store persists. */
async function sidecarFromStateDbRow(row: StateDbRecoveryRow, messages: Message[], store: SessionStore, profile: string): Promise<Dict> {
  const source = 'webui' // the scan reads only WebUI-origin rows
  const started = Number(row.started_at) || 0
  const last = Number(messages.at(-1)?.timestamp) || 0
  const workspace = typeof row.workspace === 'string' && row.workspace ? { workspace: row.workspace } : {}
  const worktree = Object.fromEntries(RECOVERY_WORKTREE_FIELDS.map((f) => [f, row[f] || null]))
  const session = new Session({
    session_id: row.id, title: str(row.title) || 'Recovered WebUI Session', ...workspace, model: str(row.model) || 'unknown', profile,
    created_at: started, updated_at: last || started, parent_session_id: row.parent_session_id ?? null, ...worktree,
    source_tag: source, ...normalizeAgentSessionSource(source), messages,
  }, (await store.deps.defaults(profile)))
  return session.toDocument()
}

// ── turn journal (read-only) ─────────────────────────────────────────────

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
function pendingJournalTurns(live: Dict | null, sid: string, events: Dict[]): RecoveryItem[] {
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
    items.push({ ...item(sid, 'turn_journal_pending_turn', 'repairable', 'audit_only_pending_turn_journal', Array.isArray(live?.messages) ? live.messages.length : -1), turn_id: turn.id, event: str(turn.latest.event) })
  }
  return items
}

// ── audit ────────────────────────────────────────────────────────────────

function item(session_id: string, kind: RecoveryItem['kind'], category: RecoveryCategory, recommendation: RecoveryItem['recommendation'], live_messages = -1, bak_messages = -1): RecoveryItem {
  return { session_id, kind, category, recommendation, live_messages, bak_messages }
}

interface Scan { liveIds: string[]; issues: StorageIssue[]; stateDb: StateDbRecoveryScan; db: StateDbView; tombstoned: Set<string> }

async function scan(deps: RecoveryDeps, stateDb?: StateDbRecoveryScan): Promise<Scan> {
  const persisted = await deps.store.persistedIds()
  const issues = await deps.store.diagnose()
  stateDb ??= await readStateDb(deps.stateDbPath)
  return { liveIds: [...persisted].sort(), issues, stateDb, db: stateDbView(stateDb, persisted), tombstoned: await deps.store.loadDeletedTombstone() }
}

async function readOnlyRecovery(deps: RecoveryDeps, sid: string, profile?: string): Promise<boolean> {
  if (profile === undefined) {
    try { profile = (await deps.store.loadMetadataOnly(sid))?.profile ?? deps.profile } catch { profile = deps.profile }
  }
  return await deps.isReadOnly(sid, profile)
}

export async function auditSessionRecovery(deps: RecoveryDeps): Promise<RecoveryAudit> {
  return await auditScan(deps, await scan(deps))
}

async function auditScan(deps: RecoveryDeps, s: Scan): Promise<RecoveryAudit> {
  const items: RecoveryItem[] = []
  const reportedDeleted = new Set<string>()
  for (const issue of s.issues) {
    const { profile } = issue
    const finding = { ...issue }
    delete finding.profile
    delete finding.revision
    delete finding.backupRevision
    if (finding.kind === 'index_missing_file' && s.tombstoned.has(finding.session_id)) continue
    if (finding.kind === 'orphan_backup') {
      if (s.tombstoned.has(finding.session_id)) {
        reportedDeleted.add(finding.session_id)
        finding.kind = 'state_db_deleted_webui_tombstone'; finding.category = 'unsafe_to_repair'; finding.recommendation = 'deleted_session_skipped'
      } else if (!s.db.has(finding.session_id)) {
        finding.kind = 'orphan_backup_without_state_row'; finding.category = 'unsafe_to_repair'; finding.recommendation = 'manual_review'
      }
    }
    if (finding.recommendation === 'restore_from_bak' && await readOnlyRecovery(deps, finding.session_id, profile)) { finding.category = 'unsafe_to_repair'; finding.recommendation = 'manual_review' }
    items.push(finding)
  }
  for (const row of s.db.missing) {
    if (reportedDeleted.has(row.id)) continue
    if (s.tombstoned.has(row.id)) items.push(item(row.id, 'state_db_deleted_webui_tombstone', 'unsafe_to_repair', 'deleted_session_skipped'))
    else if (!row.count) items.push(item(row.id, 'state_db_orphan_webui_row', 'unsafe_to_repair', 'manual_review'))
    else items.push(item(row.id, 'state_db_missing_sidecar', 'repairable', 'materialize_from_state_db'))
  }
  if (s.db.unreadable) items.push(item('', 'state_db_unreadable', 'unsafe_to_repair', 'manual_review'))
  for (const [sid, events] of await deps.store.deps.storage.journals.recoveryEvents()) {
    let doc: Dict | null = null
    try { if (await deps.store.exists(sid)) doc = { messages: await deps.store.readMessages(sid, { start: 0, end: Infinity }) } } catch { /* corrupt */ }
    items.push(...pendingJournalTurns(doc, sid, events))
  }
  for (const finding of items) if (finding.recommendation === 'materialize_from_state_db' && await readOnlyRecovery(deps, finding.session_id)) { finding.category = 'unsafe_to_repair'; finding.recommendation = 'manual_review' }
  const summary = { ok: s.liveIds.length, repairable: 0, unsafe_to_repair: 0 }
  for (const i of items) summary[i.category] += 1
  return { status: summary.unsafe_to_repair ? 'needs_manual_review' : summary.repairable ? 'warn' : 'ok', summary, items }
}

function busy(store: SessionStore, sid: string): boolean {
  const s = store.sessions.get(sid)
  return Boolean(s && (s.active_stream_id || s.pending_user_message || s.pending_started_at))
}

async function restoreBackups(deps: RecoveryDeps, s: Scan): Promise<RecoveryRepair['backup_repair']> {
  const { store } = deps
  const orphans = s.issues.filter((i) => i.kind === 'orphan_backup' && !s.tombstoned.has(i.session_id) && s.db.has(i.session_id))
  const result: RecoveryRepair['backup_repair'] = { scanned: s.liveIds.length + orphans.length, restored: 0, orphaned_backups: orphans.length, details: [] }
  for (const issue of [...s.issues.filter((i) => i.kind === 'shrunken_live'), ...orphans]) {
    const sid = issue.session_id
    await store.withLock(sid, async () => {
      if (!await store.exists(sid) && await store.wasDeleted(sid)) return
      const counts = { live_messages: issue.live_messages, bak_messages: issue.bak_messages }
      if (await readOnlyRecovery(deps, sid, issue.profile)) { result.details.push({ session_id: sid, restored: false, ...counts, skipped: 'read_only' }); return }
      if (busy(store, sid)) { result.details.push({ session_id: sid, restored: false, ...counts, skipped: 'session_active' }); return }
      try {
        if (!await store.repair(issue)) { result.details.push({ session_id: sid, restored: false, ...counts, skipped: 'sidecar_appeared' }); return }
      } catch (error) { result.details.push({ session_id: sid, restored: false, ...counts, error: (error as Error).message }); return }
      result.restored += 1
      result.details.push({ session_id: sid, restored: true, ...counts })
      deps.log(`[webui] WARNING: session recovery restored ${sid} from its backup (live=${String(issue.live_messages)} -> bak=${String(issue.bak_messages)} messages)`)
    })
  }
  return result
}

async function materializeSidecars(deps: RecoveryDeps, s: Scan): Promise<RecoveryRepair['sidecar_repair']> {
  const { store } = deps
  const rows = s.db.missing.filter((row) => row.count && !s.tombstoned.has(row.id))
  const result: RecoveryRepair['sidecar_repair'] = { scanned: rows.length, materialized: 0, details: [] }
  for (const row of rows) {
    await store.withLock(row.id, async () => {
      let messages: Message[] = []
      if (await store.wasDeleted(row.id)) return
      if (await readOnlyRecovery(deps, row.id)) { result.details.push({ session_id: row.id, materialized: false, skipped: 'read_only' }); return }
      if (busy(store, row.id)) { result.details.push({ session_id: row.id, materialized: false, skipped: 'session_active' }); return }
      try {
        if (await store.exists(row.id)) { result.details.push({ session_id: row.id, materialized: false, skipped: 'sidecar_appeared_during_reconcile' }); return }
        messages = await stateDbSessionReadAsync(null, 'stateDbRecoveryTranscript', deps.stateDbPath, row.id) ?? []
        if (!messages.length) throw new Error('state.db transcript is empty or unreadable')
        await store.save(new Session((await sidecarFromStateDbRow(row, messages, store, deps.profile)), (await store.deps.defaults(deps.profile))), { touchUpdatedAt: false, skipIndex: true })
      } catch (error) { result.details.push({ session_id: row.id, materialized: false, error: (error as Error).message }); return }
      store.sessions.delete(row.id)
      result.materialized += 1
      result.details.push({ session_id: row.id, materialized: true, messages: messages.length })
    })
  }
  return result
}

export async function repairSafeSessionRecovery(deps: RecoveryDeps): Promise<RecoveryRepair> {
  const s = await scan(deps)
  const before = await auditScan(deps, s)
  const backupRepair = await restoreBackups(deps, s)
  let searchRepairs = 0
  for (const issue of s.issues) if (issue.recommendation === 'rebuild_search_index' && await deps.store.repair(issue)) searchRepairs += 1
  const sidecarRepair = await materializeSidecars(deps, s)
  const reindex = backupRepair.restored || sidecarRepair.materialized || !await deps.store.hasIndex() || before.items.some((i) => i.recommendation === 'rebuild_index')
  if (reindex) {
    try { await deps.store.rebuildIndex({ diskOnly: true }) } catch (error) { deps.log(`[webui] WARNING: session recovery index rebuild failed: ${(error as Error).message}`) }
  }
  const after = await auditScan(deps, await scan(deps, s.stateDb))
  const clean = after.summary.repairable === 0 && after.summary.unsafe_to_repair === 0
  return { clean, ok: clean, repaired: backupRepair.restored + searchRepairs + sidecarRepair.materialized, before, backup_repair: backupRepair, sidecar_repair: sidecarRepair, after }
}
