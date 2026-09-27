/**
 * Durable run journal (Python `api/run_journal.py`): one JSONL file per
 * stream under `sessions/_run_journal/<sid>/<stream_id>.jsonl`, contiguous
 * `seq` from 1, `event_id = <stream_id>:<seq>`, fsync on terminal rows.
 */
import { rmSync } from 'node:fs'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, constants as fsConstants } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { join } from 'node:path'
import { str } from '../util.js'

export const RUN_JOURNAL_DIR_NAME = '_run_journal'
export const TERMINAL_SSE_EVENTS = new Set(['done', 'cancel', 'apperror', 'error', 'stream_end'])
export const SSE_RELAY_CLOSE_EVENTS = new Set(['stream_end', 'cancel', 'apperror', 'error'])
const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/
const SESSION_REPLAY_MAX_BYTES = 4 * 1024 * 1024
const SESSION_REPLAY_MAX_ROWS = 4096
const LIVE_SNAPSHOT_MAX_BYTES = 1024 * 1024
const LIVE_SNAPSHOT_MAX_ROWS = 512
const RUN_SUMMARY_MAX_BYTES = 4 * 1024 * 1024
const RUN_SUMMARY_MAX_ROWS = 512
const PRUNED_SUMMARY_SUFFIX = '.summary.json'

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

