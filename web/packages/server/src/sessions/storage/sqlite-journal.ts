/* eslint-disable @typescript-eslint/require-await -- node:sqlite is synchronous; each transaction completes before its promise resolves. */
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { LIVE_SNAPSHOT_MAX_BYTES, LIVE_SNAPSHOT_MAX_ROWS, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS, SESSION_REPLAY_MAX_BYTES, SESSION_REPLAY_MAX_ROWS, archivedSummary, journalEvent, parseRunJournalEventId, pruneRetention, staleInterruptedEvent, summaryFromEvents, summaryFromTail, validateId, type JournalEvent, type PruneOptions, type PruneResult, type RunSummary } from '../journal.js'
import type { JournalBackend, JournalEventMeta, JournalInput, JournalWriter, SessionJournalReplay } from './backend.js'
import { readTurnJournalEvents } from './json-journal.js'
import { JournalArchiveError, JournalReadLimit, gunzipChunks, splitLines, type ReadBudget } from './json-journal-archive.js'
import type { SqliteDb } from './sqlite-db.js'

/** Rows a `terminal-only` writer may hold before committing them together. */
const TERMINAL_ONLY_FLUSH_MS = 250
const READ_PAGE_ROWS = 256
interface Row { seq: number; row: string }

const parse = (text: string): JournalEvent | null => {
  try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as JournalEvent : null } catch { return null }
}

/** A run's live rows: how many, when the last was written, and their bytes as newline-terminated lines. */
interface Stat { stream_id: string; rows: number; written: number; bytes: number }
const STAT_SQL = 'SELECT stream_id, count(*) AS rows, max(written_at) AS written, sum(length(CAST(row AS BLOB)) + 1) AS bytes FROM journal_rows WHERE session_id = ?'
/** One row of a run's logical journal: its stored text, and the row when it parses as one. */
interface Line { text: string; event: JournalEvent | null }
/** A run compacted for `journal_archives`, and the archived extent it was read past. */
interface Compacted { blob: Buffer; bytes: number; lastSeq: number; previousSeq: number }

