import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFully } from '../../fs/atomic.js'
import { str } from '../../util.js'
import { isContextCompressionMarker } from '../merge.js'
import { isSafeSessionId } from '../session.js'
import type { StorageIssue } from './backend.js'
import { statSignature, statSignatureAsync } from './json-files.js'
type Dict = Record<string, unknown>
const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length === 0
const SHRINK_GENERATION_RE = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/
let tmpCounter = 0
function parseDoc(text: string): Dict | null {
  try {
    const value = JSON.parse(text) as unknown
    return isDict(value) ? value : null
  } catch {
    return null
  }
}
function readDoc(path: string): Dict | null {
  try { return parseDoc(readFileSync(path, 'utf8')) } catch { return null }
}
/** The audit's read, off the event loop (TAL-1745). */
async function readDocAsync(path: string): Promise<Dict | null> {
  try { return parseDoc(await readFile(path, 'utf8')) } catch { return null }
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

export interface BackupStatus {
  session_id: string
  live_messages: number
  bak_messages: number
  recommend: 'restore' | 'no_action' | 'no_backup' | 'manual_review'
  reason?: 'intentional_clear_truncate' | 'intentional_compress_shrink' | 'intentional_message_shrink' | 'unstamped_legacy_backup'
}

/** Python `inspect_session_recovery_status`: whether `<sid>.json.bak` should replace `<sid>.json`. */
function inspectBackup(dir: string, sid: string, stampingSince: number): BackupStatus {
  const livePath = join(dir, `${sid}.json`)
  let bakSavedAt: number | null = null
  try { bakSavedAt = statSync(`${livePath}.bak`).mtimeMs / 1000 } catch { /* no backup */ }
  return inspectDocs(sid, readDoc(livePath), bakSavedAt === null ? null : readDoc(`${livePath}.bak`), bakSavedAt, stampingSince)
}

/** `inspectBackup` over documents already read; a null `bakSavedAt` means there is no backup. */
function inspectDocs(sid: string, live: Dict | null, bak: Dict | null, bakSavedAt: number | null, stampingSince: number): BackupStatus {
  if (bakSavedAt === null) return { session_id: sid, live_messages: messageCount(live), bak_messages: -1, recommend: 'no_backup' }
  return backupStatus(sid, live, bak, bakSavedAt, stampingSince)
}

/** The restore decision for a live document and its pre-shrink backup (each with `messages`), shared by every backend. */
export function backupStatus(sid: string, live: Dict | null, bak: Dict | null, bakSavedAt: number, stampingSince: number): BackupStatus {
  const base = { session_id: sid, live_messages: messageCount(live), bak_messages: messageCount(bak) }
  if (base.bak_messages <= base.live_messages) return { ...base, recommend: 'no_action' }
  // Every guard needs both documents; an unreadable live file is a real loss and restores.
  if (live && bak) {
    if (clearedAfterBackup(live, bak)) return { ...base, recommend: 'no_action', reason: 'intentional_clear_truncate' }
    if (recordsCompression(live) && backupPredatesCompression(live, bak)) return { ...base, recommend: 'no_action', reason: 'intentional_compress_shrink' }
    if (recordsMessageShrink(live, bak)) return { ...base, recommend: 'no_action', reason: 'intentional_message_shrink' }
    if (base.live_messages >= 0 && bakSavedAt < stampingSince) return { ...base, recommend: 'manual_review', reason: 'unstamped_legacy_backup' }
  }
  return { ...base, recommend: 'restore' }
}

/** A live session's backup finding, or none; the same kinds for every backend. */
export function backupIssue(status: BackupStatus, base: Omit<StorageIssue, 'kind' | 'category' | 'recommendation'>): StorageIssue | null {
  if (status.recommend === 'restore') return { ...base, kind: 'shrunken_live', category: 'repairable', recommendation: 'restore_from_bak' }
  if (status.recommend === 'manual_review') return { ...base, kind: 'unstamped_legacy_backup', category: 'unsafe_to_repair', recommendation: 'manual_review' }
  return null
}

/** Session-list index findings: entries without a session, and sessions without an entry. `indexed` is null when unreadable. */
export function indexIssues(indexed: Set<string> | null, live: ReadonlySet<string>, count: (sid: string) => number): StorageIssue[] {
  const issue = (sid: string, kind: StorageIssue['kind'], messages = -1): StorageIssue => ({ session_id: sid, kind, category: 'repairable', recommendation: 'rebuild_index', live_messages: messages, bak_messages: -1 })
  if (!indexed) return [issue('', 'index_unreadable')]
  return [
    ...[...indexed].filter((id) => !live.has(id)).sort().map((sid) => issue(sid, 'index_missing_file')),
    ...[...live].filter((id) => !indexed.has(id)).map((sid) => issue(sid, 'index_missing_entry', count(sid))),
  ]
}

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

/** Every backup and index finding; each document is read and parsed once, through `fs/promises` (TAL-1745). */
export async function diagnoseJson(dir: string, stampingSince: number): Promise<StorageIssue[]> {
  let names: string[] = []
  try { names = (await readdir(dir)).sort() } catch { /* empty */ }
  const live = new Set(names.filter((n) => n.endsWith('.json') && !n.startsWith('_')).map((n) => n.slice(0, -5)))
  const liveDocs = new Map<string, Dict | null>()
  const liveDoc = async (sid: string): Promise<Dict | null> => {
    if (!liveDocs.has(sid)) liveDocs.set(sid, await readDocAsync(join(dir, `${sid}.json`)))
    return liveDocs.get(sid)!
  }
  const issues: StorageIssue[] = []
  for (const name of names.filter((n) => n.endsWith('.json.bak') && !n.startsWith('_'))) {
    const sid = name.slice(0, -9)
    const path = join(dir, `${sid}.json`)
    const liveDocument = await liveDoc(sid)
    let bakSavedAt: number | null = null
    try { bakSavedAt = (await stat(`${path}.bak`)).mtimeMs / 1000 } catch { /* gone since the listing */ }
    const bak = bakSavedAt === null ? null : await readDocAsync(`${path}.bak`)
    const status = inspectDocs(sid, liveDocument, bak, bakSavedAt, stampingSince)
    const doc = liveDocument ?? bak
    const base = { session_id: sid, live_messages: status.live_messages, bak_messages: status.bak_messages, profile: doc ? str(doc.profile) || 'default' : 'default', revision: await statSignatureAsync(path), backupRevision: await statSignatureAsync(`${path}.bak`) }
    if (live.has(sid)) {
      const found = backupIssue(status, base)
      if (found) issues.push(found)
    } else if (status.bak_messages < 0 || !isSafeSessionId(sid)) issues.push({ ...base, kind: 'malformed_orphan_backup', category: 'unsafe_to_repair', recommendation: 'manual_review' })
    else issues.push({ ...base, kind: 'orphan_backup', category: 'repairable', recommendation: 'restore_from_bak' })
  }
  // Absent (undefined) is no finding; present but unreadable (null) is.
  const index = await readFile(join(dir, '_index.json'), 'utf8').catch((error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null))
  if (index !== undefined) {
    let indexed: Set<string> | null = null
    try {
      const entries = JSON.parse(index ?? '') as Dict[]
      indexed = new Set(entries.map((e) => e.session_id).filter((id): id is string => typeof id === 'string'))
    } catch { /* reported as unreadable */ }
    if (indexed) for (const sid of live) if (!indexed.has(sid)) await liveDoc(sid)
    issues.push(...indexIssues(indexed, live, (sid) => messageCount(liveDocs.get(sid) ?? null)))
  }
  return issues
}

export function restoreJsonBackup(dir: string, sid: string, stampingSince: number): boolean {
  if (!isSafeSessionId(sid)) return false
  if (inspectBackup(dir, sid, stampingSince).recommend !== 'restore') return false
  const path = join(dir, `${sid}.json`)
  return publish(path, readFileSync(`${path}.bak`, 'utf8'), !existsSync(path))
}

export function repairJson(dir: string, issue: StorageIssue, stampingSince: number): boolean {
  if (issue.recommendation !== 'restore_from_bak' || !isSafeSessionId(issue.session_id)) return false
  const path = join(dir, `${issue.session_id}.json`)
  if (statSignature(path) !== issue.revision || statSignature(`${path}.bak`) !== issue.backupRevision) return false
  return restoreJsonBackup(dir, issue.session_id, stampingSince)
}