export function validateId(value: string, field: string): string {
  const v = value || ''
  if (!v || !SAFE_ID_RE.test(v)) throw new Error(`${field} must match [A-Za-z0-9_.-]+`)
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

export class RunJournal {
  constructor(readonly sessionDir: string, private readonly env: Record<string, string | undefined> = {}) {}

  root(): string {
    return join(this.sessionDir, RUN_JOURNAL_DIR_NAME)
  }

  pathFor(sessionId: string, runId: string): string {
    return join(this.root(), validateId(sessionId, 'session_id'), `${validateId(runId, 'run_id')}.jsonl`)
  }

  /** Python `delete_run_journal`: remove one session's journal directory; false for a missing or unsafe id. */
  deleteSession(sessionId: string): boolean {
    if (/^\.+$/.test(sessionId)) return false
    let dir: string
    try { dir = join(this.root(), validateId(sessionId, 'session_id')) } catch { return false }
    if (dir === this.root() || !existsSync(dir)) return false
    try { rmSync(dir, { recursive: true, force: true }) } catch { return false }
    return !existsSync(dir)
  }

  private fsyncMode(): 'eager' | 'terminal-only' {
    const mode = (this.env.HERMES_WEBUI_RUN_JOURNAL_FSYNC ?? 'terminal-only').trim().toLowerCase()
    return mode === 'eager' ? 'eager' : 'terminal-only'
  }

  writer(sessionId: string, runId: string): RunJournalWriter {
    return new RunJournalWriter(this, sessionId, runId, this.fsyncMode())
  }

  private static parseLines(text: string): { events: JournalEvent[]; malformed: number } {
    const events: JournalEvent[] = []
    let malformed = 0
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed as JournalEvent)
        else malformed += 1
      } catch {
        malformed += 1
      }
    }
    return { events, malformed }
  }

  readRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): JournalEvent[] {
    let text: string
    try {
      text = readFileSync(this.pathFor(sessionId, runId), 'utf8')
    } catch {
      return []
    }
    let { events } = RunJournal.parseLines(text)
    if (opts.afterSeq !== null && opts.afterSeq !== undefined) events = events.filter((e) => (e.seq || 0) > (opts.afterSeq!))
    if (opts.maxSeq !== null && opts.maxSeq !== undefined) events = events.filter((e) => (e.seq || 0) <= (opts.maxSeq!))
    return events
  }

  readRunEventTail(sessionId: string, runId: string, maxBytes = LIVE_SNAPSHOT_MAX_BYTES, maxRows = LIVE_SNAPSHOT_MAX_ROWS): { events: JournalEvent[]; truncated: boolean } {
    const path = this.pathFor(sessionId, runId)
    let raw: Buffer
    let start = 0
    try {
      const size = statSync(path).size
      start = Math.max(0, size - maxBytes)
      const fd = openSync(path, fsConstants.O_RDONLY)
      try {
        raw = Buffer.alloc(Math.min(size, maxBytes))
        let got = 0
        while (got < raw.length) {
          const n = readSyncAt(fd, raw, got, start + got)
          if (n <= 0) break
          got += n
        }
        raw = raw.subarray(0, got)
      } finally {
        closeSync(fd)
      }
    } catch {
      return { events: [], truncated: false }
    }
    let text = raw.toString('utf8')
    if (start) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n').filter((l) => l.length > 0)
    const rowsTruncated = lines.length > maxRows
    const { events } = RunJournal.parseLines(lines.slice(-maxRows).join('\n'))
    return { events, truncated: start > 0 || rowsTruncated }
  }

  static selectAuthoritativeTerminalEvent(events: JournalEvent[]): JournalEvent | null {
    const terminal = events.filter((e) => e.terminal)
    for (let i = terminal.length - 1; i >= 0; i -= 1) if (terminal[i]?.event !== 'stream_end') return terminal[i] ?? null
    return terminal[terminal.length - 1] ?? null
  }

  static summaryFromEvents(sessionId: string, runId: string, events: JournalEvent[]): RunSummary {
    const last = events[events.length - 1] ?? null
    const terminal = RunJournal.selectAuthoritativeTerminalEvent(events)
    return {
      session_id: sessionId, run_id: runId, stream_id: runId, event_count: events.length, last_seq: last?.seq ?? 0,
      last_event_id: last?.event_id ?? null, terminal: Boolean(terminal), terminal_state: terminal ? (terminal.terminal_state ?? 'completed') : (events.length ? 'running' : 'unknown'),
      last_event: last?.event ?? null,
    }
  }

  private loadPrunedSummary(path: string): RunSummary | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX), 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as RunSummary) : null
    } catch {
      return null
    }
  }

  latestRunSummary(sessionId: string, runId: string): RunSummary {
    const path = this.pathFor(sessionId, runId)
    if (!existsSync(path)) {
      const pruned = this.loadPrunedSummary(path)
      if (pruned) return pruned
    }
    const tail = this.readRunEventTail(sessionId, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS)
    const summary = RunJournal.summaryFromEvents(sessionId, runId, tail.events)
    const last = tail.events[tail.events.length - 1]
    if (last) summary.event_count = last.seq || tail.events.length
    summary.journal_truncated = tail.truncated
    return summary
  }

  /**
   * Python `prune_settled_run_journals`: compact terminal journals older than
   * `HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS` (14) into `.summary.json`, keeping
   * the `HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT` (3) newest per session and any
   * path with a live writer.
   */
  pruneSettled(opts: { now?: number; retentionSeconds?: number; keepRecent?: number; isActive?: (path: string) => boolean; dryRun?: boolean } = {}): { examined: number; terminal: number; pruned: number; bytes_reclaimed: number } {
    const result = { examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0 }
    const days = Number.parseFloat(this.env.HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS ?? '14')
    const retention = opts.retentionSeconds ?? (Number.isFinite(days) ? Math.max(0, days) * 86400 : 14 * 86400)
    const keepEnv = Number.parseInt(this.env.HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT ?? '3', 10)
    const keep = opts.keepRecent ?? (Number.isFinite(keepEnv) ? Math.max(0, keepEnv) : 3)
    const now = opts.now ?? Date.now() / 1000
    const cutoff = now - retention
    const root = this.root()
    if (retention <= 0 || !existsSync(root)) return result
    for (const sessionRoot of readdirSync(root, { withFileTypes: true })) {
      if (!sessionRoot.isDirectory() || !SAFE_ID_RE.test(sessionRoot.name)) continue
      const sid = sessionRoot.name
      const dir = join(root, sid)
      const terminalRuns: { mtimeNs: bigint; path: string; runId: string }[] = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        result.examined += 1
        const path = join(dir, name)
        const runId = name.slice(0, -'.jsonl'.length)
        let st
        try { st = statSync(path, { bigint: true }) } catch { continue }
        const summary = RunJournal.summaryFromEvents(sid, runId, this.readRunEventTail(sid, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS).events)
        if (!summary.terminal) continue
        result.terminal += 1
        terminalRuns.push({ mtimeNs: st.mtimeNs, path, runId })
      }
      terminalRuns.sort((a, b) => (b.mtimeNs > a.mtimeNs ? 1 : b.mtimeNs < a.mtimeNs ? -1 : b.path.localeCompare(a.path)))
      terminalRuns.slice(keep).forEach(({ path, runId }) => {
        if (opts.isActive?.(path)) return
        let st
        try { st = statSync(path) } catch { return }
        if (st.mtimeMs / 1000 > cutoff) return
        const summary = RunJournal.summaryFromEvents(sid, runId, this.readRunEventTail(sid, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS).events)
        if (!summary.terminal) return
        if (opts.dryRun) { result.pruned += 1; result.bytes_reclaimed += st.size; return }
        const pruned = { ...summary, journal_pruned: true, journal_pruned_at: now, original_size: st.size, original_mtime: st.mtimeMs / 1000 }
        try {
          writeFileSync(path.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX), JSON.stringify(pruned))
          unlinkSync(path)
        } catch { return }
        result.pruned += 1
        result.bytes_reclaimed += st.size
      })
    }
    return result
  }

  /** Locate a run across sessions (Python `find_run_summary`). */
  findRunSummary(runId: string): RunSummary | null {
    let rid: string
    try {
      rid = validateId(runId, 'run_id')
    } catch {
      return null
    }
    let sessions: string[]
    try {
      sessions = readdirSync(this.root())
    } catch {
      return null
    }
    for (const sid of sessions) {
      const path = join(this.root(), sid, `${rid}.jsonl`)
      if (existsSync(path)) {
        const summary = this.latestRunSummary(sid, rid)
        summary.path = path
        return summary
      }
    }
    for (const sid of sessions) {
      const summaryPath = join(this.root(), sid, `${rid}${PRUNED_SUMMARY_SUFFIX}`)
      if (existsSync(summaryPath)) {
        const summary = this.loadPrunedSummary(join(this.root(), sid, `${rid}.jsonl`))
        if (summary) {
          summary.path = summaryPath
          return summary
        }
      }
    }
    return null
  }

  sessionJournalFingerprint(sessionId: string): string {
    let sid: string
    try {
      sid = validateId(sessionId, 'session_id')
    } catch {
      return '0:0:0'
    }
    const dir = join(this.root(), sid)
    let count = 0
    let maxMtime = 0
    let total = 0
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const st = statSync(join(dir, name))
        count += 1
        total += st.size
        maxMtime = Math.max(maxMtime, st.mtimeMs)
      }
    } catch {
      return '0:0:0'
    }
    return `${String(count)}:${String(maxMtime)}:${String(total)}`
  }

  /** Python `read_session_run_events`: replay rows after an opaque cursor across a session's runs. */
  readSessionRunEvents(sessionId: string, afterEventId: string | null | undefined): { status: string; events: JournalEvent[]; cursor_run_id: string | null; cursor_seq: number | null } {
    const sid = validateId(sessionId, 'session_id')
    const rawCursor = (afterEventId ?? '').trim()
    const parsedCursor = parseRunJournalEventId(rawCursor)
    const cursorRunId = parsedCursor[0]
    let cursorSeq = parsedCursor[1]
    if (rawCursor && cursorRunId !== null) {
      try { validateId(cursorRunId, 'run_id') } catch { cursorSeq = null }
    }
    if (rawCursor && (cursorRunId === null || cursorSeq === null || cursorSeq <= 0)) return { status: 'cursor_invalid', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
    if (!rawCursor) return { status: 'ok', events: [], cursor_run_id: null, cursor_seq: null }
    const sessionRoot = join(this.root(), sid)
    const runs: { createdAt: number; runId: string; events: JournalEvent[] }[] = []
    let retainedRows = 0
    let retainedBytes = 0
    let names: string[] = []
    try { names = readdirSync(sessionRoot).filter((n) => n.endsWith('.jsonl')).sort() } catch { names = [] }
    for (const name of names) {
      const runId = name.slice(0, -'.jsonl'.length)
      try { validateId(runId, 'run_id') } catch { continue }
      const path = join(sessionRoot, name)
      let text: string
      try { text = readFileSync(path, 'utf8') } catch { continue }
      retainedBytes += Buffer.byteLength(text)
      if (retainedBytes > SESSION_REPLAY_MAX_BYTES) return { status: 'replay_limit_bytes', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
      const events: JournalEvent[] = []
      let expected = 1
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let event: JournalEvent
        try {
          event = JSON.parse(line) as JournalEvent
        } catch {
          return { status: 'replay_malformed', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
        }
        const seq = event.seq
        if (seq !== expected || event.event_id !== `${runId}:${String(seq)}` || event.run_id !== runId || event.session_id !== sid) {
          return { status: 'replay_noncontiguous', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
        }
        expected += 1
        retainedRows += 1
        if (retainedRows > SESSION_REPLAY_MAX_ROWS) return { status: 'replay_limit_rows', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
        events.push(event)
      }
      let createdAt = Number.POSITIVE_INFINITY
      for (const e of events) createdAt = Math.min(createdAt, e.created_at || 0)
      if (!Number.isFinite(createdAt)) { try { createdAt = statSync(path).mtimeMs / 1000 } catch { createdAt = 0 } }
      runs.push({ createdAt, runId, events })
    }
    runs.sort((a, b) => a.createdAt - b.createdAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
    const cursorIndex = runs.findIndex((r) => r.runId === cursorRunId)
    if (cursorIndex < 0) {
      if (cursorRunId && existsSync(join(sessionRoot, `${cursorRunId}${PRUNED_SUMMARY_SUFFIX}`))) return { status: 'cursor_pruned', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
      let foreign = false
      try {
        for (const other of readdirSync(this.root())) if (other !== sid && cursorRunId && existsSync(join(this.root(), other, `${cursorRunId}.jsonl`))) foreign = true
      } catch { /* none */ }
      return { status: foreign ? 'cursor_session_mismatch' : 'cursor_run_missing', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
    }
    const cursorEvents = runs[cursorIndex]?.events ?? []
    if (cursorSeq === null || cursorSeq > cursorEvents.length) return { status: 'cursor_event_missing', events: [], cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
    const replay = cursorEvents.filter((e) => e.seq > (cursorSeq))
    for (const run of runs.slice(cursorIndex + 1)) replay.push(...run.events)
    return { status: 'ok', events: replay, cursor_run_id: cursorRunId, cursor_seq: cursorSeq }
  }

  /** Python `stale_interrupted_event`: a synthetic terminal row for a journal whose worker died. */
  staleInterruptedEvent(sessionId: string, runId: string, afterSeq: number | null = null, now = Date.now() / 1000): JournalEvent | null {
    const summary = this.latestRunSummary(sessionId, runId)
    if (summary.terminal || !summary.event_count) return null
    const seq = (summary.last_seq || 0) + 1
    if (afterSeq !== null && seq <= afterSeq) return null
    return {
      version: 1, event_id: `${runId}:${String(seq)}`, seq, run_id: runId, session_id: sessionId, event: 'apperror', type: 'apperror', created_at: now, terminal: true, terminal_state: 'lost-worker-bookkeeping',
      payload: { type: 'interrupted', recovery_control: true, message: 'The live worker stopped before this run finished.', hint: 'The transcript was restored to the last journaled event. Start a new turn if you still need the task to continue.', session_id: sessionId, stream_id: runId, journal_last_seq: summary.last_seq },
      synthetic: true,
    }
  }
}

import { readSync } from 'node:fs'
function readSyncAt(fd: number, buf: Buffer, offset: number, position: number): number {
  return readSync(fd, buf, offset, buf.length - offset, position)
}

export class RunJournalWriter {
  private fd: number | null = null
  private seq = 0
  private closed = false
  readonly path: string

  constructor(private readonly journal: RunJournal, readonly sessionId: string, readonly runId: string, private readonly fsyncMode: 'eager' | 'terminal-only', private readonly now: () => number = () => Date.now() / 1000) {
    this.path = journal.pathFor(sessionId, runId)
    // Resume the sequence when a journal already exists for this stream id (never in practice; ids are fresh).
    try {
      const existing = journal.readRunEvents(sessionId, runId)
      this.seq = existing[existing.length - 1]?.seq ?? 0
    } catch { this.seq = 0 }
  }

  appendSseEvent(eventName: string, payload: unknown, meta: { redacted?: boolean } = {}): JournalEvent {
    if (this.closed) throw new Error('run journal writer is closed')
    const name = eventName.trim()
    if (!name) throw new Error('event_name is required')
    const terminalState = terminalStateForEvent(name, payload)
    this.seq += 1
    const event: JournalEvent = {
      version: 1, event_id: `${this.runId}:${String(this.seq)}`, seq: this.seq, run_id: this.runId, session_id: this.sessionId, event: name, type: name,
      created_at: this.now(), terminal: Boolean(terminalState), terminal_state: terminalState, payload: payload ?? {},
      ...(meta.redacted === undefined ? {} : { redacted: meta.redacted }),
    }
    mkdirSync(join(this.path, '..'), { recursive: true })
    this.fd ??= openSync(this.path, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600)
    writeFully(this.fd, `${JSON.stringify(event)}\n`)
    if (this.fsyncMode === 'eager' || terminalState) { try { fsyncSync(this.fd) } catch { /* best effort */ } }
    if (SSE_RELAY_CLOSE_EVENTS.has(name)) this.closeHandle()
    return event
  }

  private closeHandle(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd) } catch { /* ignore */ }
      this.fd = null
    }
  }

  close(): void {
    this.closeHandle()
    this.closed = true
  }
}