/**
 * Run journals in `journal_rows`, one row per event. Retention compacts a settled run's rows into one gzip blob in
 * `journal_archives` (TAL-1748), the SQLite form of the JSON adapter's archive; a run whose archive was removed keeps
 * only its `journal_summaries` row.
 */
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
  /** The run's last seq, past its archived prefix, so a writer reopening an archived run continues its sequence. */
  lastSeq(sessionId: string, runId: string): number {
    this.flushAll()
    const live = this.db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM journal_rows WHERE session_id = ? AND stream_id = ?', sessionId, runId)?.seq ?? 0
    return Math.max(live, this.archivedSeq(sessionId, runId) ?? 0)
  }
  private archivedSeq(sessionId: string, runId: string): number | undefined {
    return this.db.get<{ seq: number }>('SELECT last_seq AS seq FROM journal_archives WHERE session_id = ? AND stream_id = ?', sessionId, runId)?.seq
  }
  private hasLiveRows(sessionId: string, runId: string): boolean {
    return this.db.get<{ present: number }>('SELECT 1 AS present FROM journal_rows WHERE session_id = ? AND stream_id = ? LIMIT 1', sessionId, runId) !== undefined
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
    for await (const { event } of this.lines(sessionId, runId, opts)) if (event) yield event
  }
  /**
   * A run's logical journal (the JSON adapter's `runLines`): its archived rows, then the live rows past them, in seq
   * order. Each step reads the archive's extent and the next live page in one synchronous turn, so a sweep that archives
   * the run between pages moves the rest of it into the archive, never out of view. The archive is inflated and split one
   * output chunk at a time; `budget` stops that read before an oversized row is assembled or parsed.
   */
  private async *lines(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null; budget?: ReadBudget } = {}): AsyncGenerator<Line> {
    let after = opts.afterSeq ?? 0
    const max = opts.maxSeq ?? Number.MAX_SAFE_INTEGER
    for (;;) {
      this.flushAll()
      const archived = this.archivedSeq(sessionId, runId) ?? 0
      if (archived > after) {
        const blob = this.db.get<{ rows: Uint8Array }>('SELECT rows FROM journal_archives WHERE session_id = ? AND stream_id = ?', sessionId, runId)!.rows
        // The seq of the archive's last row so far: a malformed line stays in place after it, for replay to reject.
        let position = 0
        for await (const line of splitLines(gunzipChunks([Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)]), opts.budget)) {
          const event = line.event
          if (!event) { if (position >= after) yield { text: line.bytes.toString('utf8'), event: null }; continue }
          if (event.session_id !== sessionId || event.run_id !== runId) throw new JournalArchiveError('The run-journal archive belongs to another run')
          position = event.seq
          if (event.seq <= after) continue
          if (event.seq > max) return
          after = event.seq
          yield { text: line.bytes.toString('utf8'), event }
        }
        after = Math.max(after, archived)
        continue
      }
      const page = this.db.all<Row>('SELECT seq, row FROM journal_rows WHERE session_id = ? AND stream_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?', sessionId, runId, after, max, READ_PAGE_ROWS)
      if (!page.length) return
      after = page.at(-1)!.seq
      // Like reading a growing file to its end: rows appended while this page is consumed are read next.
      for (const { row } of page) yield { text: row, event: parse(row) }
    }
  }
  async readRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): Promise<JournalEvent[]> {
    const events: JournalEvent[] = []
    for await (const event of this.iterRunEvents(sessionId, runId, opts)) events.push(event)
    return events
  }
  /** The longest suffix of the run within `maxRows` rows and `maxBytes` bytes; an archived run streams through to it. */
  private async tail(sessionId: string, runId: string, maxBytes: number, maxRows: number): Promise<{ events: JournalEvent[]; truncated: boolean }> {
    this.flushAll()
    if (this.archivedSeq(sessionId, runId) !== undefined) {
      const kept: string[] = []
      let bytes = 0
      let truncated = false
      for await (const { text } of this.lines(sessionId, runId)) {
        kept.push(text)
        bytes += Buffer.byteLength(text) + 1
        while (kept.length > maxRows || bytes > maxBytes) { bytes -= Buffer.byteLength(kept.shift()!) + 1; truncated = true }
      }
      return { events: kept.flatMap((row) => parse(row) ?? []), truncated }
    }
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
  async readRunEventTail(sessionId: string, runId: string, maxBytes = LIVE_SNAPSHOT_MAX_BYTES, maxRows = LIVE_SNAPSHOT_MAX_ROWS): Promise<{ events: JournalEvent[]; truncated: boolean }> { return await this.tail(sessionId, runId, maxBytes, maxRows) }
  private prunedSummary(sessionId: string, runId: string): RunSummary | null {
    const row = this.db.get<{ summary: string }>('SELECT summary FROM journal_summaries WHERE session_id = ? AND stream_id = ?', sessionId, runId)
    return row ? parse(row.summary) as unknown as RunSummary | null : null
  }
  /**
   * The run's summary from its logical journal's tail. An archive-only run answers from the summary stored with its
   * archive, so a status lookup never inflates it; a run with neither rows nor an archive answers with its pruned summary.
   */
  private async latest(sessionId: string, runId: string): Promise<RunSummary> {
    this.flushAll()
    if (!this.hasLiveRows(sessionId, runId)) {
      const stored = this.prunedSummary(sessionId, runId)
      if (this.archivedSeq(sessionId, runId) === undefined) { if (stored) return stored }
      else { const persisted = archivedSummary(stored, sessionId, runId); if (persisted) return persisted }
    }
    return summaryFromTail(sessionId, runId, await this.tail(sessionId, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS))
  }
  async latestRunSummary(sessionId: string, runId: string): Promise<RunSummary> { return await this.latest(sessionId, runId) }
  async summary(sessionId: string, runId: string): Promise<RunSummary | null> {
    const summary = await this.latest(sessionId, runId)
    return summary.event_count || summary.journal_pruned ? summary : null
  }
  async findRunSummary(runId: string): Promise<RunSummary | null> {
    try { validateId(runId, 'run_id') } catch { return null }
    this.flushAll()
    const live = this.db.get<{ session_id: string }>('SELECT session_id FROM journal_rows WHERE stream_id = ? LIMIT 1', runId) ?? this.db.get<{ session_id: string }>('SELECT session_id FROM journal_archives WHERE stream_id = ? LIMIT 1', runId)
    if (live) return await this.latest(live.session_id, runId)
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
    return staleInterruptedEvent(await this.latest(sessionId, runId), sessionId, runId, afterSeq, now)
  }
  async sessionIds(): Promise<string[]> {
    this.flushAll()
    return this.db.all<{ id: string }>('SELECT session_id AS id FROM journal_rows UNION SELECT session_id FROM journal_archives UNION SELECT session_id FROM journal_summaries ORDER BY 1').map((r) => r.id)
  }
  async streams(sessionId: string): Promise<string[]> {
    validateId(sessionId, 'session_id')
    this.flushAll()
    return this.db.all<{ id: string }>('SELECT stream_id AS id FROM journal_rows WHERE session_id = ? UNION SELECT stream_id FROM journal_archives WHERE session_id = ? UNION SELECT stream_id FROM journal_summaries WHERE session_id = ? ORDER BY 1', sessionId, sessionId, sessionId).map((r) => r.id)
  }
  async recoveryEvents(): Promise<Map<string, Record<string, unknown>[]>> { this.check(); return readTurnJournalEvents(this.sessionDir) }
  async deleteSession(sessionId: string): Promise<boolean> {
    try { validateId(sessionId, 'session_id') } catch { return false }
    this.flushAll()
    return this.db.transaction(() => this.db.run('DELETE FROM journal_rows WHERE session_id = ?', sessionId) + this.db.run('DELETE FROM journal_archives WHERE session_id = ?', sessionId) + this.db.run('DELETE FROM journal_summaries WHERE session_id = ?', sessionId) > 0)
  }
  async importRun(sessionId: string, runId: string, run: { rows: JournalEvent[]; summary: RunSummary | null }): Promise<void> {
    validateId(sessionId, 'session_id')
    validateId(runId, 'run_id')
    this.flushAll()
    this.db.transaction(() => {
      // The imported rows replace the whole run, its archived prefix included.
      this.db.run('DELETE FROM journal_rows WHERE session_id = ? AND stream_id = ?', sessionId, runId)
      this.db.run('DELETE FROM journal_archives WHERE session_id = ? AND stream_id = ?', sessionId, runId)
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
    const live = this.db.get<{ bytes: number | null }>('SELECT sum(length(CAST(row AS BLOB)) + 1) AS bytes FROM journal_rows WHERE session_id = ?', sid)?.bytes ?? 0
    const archived = this.db.get<{ bytes: number | null }>('SELECT sum(bytes) AS bytes FROM journal_archives WHERE session_id = ?', sid)?.bytes ?? 0
    if (live + archived > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
    let retainedRows = 0
    let retainedBytes = 0
    /** Contiguous rows of one run from `afterSeq + 1`, within the replay's byte and row budget. */
    const take = async (runId: string, afterSeq: number): Promise<SessionJournalReplay> => {
      const events: JournalEvent[] = []
      let expected = afterSeq + 1
      try {
        for await (const { text, event } of this.lines(sid, runId, { afterSeq, budget: { remaining: SESSION_REPLAY_MAX_BYTES - retainedBytes } })) {
          retainedBytes += Buffer.byteLength(text) + 1
          if (retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
          if (!event) return result('replay_malformed')
          if (event.seq !== expected || event.event_id !== `${runId}:${String(expected)}` || event.run_id !== runId || event.session_id !== sid) return result('replay_noncontiguous')
          expected += 1
          if (++retainedRows > SESSION_REPLAY_MAX_ROWS) return result('replay_limit_rows')
          events.push(event)
        }
      } catch (error) {
        if (error instanceof JournalReadLimit) return result('replay_limit_bytes')
        if (error instanceof JournalArchiveError) return result('replay_unreadable')
        throw error
      }
      return result('ok', events)
    }
    const runs: { createdAt: number; runId: string; events: JournalEvent[] }[] = []
    const positions = new Map<string, { seq: number; archived: boolean }>()
    const listed = this.db.all<{ stream_id: string; written: number; archived: number }>('SELECT stream_id, max(written) AS written, max(archived) AS archived FROM (SELECT stream_id, written_at AS written, 0 AS archived FROM journal_rows WHERE session_id = ? UNION ALL SELECT stream_id, archived_at, 1 FROM journal_archives WHERE session_id = ?) GROUP BY stream_id ORDER BY stream_id', sid, sid)
    for (const { stream_id: runId, written, archived: isArchived } of listed) {
      const taken = await take(runId, 0)
      if (taken.status !== 'ok') return taken
      // An archived run has no live position to continue from; its active tail always asks for a snapshot.
      positions.set(runId, { seq: taken.events.at(-1)?.seq ?? 0, archived: Boolean(isArchived) })
      let createdAt = Number.POSITIVE_INFINITY
      for (const event of taken.events) createdAt = Math.min(createdAt, event.created_at || 0)
      runs.push({ createdAt: Number.isFinite(createdAt) ? createdAt : written, runId, events: taken.events })
    }
    runs.sort((a, b) => a.createdAt - b.createdAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
    const cursorIndex = runs.findIndex((run) => run.runId === cursorRunId)
    if (cursorIndex < 0) {
      if (this.db.get('SELECT 1 AS present FROM journal_summaries WHERE session_id = ? AND stream_id = ?', sid, cursorRunId)) return result('cursor_pruned')
      const foreign = this.db.get('SELECT 1 AS present FROM journal_rows WHERE stream_id = ? AND session_id <> ? UNION ALL SELECT 1 FROM journal_archives WHERE stream_id = ? AND session_id <> ? LIMIT 1', cursorRunId, sid, cursorRunId, sid)
      return result(foreign ? 'cursor_session_mismatch' : 'cursor_run_missing')
    }
    const cursorEvents = runs[cursorIndex]!.events
    if (cursorSeq === null || cursorSeq > cursorEvents.length) return result('cursor_event_missing')
    const replay = cursorEvents.filter((event) => event.seq > cursorSeq)
    for (const run of runs.slice(cursorIndex + 1)) replay.push(...run.events)
    return { ...result('ok', replay), readActiveTail: async (runId) => {
      const previous = positions.get(runId)
      if (previous?.archived) return result('replay_changed')
      try {
        this.flushAll()
        // A run may finish between idle polls; the active tail alone cannot recover that history.
        const current = this.db.all<{ id: string }>('SELECT DISTINCT stream_id AS id FROM journal_rows WHERE session_id = ?', sid)
        if (current.some(({ id }) => id !== runId && !positions.has(id))) return result('replay_changed')
        const seq = previous?.seq ?? 0
        const last = this.db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM journal_rows WHERE session_id = ? AND stream_id = ?', sid, runId)?.seq ?? 0
        if (last < seq || this.archivedSeq(sid, runId) !== undefined) return result('replay_changed')
        const taken = await take(runId, seq)
        if (taken.status === 'ok') positions.set(runId, { seq: taken.events.at(-1)?.seq ?? seq, archived: false })
        return taken
      } catch { return result('replay_changed') }
    } }
  }

  async prune(olderThan: number): Promise<number> { return (await this.pruneSettled({ now: olderThan + 1, retentionSeconds: 1 })).pruned }
  /**
   * Python `prune_settled_run_journals`, with the JSON adapter's semantics: compact settled runs into `journal_archives`
   * and remove their live rows, in one transaction. A run is due when it is older than the retention cutoff, or while
   * its session holds more live runs or bytes than the soft per-session budgets, oldest first. The `keep` newest terminal
   * runs, nonterminal runs, live writers and runs the session still names stay live even past a budget; a session whose
   * state cannot be read stays live whole. Past the instance archive budget the oldest archives go, keeping their
   * summaries. Yields after every session and parsed run, like the JSON sweep.
   */
  async pruneSettled(opts: PruneOptions = {}): Promise<PruneResult> {
    const result: PruneResult = { examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0, archives_removed: 0 }
    const { retention, keep, maxRuns, maxBytes, maxArchiveBytes, now, cutoff } = pruneRetention(this.env, opts)
    const stopped = (): boolean => Boolean(opts.signal?.aborted) || this.closed
    const proceed = async (): Promise<boolean> => { await (opts.pause ?? nextTurn)(); return !stopped() }
    if (retention <= 0) return result
    const references = async (sid: string): Promise<ReadonlySet<string> | null> => {
      if (!opts.protectedRuns) return new Set()
      try { return await opts.protectedRuns(sid) } catch { return null }
    }
    this.flushAll()
    for (const { id: sid } of this.db.all<{ id: string }>('SELECT DISTINCT session_id AS id FROM journal_rows ORDER BY 1')) {
      if (!(await proceed())) return result
      this.flushAll()
      const runs = this.db.all<Stat>(`${STAT_SQL} GROUP BY stream_id ORDER BY stream_id`, sid)
      result.examined += runs.length
      let liveRuns = runs.length
      let liveBytes = runs.reduce((total, run) => total + run.bytes, 0)
      const overBudget = (): boolean => (maxRuns > 0 && liveRuns > maxRuns) || (maxBytes > 0 && liveBytes > maxBytes)
      if (runs.length <= keep || (!runs.some((run) => run.written <= cutoff) && !overBudget())) continue
      const named = await references(sid)
      if (!named) continue
      const terminalRuns: { run: Stat; summary: RunSummary; archived: { event_count: number; journal_truncated: boolean } }[] = []
      for (const run of runs) {
        let tail: { events: JournalEvent[]; truncated: boolean } | null
        try { tail = await this.tail(sid, run.stream_id, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS) } catch { tail = null }
        const summary = tail && summaryFromEvents(sid, run.stream_id, tail.events)
        if (tail && summary?.terminal) {
          result.terminal += 1
          terminalRuns.push({ run, summary, archived: { event_count: summaryFromTail(sid, run.stream_id, tail).event_count, journal_truncated: tail.truncated } })
        }
        if (!(await proceed())) return result
      }
      terminalRuns.sort((a, b) => b.run.written - a.run.written || b.run.stream_id.localeCompare(a.run.stream_id))
      // Oldest first, so the budgets archive the oldest settled runs. Each run commits once compacted, so the sweep holds
      // one compressed run at a time.
      for (const { run, summary, archived } of terminalRuns.slice(keep).reverse()) {
        if (stopped()) return result
        const rid = run.stream_id
        if ((run.written > cutoff && !overBudget()) || named.has(rid) || this.busy(sid, rid, opts)) continue
        if (opts.dryRun) { result.pruned += 1; result.bytes_reclaimed += run.bytes; liveRuns -= 1; liveBytes -= run.bytes; continue }
        const archive = await this.compact(sid, rid)
        if (!archive) continue
        liveRuns -= 1
        liveBytes -= run.bytes
        // Recheck after the async compaction: the session may now name the run, or the run may have changed or been deleted.
        const current = await references(sid)
        if (!current || this.closed) continue
        this.flushAll()
        const stat = this.db.get<Stat>(`${STAT_SQL} AND stream_id = ? GROUP BY stream_id`, sid, rid)
        if (current.has(rid) || this.busy(sid, rid, opts) || stat?.rows !== run.rows || stat.written !== run.written || stat.bytes !== run.bytes || (this.archivedSeq(sid, rid) ?? 0) !== archive.previousSeq) continue
        // The legacy fields stay as the JSON adapter writes them; `archived` carries the lookup summary.
        const stored = JSON.stringify({ ...summary, journal_pruned: true, journal_pruned_at: now, original_size: run.bytes, original_mtime: run.written, archived })
        this.db.transaction(() => {
          this.db.run('INSERT INTO journal_archives (session_id, stream_id, rows, bytes, last_seq, archived_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, stream_id) DO UPDATE SET rows = excluded.rows, bytes = excluded.bytes, last_seq = excluded.last_seq, archived_at = excluded.archived_at', sid, rid, archive.blob, archive.bytes, archive.lastSeq, now)
          this.db.run('INSERT INTO journal_summaries (session_id, stream_id, summary) VALUES (?, ?, ?) ON CONFLICT (session_id, stream_id) DO UPDATE SET summary = excluded.summary', sid, rid, stored)
          this.db.run('DELETE FROM journal_rows WHERE session_id = ? AND stream_id = ?', sid, rid)
        })
        result.pruned += 1
        result.bytes_reclaimed += run.bytes
      }
    }
    if (maxArchiveBytes > 0) this.trimArchives(maxArchiveBytes, opts, result)
    return result
  }

  private busy(sessionId: string, runId: string, opts: PruneOptions): boolean {
    return [...this.writers].some((writer) => writer.sessionId === sessionId && writer.runId === runId) || Boolean(opts.isActive?.(`${sessionId}/${runId}`))
  }

  /**
   * The run's logical journal as newline-terminated rows, streamed through gzip off the event loop, so only the
   * compressed archive is held; null when it cannot be read.
   */
  private async compact(sessionId: string, runId: string): Promise<Compacted | null> {
    const previousSeq = this.archivedSeq(sessionId, runId) ?? 0
    const lines = this.lines(sessionId, runId)
    const compressed: Buffer[] = []
    let bytes = 0
    let lastSeq = 0
    try {
      await pipeline(async function* () {
        for await (const { text, event } of lines) {
          const row = Buffer.from(`${text}\n`)
          bytes += row.length
          lastSeq = Math.max(lastSeq, event?.seq ?? 0)
          yield row
        }
      }, createGzip(), async (source: AsyncIterable<Buffer>) => { for await (const chunk of source) compressed.push(chunk) })
    } catch { return null }
    return { blob: Buffer.concat(compressed), bytes, lastSeq, previousSeq }
  }

  /**
   * Remove the oldest archives while the instance's archived bytes exceed `maxArchiveBytes`. A removed run keeps the
   * summary stored with its archive and reads as pruned history. An archive whose run still has live rows (its
   * continuation needs the prefix), a live writer, or no pruned summary stays. Synchronous, so nothing changes between
   * a check and its delete.
   */
  private trimArchives(maxArchiveBytes: number, opts: PruneOptions, result: PruneResult): void {
    this.flushAll()
    let total = this.db.get<{ bytes: number | null }>('SELECT sum(length(rows)) AS bytes FROM journal_archives')?.bytes ?? 0
    if (total <= maxArchiveBytes) return
    for (const { session_id: sid, stream_id: rid, size } of this.db.all<{ session_id: string; stream_id: string; size: number }>('SELECT session_id, stream_id, length(rows) AS size FROM journal_archives ORDER BY archived_at, session_id, stream_id')) {
      if (total <= maxArchiveBytes || opts.signal?.aborted) return
      if (this.hasLiveRows(sid, rid) || this.busy(sid, rid, opts) || this.prunedSummary(sid, rid)?.journal_pruned !== true) continue
      if (!opts.dryRun) this.db.run('DELETE FROM journal_archives WHERE session_id = ? AND stream_id = ?', sid, rid)
      total -= size
      result.archives_removed += 1
    }
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
