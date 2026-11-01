/* eslint-disable @typescript-eslint/require-await -- node:sqlite is synchronous; each transaction completes before its promise resolves. */
import { setImmediate as nextTurn } from 'node:timers/promises'
import { LIVE_SNAPSHOT_MAX_BYTES, LIVE_SNAPSHOT_MAX_ROWS, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS, SESSION_REPLAY_MAX_BYTES, SESSION_REPLAY_MAX_ROWS, journalEvent, parseRunJournalEventId, pruneRetention, staleInterruptedEvent, summaryFromEvents, validateId, type JournalEvent, type PruneOptions, type PruneResult, type RunSummary } from '../journal.js'
import type { JournalBackend, JournalEventMeta, JournalInput, JournalWriter, SessionJournalReplay } from './backend.js'
import { readTurnJournalEvents } from './json-journal.js'
import type { SqliteDb } from './sqlite-db.js'

/** Rows a `terminal-only` writer may hold before committing them together. */
const TERMINAL_ONLY_FLUSH_MS = 250
const READ_PAGE_ROWS = 256
interface Row { seq: number; row: string }

const parse = (text: string): JournalEvent | null => {
  try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as JournalEvent : null } catch { return null }
}

interface Stat { stream_id: string; rows: number; written: number; bytes: number }

/** Run journals in `journal_rows`, one row per event, and pruned runs in `journal_summaries`. */
export class SqliteJournal implements JournalBackend {
  private readonly writers = new Set<SqliteJournalWriter>()
  private closed = false
  constructor(private readonly db: SqliteDb, private readonly sessionDir: string, private readonly env: Record<string, string | undefined> = {}) {}

  private check(): void { if (this.closed) throw new Error('Storage is closed'); this.db.check() }
  /** Readers see every appended row: buffered `terminal-only` rows commit first. */
  private flushAll(): void { this.check(); for (const writer of this.writers) writer.flush('NORMAL') }
  commit(sessionId: string, runId: string, rows: readonly JournalEvent[], synchronous: 'FULL' | 'NORMAL'): void {
    const writtenAt = Date.now() / 1000
    this.db.transaction(() => {
      for (const row of rows) this.db.run('INSERT INTO journal_rows (session_id, stream_id, seq, row, written_at) VALUES (?, ?, ?, ?, ?)', sessionId, runId, row.seq, JSON.stringify(row), writtenAt)
    }, synchronous)
  }
  lastSeq(sessionId: string, runId: string): number {
    this.flushAll()
    return this.db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM journal_rows WHERE session_id = ? AND stream_id = ?', sessionId, runId)?.seq ?? 0
  }
  release(writer: SqliteJournalWriter): void { this.writers.delete(writer) }

  async open(sessionId: string, runId: string, opts: { durability: 'eager' | 'terminal-only' }): Promise<SqliteJournalWriter> {
    this.check()
    const writer = new SqliteJournalWriter(this, validateId(sessionId, 'session_id'), validateId(runId, 'run_id'), opts.durability)
    this.writers.add(writer)
    return writer
  }
  async writer(sessionId: string, runId: string): Promise<SqliteJournalWriter> {
    const mode = (this.env.HERMES_WEBUI_RUN_JOURNAL_FSYNC ?? 'terminal-only').trim().toLowerCase()
    return this.open(sessionId, runId, { durability: mode === 'eager' ? 'eager' : 'terminal-only' })
  }
  async close(): Promise<void> {
    if (this.closed) return
    for (const writer of [...this.writers]) await writer.close()
    this.closed = true
  }

