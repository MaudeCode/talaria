import { str } from '../util.js'
import type { JournalBackend, JournalWriter } from './storage/backend.js'

export type RunJournal = JournalBackend
export type RunJournalWriter = JournalWriter

export const RUN_JOURNAL_DIR_NAME = '_run_journal'
export const TERMINAL_SSE_EVENTS = new Set(['done', 'cancel', 'apperror', 'error', 'stream_end'])
export const SSE_RELAY_CLOSE_EVENTS = new Set(['stream_end', 'cancel', 'apperror', 'error'])
const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/
export interface JournalEvent {
  version: 1
  event_id: string
  seq: number
  run_id: string
  session_id: string
  event: string
  type: string
  created_at: number
  terminal: boolean
  terminal_state: string | null
  payload: unknown
  synthetic?: boolean
  /** A tool frame the server redacted before journaling it (with `api_redact_enabled` on); replay sends it as written. */
  redacted?: boolean
}

export interface RunSummary {
  session_id: string
  run_id: string
  stream_id: string
  event_count: number
  last_seq: number
  last_event_id: string | null
  terminal: boolean
  terminal_state: string
  last_event: string | null
  journal_truncated?: boolean
  journal_pruned?: boolean
  path?: string
}

export interface PruneOptions {
  now?: number
  retentionSeconds?: number
  keepRecent?: number
  isActive?: (path: string) => boolean
  dryRun?: boolean
  signal?: AbortSignal
  pause?: () => Promise<unknown>
}

export interface PruneResult {
  examined: number
  terminal: number
  pruned: number
  bytes_reclaimed: number
}

export function validateId(value: string, field: string): string {
  const v = value || ''
  if (!v || !SAFE_ID_RE.test(v) || /^\.+$/.test(v)) throw new Error(`${field} must match [A-Za-z0-9_.-]+`)
  return v
}

export function parseRunJournalEventId(raw: string | null | undefined): [string | null, number | null] {
  const text = (raw ?? '').trim()
  if (!text) return [null, null]
  const idx = text.lastIndexOf(':')
  if (idx <= 0) return [null, null]
  const runId = text.slice(0, idx)
  const seqText = text.slice(idx + 1)
  if (!/^-?\d+$/.test(seqText)) return [runId, null]
  return [runId, Number.parseInt(seqText, 10)]
}

/** The journal's run-status vocabulary, from the turn outcome (`terminal_state`) every terminal frame carries. */
export function terminalStateForEvent(eventName: string, payload: unknown): string | null {
  const name = eventName || ''
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  const state = str(p?.terminal_state)
  // A turn that settled without an answer is not a success: it ends as `errored`, like the app and Relay show it.
  if (name === 'done' || name === 'stream_end') return state === 'tool_limit_reached' ? state : state === 'no_response' ? 'errored' : 'completed'
  if (name === 'cancel') return 'interrupted-by-user'
  if (name === 'apperror' || name === 'error') return state === 'cancelled' ? 'interrupted-by-user' : state === 'interrupted' ? 'interrupted-by-crash' : 'errored'
  return null
}

export function selectAuthoritativeTerminalEvent(events: JournalEvent[]): JournalEvent | null {
  const terminal = events.filter((e) => e.terminal)
  for (let i = terminal.length - 1; i >= 0; i -= 1) if (terminal[i]?.event !== 'stream_end') return terminal[i] ?? null
  return terminal[terminal.length - 1] ?? null
}

export function summaryFromEvents(sessionId: string, runId: string, events: JournalEvent[]): RunSummary {
  const last = events[events.length - 1] ?? null
  const terminal = selectAuthoritativeTerminalEvent(events)
  return {
    session_id: sessionId, run_id: runId, stream_id: runId, event_count: events.length, last_seq: last?.seq ?? 0,
    last_event_id: last?.event_id ?? null, terminal: Boolean(terminal), terminal_state: terminal ? (terminal.terminal_state ?? 'completed') : (events.length ? 'running' : 'unknown'),
    last_event: last?.event ?? null,
  }
}
