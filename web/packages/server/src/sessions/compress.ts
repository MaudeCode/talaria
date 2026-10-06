/**
 * TAL-255: manual compression's anchor metadata (Python `compression_anchor.py` manual rules and the
 * `_handle_session_compress` helpers) and the per-session job table shared by `/api/session/compress` and the
 * `compress/start` + `compress/status` pair.
 */
import { str } from '../util.js'
import { isContextCompressionMarker, isDict, messageText } from './merge.js'
import type { Message, Session } from './session.js'

const hasPartType = (content: unknown, types: string[]): boolean => Array.isArray(content) && content.some((p) => isDict(p) && types.includes(str(p.type)))
const oneLine = (text: string): string => text.split(/\s+/).join(' ').trim()
const plainText = (content: unknown): string => (Array.isArray(content) ? content.filter((p) => isDict(p) && p.type === 'text').map((p) => str((p as Message).text ?? (p as Message).content)).join('\n') : str(content)).trim()

/** A transcript row a compression may anchor to. */
function isAnchorCandidate(m: unknown): m is Message {
  if (!isDict(m) || !m.role || m.role === 'tool' || isContextCompressionMarker(m)) return false
  if (plainText(m.content) || Boolean(m.attachments && (!Array.isArray(m.attachments) || m.attachments.length))) return true
  if (m.role !== 'assistant') return false
  return (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || hasPartType(m.content, ['tool_use', 'thinking', 'reasoning']) || Boolean(m.reasoning)
}

/** Python `visible_messages_for_anchor(auto_compression=False)`: the transcript rows a manual compression anchors to. */
export function visibleMessagesForAnchor(messages: Message[]): Message[] {
  return messages.filter(isAnchorCandidate)
}

/** Python `_anchor_message_key`: the identity a client matches the anchor row by. */
export function anchorMessageKey(m: Message | undefined): Record<string, unknown> | null {
  if (!isDict(m) || !m.role || m.role === 'tool') return null
  const text = oneLine(Array.isArray(m.content) ? m.content.filter((p) => isDict(p) && p.type === 'text').map((p) => str((p as Message).text ?? (p as Message).content)).join('\n') : str(m.content)).slice(0, 160)
  const ts = m._ts ?? m.timestamp ?? null
  const attachments = Array.isArray(m.attachments) ? m.attachments.length : 0
  if (!text && !attachments && !ts) return null
  return { role: m.role, ts, text, attachments }
}

/** Python: the anchor summary is the reference line, else the token line or headline, else the compressor's own summary row. */
export function anchorSummary(summary: Record<string, unknown> | null, compressed: Message[]): string | null {
  const raw = str(summary?.reference_message) || str(summary?.token_line) || str(summary?.headline) || [...compressed].reverse().map((m) => (m.role === 'assistant' && typeof m.content === 'string' ? messageText(m.content).trim() : '')).find((t) => /context compaction|context compression/i.test(t)) || ''
  return oneLine(raw) || null
}

/** The anchor key matches a row's own key: role, text and attachment count, and the timestamp when both have one. */
function keyMatches(stored: Record<string, unknown>, row: Record<string, unknown>): boolean {
  if (str(stored.role) !== str(row.role) || str(stored.text) !== str(row.text)) return false
  if ((Number(stored.attachments) || 0) !== row.attachments) return false
  return stored.ts === null || stored.ts === undefined || row.ts === null || stored.ts === row.ts
}

export interface CompressionReference { text: string; after_message_index: number | null }

/**
 * TAL-560: the "Context compaction · Reference only" card: the compaction summary and the row of `messages` (a full
 * display transcript, so the index is in the `_messages_offset` space of every window) it renders after; null there puts
 * it above the transcript. The anchor key's newest match wins, else the stored visible index. Null without a summary or
 * when a compaction marker row in the transcript already shows it.
 */
export function compressionReference(s: Session, messages: unknown[]): CompressionReference | null {
  const text = oneLine(str(s.compression_anchor_summary))
  if (!text) return null
  if (messages.some((m) => isContextCompressionMarker(m) && oneLine(messageText((m as Message).content)).includes(text))) return null
  const candidates = messages.flatMap((m, index) => (isAnchorCandidate(m) ? [index] : []))
  const key = s.compression_anchor_message_key
  if (isDict(key)) {
    const match = candidates.findLast((index) => { const row = anchorMessageKey(messages[index] as Message); return row !== null && keyMatches(key, row) })
    if (match !== undefined) return { text, after_message_index: match }
  }
  const visibleIdx = s.compression_anchor_visible_idx
  if (typeof visibleIdx === 'number' && Number.isInteger(visibleIdx) && visibleIdx >= 0 && candidates.length) {
    return { text, after_message_index: candidates[Math.min(visibleIdx, candidates.length - 1)]! }
  }
  return { text, after_message_index: null }
}

/** TAL-540, Python `_compression_summary_from_messages`: an auto-compression's anchor summary is its newest marker's text. */
export function markerSummary(messages: Message[]): string | null {
  const text = [...messages].reverse().filter(isContextCompressionMarker).map((m) => messageText(m.content)).find((t) => t.trim()) ?? ''
  return oneLine(text) || null
}

/** Old `_MANUAL_COMPRESSION_JOB_TTL_SECONDS`: a finished job stays readable so every open tab sees one result. */
export const COMPRESSION_JOB_TTL_SECONDS = 10 * 60

export interface CompressionJob {
  session_id: string
  focus_topic: string | null
  status: 'running' | 'done' | 'error'
  started_at: number
  updated_at: number
  result?: Record<string, unknown>
  error?: string
  error_status?: number
  /** The typed fields of a stale-runtime refusal (`type`, `retryable`, ...). */
  error_extra?: Record<string, unknown>
  /** Settles when the worker finishes; never rejects. */
  done: Promise<void>
}

/** Old `_manual_compression_status_payload`. */
export function compressionStatusPayload(job: CompressionJob): Record<string, unknown> {
  const base = { ok: job.status !== 'error', status: job.status, session_id: job.session_id, focus_topic: job.focus_topic, started_at: job.started_at, updated_at: job.updated_at }
  if (job.status === 'done') return { ...base, ...job.result, status: 'done', ok: true }
  if (job.status === 'error') return { ...base, ...job.error_extra, error: job.error ?? 'Compression failed', error_status: job.error_status ?? 400 }
  return base
}

export class CompressionJobs {
  private readonly jobs = new Map<string, CompressionJob>()

  get(sid: string): CompressionJob | undefined {
    return this.jobs.get(sid)
  }

  set(job: CompressionJob): void {
    this.jobs.set(job.session_id, job)
  }

  delete(sid: string): void {
    this.jobs.delete(sid)
  }

  /** Drops a finished job (and the session payload it holds) after the TTL, whether or not anything reads it again. */
  expireLater(job: CompressionJob): void {
    setTimeout(() => { if (this.jobs.get(job.session_id) === job) this.jobs.delete(job.session_id) }, COMPRESSION_JOB_TTL_SECONDS * 1000).unref()
  }
}
