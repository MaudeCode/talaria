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

/** Rows that ask the user something; a replay withholds one once its own run proves it settled (TAL-1561). */
const REPLAY_PROMPT_EVENTS = new Set(['approval', 'clarify'])

type RowSource = AsyncIterator<JournalEvent> | Iterator<JournalEvent>
/** A journal row, or a live frame read back as one (its run and journal seq). */
export type PromptRow = Pick<JournalEvent, 'event' | 'seq' | 'run_id' | 'payload'>

/**
 * Replay visibility for prompt rows: a reconnecting client must not re-open a prompt its run already settled. Evidence is
 * same-run only (seqs are causal within a run, not across runs): a later terminal row settles every prompt before it, and a
 * later `clarify` tool completion settles a question (the Agent never runs `clarify` in parallel) but never an approval,
 * whose queue writes no per-entry settlement row. Pending prompts, rows without a positive seq and run, and evidence
 * without a readable tool name stay visible.
 *
 * `rows(prompt)` reads the prompt's run forward from it, inside the caller's own replay window (a paged journal read or
 * the rows already in memory); each run is walked at most once and leaves only two seqs behind. `liveRun` names a run
 * known not to have ended, so its approvals stay visible without reading ahead.
 */
export class PromptReplayFilter {
  private readonly runs = new Map<string, { rows: RowSource; done: boolean; terminal: number; clarified: number }>()

  constructor(private readonly rows: (prompt: PromptRow) => RowSource, private readonly liveRun: string | null = null) {}

  async visible(entry: PromptRow): Promise<boolean> {
    if (!REPLAY_PROMPT_EVENTS.has(entry.event) || !Number.isSafeInteger(entry.seq) || entry.seq <= 0 || !entry.run_id) return true
    const clarify = entry.event === 'clarify'
    if (clarify && isRecord(entry.payload) && entry.payload.status === 'resolved') return true
    if (!clarify && entry.run_id === this.liveRun) return true
    let run = this.runs.get(entry.run_id)
    if (!run) this.runs.set(entry.run_id, run = { rows: this.rows(entry), done: false, terminal: 0, clarified: 0 })
    for (;;) {
      if (run.terminal > entry.seq || (clarify && run.clarified > entry.seq)) return false
      if (run.done) return true
      const next = await run.rows.next()
      if (next.done) { run.done = true; continue }
      const row = next.value
      if (row.run_id !== entry.run_id || !Number.isSafeInteger(row.seq)) continue
      if (row.terminal && TERMINAL_SSE_EVENTS.has(row.event)) run.terminal = Math.max(run.terminal, row.seq)
      else if (row.event === 'tool_complete' && isRecord(row.payload) && row.payload.name === 'clarify') run.clarified = Math.max(run.clarified, row.seq)
    }
  }

  async close(): Promise<void> { for (const run of this.runs.values()) await run.rows.return?.() }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The rows of `events` after `prompt` in its run: `PromptReplayFilter` evidence from a replay already in memory. */
export function* runRowsAfter(prompt: PromptRow, ...events: readonly JournalEvent[][]): Generator<JournalEvent> {
  for (const list of events) for (const row of list) if (row.run_id === prompt.run_id && row.seq > prompt.seq) yield row
}
