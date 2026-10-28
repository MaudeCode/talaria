/**
 * TAL-255: manual compression's anchor metadata (Python `compression_anchor.py` manual rules and the
 * `_handle_session_compress` helpers) and the per-session job table shared by `/api/session/compress` and the
 * `compress/start` + `compress/status` pair.
 */
import { createHash, randomUUID } from 'node:crypto'
import { str } from '../util.js'
import { compactionRow, isCompactionRow, isContextCompressionMarker, isDict, messageText } from './merge.js'
import type { Message, Session } from './session.js'

const hasPartType = (content: unknown, types: string[]): boolean => Array.isArray(content) && content.some((p) => isDict(p) && types.includes(str(p.type)))
const oneLine = (text: string): string => text.split(/\s+/).join(' ').trim()
const plainText = (content: unknown): string => (Array.isArray(content) ? content.filter((p) => isDict(p) && p.type === 'text').map((p) => str((p as Message).text ?? (p as Message).content)).join('\n') : str(content)).trim()

/** A transcript row a compression may anchor to. */
export function isAnchorCandidate(m: unknown): m is Message {
  if (!isDict(m) || !m.role || m.role === 'tool' || isContextCompressionMarker(m) || isCompactionRow(m)) return false
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
export function keyMatches(stored: Record<string, unknown>, row: Record<string, unknown>): boolean {
  if (str(stored.role) !== str(row.role) || str(stored.text) !== str(row.text)) return false
  if ((Number(stored.attachments) || 0) !== row.attachments) return false
  return stored.ts === null || stored.ts === undefined || row.ts === null || stored.ts === row.ts
}

/**
 * TAL-1566: records one compaction as its transcript row, after row `after` (-1: first), the rest of that row's turn and
 * tool results, and any compaction already there, so it falls between turns in the order compactions ran. The row takes its neighbour's time so timestamps stay in order, and
 * recorded tool calls past it keep naming their own rows.
 */
export function insertCompactionRow(s: Pick<Session, 'messages' | 'tool_calls'>, after: number, summary: string, now: number, id: string = randomUUID()): void {
  const turn = s.messages[after]?._turn_id
  let at = after + 1
  while (at < s.messages.length && (s.messages[at]!.role === 'tool' || isCompactionRow(s.messages[at]) || (turn && s.messages[at]!._turn_id === turn))) at += 1
  const timestamp = s.messages[at - 1]?.timestamp ?? s.messages[at]?.timestamp ?? now
  s.messages = [...s.messages.slice(0, at), compactionRow(summary, timestamp, id), ...s.messages.slice(at)]
  for (const call of s.tool_calls) if (typeof call.assistant_msg_idx === 'number' && call.assistant_msg_idx >= at) call.assistant_msg_idx += 1
}

/**
 * TAL-1566: a session an earlier release compacted kept only its anchor fields, which a separate reference card showed. It
 * loads with that compaction's row in place: after the anchor key's newest match, else the stored visible index, else
 * first. Nothing changes without a summary, without rows, or when a row already shows it.
 */
export function withLegacyCompactionRow(s: Pick<Session, 'messages' | 'tool_calls' | 'compression_anchor_summary' | 'compression_anchor_message_key' | 'compression_anchor_visible_idx'>): void {
  const text = oneLine(str(s.compression_anchor_summary))
  const messages = s.messages
  if (!text || !messages.length) return
  if (messages.some((m) => (isCompactionRow(m) && oneLine(messageText(m.content)) === text) || (isContextCompressionMarker(m) && oneLine(messageText(m.content)).includes(text)))) return
  const candidates = messages.flatMap((m, index) => (isAnchorCandidate(m) ? [index] : []))
  const key = s.compression_anchor_message_key
  const match = isDict(key) ? candidates.findLast((index) => { const row = anchorMessageKey(messages[index]); return row !== null && keyMatches(key, row) }) : undefined
  const visibleIdx = s.compression_anchor_visible_idx
  const after = match ?? (typeof visibleIdx === 'number' && Number.isInteger(visibleIdx) && visibleIdx >= 0 && candidates.length ? candidates[Math.min(visibleIdx, candidates.length - 1)]! : -1)
  insertCompactionRow(s, after, text, 0, `legacy-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`)
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
  /** TAL-1005: the turns that waited on this job; their own rows may land while it runs and follow its result. */
  turns: Set<string>
  /** TAL-1005: started by the server for an over-threshold session, not by the user's `/compress`. */
  automatic: boolean
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