  async *read(sessionId: string, runId: string, fromSeq: number): AsyncGenerator<JournalEvent> { yield* this.iterRunEvents(sessionId, runId, { afterSeq: fromSeq - 1 }) }
  /** One page per query, so a slow replay holds a page of the journal rather than all of it. */
  async *iterRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): AsyncGenerator<JournalEvent> {
    let after = opts.afterSeq ?? 0
    const max = opts.maxSeq ?? Number.MAX_SAFE_INTEGER
    for (;;) {
      this.flushAll()
      const page = this.db.all<Row>('SELECT seq, row FROM journal_rows WHERE session_id = ? AND stream_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?', sessionId, runId, after, max, READ_PAGE_ROWS)
      if (!page.length) return
      after = page.at(-1)!.seq
      // Like reading a growing file to its end: rows appended while this page is consumed are read next.
      for (const { row } of page) { const event = parse(row); if (event) yield event }
    }
  }
  async readRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): Promise<JournalEvent[]> {
    const events: JournalEvent[] = []
    for await (const event of this.iterRunEvents(sessionId, runId, opts)) events.push(event)
    return events
  }
  private tail(sessionId: string, runId: string, maxBytes: number, maxRows: number): { events: JournalEvent[]; truncated: boolean } {
    this.flushAll()
    const newest = this.db.all<Row>('SELECT seq, row FROM journal_rows WHERE session_id = ? AND stream_id = ? ORDER BY seq DESC LIMIT ?', sessionId, runId, maxRows + 1)
    const kept: string[] = []
    let bytes = 0
    for (const { row } of newest.slice(0, maxRows)) {
      bytes += Buffer.byteLength(row) + 1
      if (bytes > maxBytes) break
      kept.push(row)
    }
    return { events: kept.reverse().flatMap((row) => parse(row) ?? []), truncated: kept.length < newest.length }
  }
  async readRunEventTail(sessionId: string, runId: string, maxBytes = LIVE_SNAPSHOT_MAX_BYTES, maxRows = LIVE_SNAPSHOT_MAX_ROWS): Promise<{ events: JournalEvent[]; truncated: boolean }> { return this.tail(sessionId, runId, maxBytes, maxRows) }
  private prunedSummary(sessionId: string, runId: string): RunSummary | null {
    const row = this.db.get<{ summary: string }>('SELECT summary FROM journal_summaries WHERE session_id = ? AND stream_id = ?', sessionId, runId)
    return row ? parse(row.summary) as unknown as RunSummary | null : null
  }
  private latest(sessionId: string, runId: string): RunSummary {
    const tail = this.tail(sessionId, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS)
    if (!tail.events.length) { const pruned = this.prunedSummary(sessionId, runId); if (pruned) return pruned }
    const summary = summaryFromEvents(sessionId, runId, tail.events)
    const last = tail.events.at(-1)
    if (last) summary.event_count = last.seq || tail.events.length
    summary.journal_truncated = tail.truncated
    return summary
  }
  async latestRunSummary(sessionId: string, runId: string): Promise<RunSummary> { return this.latest(sessionId, runId) }
  async summary(sessionId: string, runId: string): Promise<RunSummary | null> {
    const summary = this.latest(sessionId, runId)
    return summary.event_count || summary.journal_pruned ? summary : null
  }
  async findRunSummary(runId: string): Promise<RunSummary | null> {
    try { validateId(runId, 'run_id') } catch { return null }
    this.flushAll()
    const live = this.db.get<{ session_id: string }>('SELECT session_id FROM journal_rows WHERE stream_id = ? LIMIT 1', runId)
    if (live) return this.latest(live.session_id, runId)
    const pruned = this.db.get<{ session_id: string }>('SELECT session_id FROM journal_summaries WHERE stream_id = ? LIMIT 1', runId)
    return pruned ? this.prunedSummary(pruned.session_id, runId) : null
  }
  async sessionJournalFingerprint(sessionId: string): Promise<string> {
    try { validateId(sessionId, 'session_id') } catch { return '0:0:0' }
    this.flushAll()
    const row = this.db.get<{ runs: number; written: number | null; bytes: number | null }>('SELECT count(DISTINCT stream_id) AS runs, max(written_at) AS written, sum(length(row)) AS bytes FROM journal_rows WHERE session_id = ?', sessionId)
    return `${String(row?.runs ?? 0)}:${String((row?.written ?? 0) * 1000)}:${String(row?.bytes ?? 0)}`
  }
  async staleInterruptedEvent(sessionId: string, runId: string, afterSeq: number | null = null, now = Date.now() / 1000): Promise<JournalEvent | null> {
    return staleInterruptedEvent(this.latest(sessionId, runId), sessionId, runId, afterSeq, now)
  }
  async sessionIds(): Promise<string[]> {
    this.flushAll()
    return this.db.all<{ id: string }>('SELECT session_id AS id FROM journal_rows UNION SELECT session_id FROM journal_summaries ORDER BY 1').map((r) => r.id)
  }
  async streams(sessionId: string): Promise<string[]> {
    validateId(sessionId, 'session_id')
    this.flushAll()
    return this.db.all<{ id: string }>('SELECT stream_id AS id FROM journal_rows WHERE session_id = ? UNION SELECT stream_id FROM journal_summaries WHERE session_id = ? ORDER BY 1', sessionId, sessionId).map((r) => r.id)
  }
  async recoveryEvents(): Promise<Map<string, Record<string, unknown>[]>> { this.check(); return readTurnJournalEvents(this.sessionDir) }
  async deleteSession(sessionId: string): Promise<boolean> {
    try { validateId(sessionId, 'session_id') } catch { return false }
    this.flushAll()
    return this.db.transaction(() => this.db.run('DELETE FROM journal_rows WHERE session_id = ?', sessionId) + this.db.run('DELETE FROM journal_summaries WHERE session_id = ?', sessionId) > 0)
  }
  async importRun(sessionId: string, runId: string, run: { rows: JournalEvent[]; summary: RunSummary | null }): Promise<void> {
    validateId(sessionId, 'session_id')
    validateId(runId, 'run_id')
    this.flushAll()
    this.db.transaction(() => {
      this.db.run('DELETE FROM journal_rows WHERE session_id = ? AND stream_id = ?', sessionId, runId)
      this.db.run('DELETE FROM journal_summaries WHERE session_id = ? AND stream_id = ?', sessionId, runId)
      // Retention counts from a run's last row, not from when it was copied.
      for (const row of run.rows) this.db.run('INSERT INTO journal_rows (session_id, stream_id, seq, row, written_at) VALUES (?, ?, ?, ?, ?)', sessionId, runId, row.seq, JSON.stringify(row), row.created_at || Date.now() / 1000)
      if (run.summary) this.db.run('INSERT INTO journal_summaries (session_id, stream_id, summary) VALUES (?, ?, ?)', sessionId, runId, JSON.stringify(run.summary))
    })
  }

  /** Python `read_session_run_events`: replay rows after an opaque cursor across a session's runs. */
  async readSessionRunEvents(sessionId: string, afterEventId: string | null | undefined): Promise<SessionJournalReplay> {
    const sid = validateId(sessionId, 'session_id')
    const rawCursor = (afterEventId ?? '').trim()
    const [cursorRunId, parsedSeq] = parseRunJournalEventId(rawCursor)
    let cursorSeq = parsedSeq
    if (rawCursor && cursorRunId !== null) { try { validateId(cursorRunId, 'run_id') } catch { cursorSeq = null } }
    const result = (status: string, events: JournalEvent[] = []): SessionJournalReplay => ({ status, events, cursor_run_id: cursorRunId, cursor_seq: cursorSeq })
    if (rawCursor && (cursorRunId === null || cursorSeq === null || cursorSeq <= 0)) return result('cursor_invalid')
    if (!rawCursor) return { status: 'ok', events: [], cursor_run_id: null, cursor_seq: null }
    this.flushAll()
    // The whole session's rows are read below; refuse before reading more than one replay may hold.
    if ((this.db.get<{ bytes: number | null }>('SELECT sum(length(CAST(row AS BLOB)) + 1) AS bytes FROM journal_rows WHERE session_id = ?', sid)?.bytes ?? 0) > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
    let retainedRows = 0
    let retainedBytes = 0
    /** Contiguous rows of one run from `afterSeq + 1`, within the replay's byte and row budget. */
    const take = (runId: string, rows: Row[], afterSeq: number): SessionJournalReplay => {
      const events: JournalEvent[] = []
      let expected = afterSeq + 1
      for (const { row } of rows) {
        retainedBytes += Buffer.byteLength(row) + 1
        if (retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
        const event = parse(row)
        if (!event) return result('replay_malformed')
        if (event.seq !== expected || event.event_id !== `${runId}:${String(expected)}` || event.run_id !== runId || event.session_id !== sid) return result('replay_noncontiguous')
        expected += 1
        if (++retainedRows > SESSION_REPLAY_MAX_ROWS) return result('replay_limit_rows')
        events.push(event)
      }
      return result('ok', events)
    }
    const runRows = (runId: string, afterSeq: number): Row[] => this.db.all<Row>('SELECT seq, row FROM journal_rows WHERE session_id = ? AND stream_id = ? AND seq > ? ORDER BY seq', sid, runId, afterSeq)
    const runs: { createdAt: number; runId: string; events: JournalEvent[] }[] = []
    const positions = new Map<string, number>()
    for (const { stream_id: runId, written } of this.db.all<{ stream_id: string; written: number }>('SELECT stream_id, max(written_at) AS written FROM journal_rows WHERE session_id = ? GROUP BY stream_id ORDER BY stream_id', sid)) {
      const taken = take(runId, runRows(runId, 0), 0)
      if (taken.status !== 'ok') return taken
      positions.set(runId, taken.events.at(-1)?.seq ?? 0)
      let createdAt = Number.POSITIVE_INFINITY
      for (const event of taken.events) createdAt = Math.min(createdAt, event.created_at || 0)
      runs.push({ createdAt: Number.isFinite(createdAt) ? createdAt : written, runId, events: taken.events })
    }
    runs.sort((a, b) => a.createdAt - b.createdAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
    const cursorIndex = runs.findIndex((run) => run.runId === cursorRunId)
    if (cursorIndex < 0) {
      if (this.db.get('SELECT 1 AS present FROM journal_summaries WHERE session_id = ? AND stream_id = ?', sid, cursorRunId)) return result('cursor_pruned')
      const foreign = this.db.get('SELECT 1 AS present FROM journal_rows WHERE stream_id = ? AND session_id <> ? LIMIT 1', cursorRunId, sid)
      return result(foreign ? 'cursor_session_mismatch' : 'cursor_run_missing')
    }
    const cursorEvents = runs[cursorIndex]!.events
    if (cursorSeq === null || cursorSeq > cursorEvents.length) return result('cursor_event_missing')
    const replay = cursorEvents.filter((event) => event.seq > cursorSeq)
    for (const run of runs.slice(cursorIndex + 1)) replay.push(...run.events)
    return { ...result('ok', replay), readActiveTail: async (runId) => {
      try {
        this.flushAll()
        // A run may finish between idle polls; the active tail alone cannot recover that history.
        const current = this.db.all<{ id: string }>('SELECT DISTINCT stream_id AS id FROM journal_rows WHERE session_id = ?', sid)
        if (current.some(({ id }) => id !== runId && !positions.has(id))) return result('replay_changed')
        const previous = positions.get(runId) ?? 0
        const last = this.db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM journal_rows WHERE session_id = ? AND stream_id = ?', sid, runId)?.seq ?? 0
        if (last < previous) return result('replay_changed')
        const taken = take(runId, runRows(runId, previous), previous)
        if (taken.status === 'ok') positions.set(runId, taken.events.at(-1)?.seq ?? previous)
        return taken
      } catch { return result('replay_changed') }
    } }
  }

  async prune(olderThan: number): Promise<number> { return (await this.pruneSettled({ now: olderThan + 1, retentionSeconds: 1 })).pruned }
  /**
   * Python `prune_settled_run_journals`: replace terminal runs past retention with their summary, keeping the newest
   * `keep` per session and any run with a live writer. Yields after every session and parsed run, like the JSON sweep.
   */
  async pruneSettled(opts: PruneOptions = {}): Promise<PruneResult> {
    const result: PruneResult = { examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0 }
    const { retention, keep, now, cutoff } = pruneRetention(this.env, opts)
    const proceed = async (): Promise<boolean> => { await (opts.pause ?? nextTurn)(); return !opts.signal?.aborted && !this.closed }
    if (retention <= 0) return result
    this.flushAll()
    const stat = (sid: string, runId: string): Stat | undefined => this.db.get<Stat>('SELECT stream_id, count(*) AS rows, max(written_at) AS written, sum(length(row)) AS bytes FROM journal_rows WHERE session_id = ? AND stream_id = ? GROUP BY stream_id', sid, runId)
    for (const { id: sid } of this.db.all<{ id: string }>('SELECT DISTINCT session_id AS id FROM journal_rows ORDER BY 1')) {
      if (!(await proceed())) return result
      this.flushAll()
      const runs = this.db.all<Stat>('SELECT stream_id, count(*) AS rows, max(written_at) AS written, sum(length(row)) AS bytes FROM journal_rows WHERE session_id = ? GROUP BY stream_id ORDER BY stream_id', sid)
      result.examined += runs.length
      if (runs.length <= keep || !runs.some((run) => run.written <= cutoff)) continue
      const terminalRuns: { run: Stat; summary: RunSummary }[] = []
      for (const run of runs) {
        const summary = summaryFromEvents(sid, run.stream_id, this.tail(sid, run.stream_id, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS).events)
        if (summary.terminal) { result.terminal += 1; terminalRuns.push({ run, summary }) }
        if (!(await proceed())) return result
      }
      terminalRuns.sort((a, b) => b.run.written - a.run.written || b.run.stream_id.localeCompare(a.run.stream_id))
      for (const { run, summary } of terminalRuns.slice(keep)) {
        if (opts.signal?.aborted || this.closed) return result
        if (run.written > cutoff) continue
        if ([...this.writers].some((writer) => writer.sessionId === sid && writer.runId === run.stream_id) || opts.isActive?.(`${sid}/${run.stream_id}`)) continue
        this.flushAll()
        const current = stat(sid, run.stream_id)
        if (current?.rows !== run.rows || current.written !== run.written || current.bytes !== run.bytes) continue
        if (opts.dryRun) { result.pruned += 1; result.bytes_reclaimed += run.bytes; continue }
        const pruned = { ...summary, journal_pruned: true, journal_pruned_at: now, original_size: run.bytes, original_mtime: run.written }
        this.db.transaction(() => {
          this.db.run('INSERT INTO journal_summaries (session_id, stream_id, summary) VALUES (?, ?, ?) ON CONFLICT (session_id, stream_id) DO UPDATE SET summary = excluded.summary', sid, run.stream_id, JSON.stringify(pruned))
          this.db.run('DELETE FROM journal_rows WHERE session_id = ? AND stream_id = ?', sid, run.stream_id)
        })
        result.pruned += 1
        result.bytes_reclaimed += run.bytes
      }
    }
    return result
  }
}

/**
 * `eager` commits every row with `synchronous=FULL`. `terminal-only` holds rows and commits them together on the
 * terminal row (FULL, like the JSON adapter's terminal fsync) or after 250 ms (NORMAL), whichever comes first.
 */
export class SqliteJournalWriter implements JournalWriter {
  private seq: number
  private buffer: JournalEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private closed = false
  constructor(private readonly journal: SqliteJournal, readonly sessionId: string, readonly runId: string, private readonly durability: 'eager' | 'terminal-only', private readonly now: () => number = () => Date.now() / 1000) {
    this.seq = journal.lastSeq(sessionId, runId)
  }
  async append(row: JournalInput, opts: { terminal: boolean }): Promise<JournalEvent> { return this.write(row.event, row.payload, { ...(row.redacted === undefined ? {} : { redacted: row.redacted }), ...(row.created_at === undefined ? {} : { createdAt: row.created_at }) }, opts.terminal) }
  async appendSseEvent(eventName: string, payload: unknown, meta: JournalEventMeta = {}): Promise<JournalEvent> { return this.write(eventName, payload, meta) }
  private write(eventName: string, payload: unknown, meta: JournalEventMeta, terminal?: boolean): JournalEvent {
    if (this.closed) throw new Error('run journal writer is closed')
    const name = eventName.trim()
    if (!name) throw new Error('event_name is required')
    const event = journalEvent(this.sessionId, this.runId, this.seq + 1, name, payload, { terminal, createdAt: meta.createdAt ?? this.now(), redacted: meta.redacted })
    this.buffer.push(event)
    this.seq += 1
    if (this.durability === 'eager' || event.terminal) {
      try { this.flush('FULL') } catch (error) { this.buffer.pop(); this.seq -= 1; throw error }
    }
    else this.timer ??= setTimeout(() => { this.timer = null; try { this.flush('NORMAL') } catch { /* the next append or read retries */ } }, TERMINAL_ONLY_FLUSH_MS).unref()
    return event
  }
  /** Commits held rows; on failure they stay held for the next attempt. */
  flush(synchronous: 'FULL' | 'NORMAL'): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.buffer.length) return
    this.journal.commit(this.sessionId, this.runId, this.buffer, synchronous)
    this.buffer = []
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { this.flush('NORMAL') } finally { this.journal.release(this) }
  }
}
