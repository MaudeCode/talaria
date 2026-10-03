/**
 * TAL-255: manual compression's anchor metadata (Python `compression_anchor.py` manual rules and the
 * `_handle_session_compress` helpers) and the per-session job table shared by `/api/session/compress` and the
 * `compress/start` + `compress/status` pair.
 */
import { str } from '../util.js'
import { isContextCompressionMarker, isDict, messageText } from './merge.js'
import type { Message } from './session.js'

const hasPartType = (content: unknown, types: string[]): boolean => Array.isArray(content) && content.some((p) => isDict(p) && types.includes(str(p.type)))
const plainText = (content: unknown): string => (Array.isArray(content) ? content.filter((p) => isDict(p) && p.type === 'text').map((p) => str((p as Message).text ?? (p as Message).content)).join('\n') : str(content)).trim()

/** Python `visible_messages_for_anchor(auto_compression=False)`: the transcript rows a manual compression anchors to. */
export function visibleMessagesForAnchor(messages: Message[]): Message[] {
  return messages.filter((m) => {
    if (!isDict(m) || !m.role || m.role === 'tool' || isContextCompressionMarker(m)) return false
    if (plainText(m.content) || Boolean(m.attachments && (!Array.isArray(m.attachments) || m.attachments.length))) return true
    if (m.role !== 'assistant') return false
    return (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || hasPartType(m.content, ['tool_use', 'thinking', 'reasoning']) || Boolean(m.reasoning)
  })
}

/** Python `_anchor_message_key`: the identity a client matches the anchor row by. */
export function anchorMessageKey(m: Message | undefined): Record<string, unknown> | null {
  if (!isDict(m) || !m.role || m.role === 'tool') return null
  const text = (Array.isArray(m.content) ? m.content.filter((p) => isDict(p) && p.type === 'text').map((p) => str((p as Message).text ?? (p as Message).content)).join('\n') : str(m.content)).split(/\s+/).join(' ').trim().slice(0, 160)
  const ts = m._ts ?? m.timestamp ?? null
  const attachments = Array.isArray(m.attachments) ? m.attachments.length : 0
  if (!text && !attachments && !ts) return null
  return { role: m.role, ts, text, attachments }
}

/** Python: the anchor summary is the reference line, else the token line or headline, else the compressor's own summary row. */
export function anchorSummary(summary: Record<string, unknown> | null, compressed: Message[]): string | null {
  const raw = str(summary?.reference_message) || str(summary?.token_line) || str(summary?.headline) || [...compressed].reverse().map((m) => (m.role === 'assistant' && typeof m.content === 'string' ? messageText(m.content).trim() : '')).find((t) => /context compaction|context compression/i.test(t)) || ''
  return raw.split(/\s+/).join(' ').trim() || null
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

  constructor(private readonly now: () => number) {}

  /** Drops finished jobs older than the TTL; a running job is never evicted. */
  get(sid: string): CompressionJob | undefined {
    const now = this.now()
    for (const [id, job] of this.jobs) if (job.status !== 'running' && now - job.updated_at > COMPRESSION_JOB_TTL_SECONDS) this.jobs.delete(id)
    return this.jobs.get(sid)
  }

  set(job: CompressionJob): void {
    this.jobs.set(job.session_id, job)
  }
}
