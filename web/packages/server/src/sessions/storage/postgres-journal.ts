import { setImmediate as nextTurn } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { LIVE_SNAPSHOT_MAX_BYTES, LIVE_SNAPSHOT_MAX_ROWS, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS, SESSION_REPLAY_MAX_BYTES, SESSION_REPLAY_MAX_ROWS, archivedSummary, journalEvent, parseRunJournalEventId, pruneRetention, staleInterruptedEvent, summaryFromEvents, summaryFromTail, validateId, type JournalEvent, type PruneOptions, type PruneResult, type RunSummary } from '../journal.js'
import type { JournalBackend, JournalEventMeta, JournalInput, JournalWriter, SessionJournalReplay } from './backend.js'
import { readTurnJournalEvents } from './json-journal.js'
import { JournalArchiveError, JournalReadLimit, gunzipChunks, splitLines, type ReadBudget } from './json-journal-archive.js'
import type { PgDb } from './postgres-db.js'

/** How long a `terminal-only` writer holds rows before committing them together. */
const TERMINAL_ONLY_FLUSH_MS = 250
const READ_PAGE_ROWS = 256
/** The largest `seq` an `integer` column holds; an open-ended read stops here. */
const MAX_SEQ = 2 ** 31 - 1
const clampSeq = (seq: number): number => Math.min(Math.max(seq, 0), MAX_SEQ)

const parse = (text: string): JournalEvent | null => {
  try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as JournalEvent : null } catch { return null }
}

/** A run's live rows: how many, when the last was written, and their bytes as newline-terminated lines. */
interface Stat { stream_id: string; rows: number; written: number; bytes: number }
interface StatRow { stream_id: string; rows: number; written: number; bytes: string }
const stat = (row: StatRow): Stat => ({ stream_id: row.stream_id, rows: row.rows, written: row.written, bytes: Number(row.bytes) })
/** One row of a run's logical journal: its stored text, and the row when it parses as one. */
interface Line { text: string; event: JournalEvent | null }
/** A run compacted for `journal_archives`, and the archived extent it was read past. */
interface Compacted { blob: Buffer; bytes: number; lastSeq: number; previousSeq: number }

/**
 * Run journals in `journal_rows`, one row per event: the Postgres form of the SQLite adapter, with the same archive
 * (TAL-1748) and summary tables. A read that depends on both a run's archive and its live rows asks for both in one
 * statement, so retention archiving the run between two reads never hides rows.
 */
export class PostgresJournal implements JournalBackend {
  private readonly writers = new Set<PostgresJournalWriter>()
  private closed = false
  constructor(private readonly db: PgDb, private readonly sessionDir: string, private readonly env: Record<string, string | undefined> = {}) {}
  private get s(): string { return this.db.s }

  private check(): void { if (this.closed) throw new Error('Storage is closed'); this.db.check() }
  /** Readers see every appended row: buffered `terminal-only` rows commit first. */
  private async flushAll(): Promise<void> {
    this.check()
    await Promise.all([...this.writers].map(async (writer) => { await writer.flush() }))
  }
  /** A writer's held rows as one multi-row insert: one statement, so one round trip that commits all of them or none. */
  async commit(sessionId: string, runId: string, rows: readonly JournalEvent[]): Promise<void> {
    await this.db.run(`INSERT INTO ${this.s}journal_rows (session_id, stream_id, seq, row, written_at) SELECT $1, $2, u.seq, u.row, $5 FROM unnest($3::integer[], $4::text[]) AS u(seq, row)`,
      sessionId, runId, rows.map((row) => row.seq), rows.map((row) => JSON.stringify(row)), Date.now() / 1000)
  }
  /** The run's last seq, past its archived prefix, so a writer reopening an archived run continues its sequence. */
  async lastSeq(sessionId: string, runId: string): Promise<number> {
    await this.flushAll()
    const row = await this.db.row<{ live: number | null; archived: number | null }>(`SELECT (SELECT max(seq) FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2) AS live, (SELECT last_seq FROM ${this.s}journal_archives WHERE session_id = $1 AND stream_id = $2) AS archived`, sessionId, runId)
    return Math.max(row?.live ?? 0, row?.archived ?? 0)
  }
  private async prunedSummary(sessionId: string, runId: string): Promise<RunSummary | null> {
    const row = await this.db.row<{ summary: string }>(`SELECT summary FROM ${this.s}journal_summaries WHERE session_id = $1 AND stream_id = $2`, sessionId, runId)
    return row ? parse(row.summary) as unknown as RunSummary | null : null
  }
  release(writer: PostgresJournalWriter): void { this.writers.delete(writer) }

  async open(sessionId: string, runId: string, opts: { durability: 'eager' | 'terminal-only' }): Promise<PostgresJournalWriter> {
    this.check()
    const sid = validateId(sessionId, 'session_id')
    const rid = validateId(runId, 'run_id')
    const writer = new PostgresJournalWriter(this, sid, rid, opts.durability, await this.lastSeq(sid, rid))
    this.writers.add(writer)
    return writer
  }
  async writer(sessionId: string, runId: string): Promise<PostgresJournalWriter> {
    const mode = (this.env.HERMES_WEBUI_RUN_JOURNAL_FSYNC ?? 'terminal-only').trim().toLowerCase()
    return await this.open(sessionId, runId, { durability: mode === 'eager' ? 'eager' : 'terminal-only' })
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
   * order. Each step reads the archive's extent and the next live page in one statement, so a sweep that archives the
   * run between pages moves the rest of it into the archive, never out of view. The archive is inflated and split one
   * output chunk at a time; `budget` stops that read before an oversized row is assembled or parsed.
   */
  private async *lines(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null; budget?: ReadBudget } = {}): AsyncGenerator<Line> {
    let after = clampSeq(opts.afterSeq ?? 0)
    const max = clampSeq(opts.maxSeq ?? MAX_SEQ)
    for (;;) {
      await this.flushAll()
      const page = await this.db.rows<{ archived: number | null; blob: Buffer | null; seq: number | null; row: string | null }>(`SELECT a.last_seq AS archived, CASE WHEN a.last_seq > $3 THEN a.rows END AS blob, p.seq, p.row
        FROM (SELECT 1) AS one
        LEFT JOIN ${this.s}journal_archives a ON a.session_id = $1 AND a.stream_id = $2
        LEFT JOIN LATERAL (SELECT seq, row FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2 AND seq > $3 AND seq <= $4 ORDER BY seq LIMIT $5) p ON coalesce(a.last_seq, 0) <= $3
        ORDER BY p.seq`, sessionId, runId, after, max, READ_PAGE_ROWS)
      const archived = page[0]?.archived ?? 0
      const blob = page[0]?.blob
      if (archived > after && blob) {
        // The seq of the archive's last row so far: a malformed line stays in place after it, for replay to reject.
        let position = 0
        for await (const line of splitLines(gunzipChunks([blob]), opts.budget)) {
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
      const rows = page.filter((row): row is typeof row & { seq: number; row: string } => row.seq !== null)
      if (!rows.length) return
      after = rows.at(-1)!.seq
      // Like reading a growing file to its end: rows appended while this page is consumed are read next.
      for (const { row } of rows) yield { text: row, event: parse(row) }
    }
  }
  async readRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): Promise<JournalEvent[]> {
    const events: JournalEvent[] = []
    for await (const event of this.iterRunEvents(sessionId, runId, opts)) events.push(event)
    return events
  }
  /** The longest suffix of the run within `maxRows` rows and `maxBytes` bytes; an archived run streams through to it. */
  private async tail(sessionId: string, runId: string, maxBytes: number, maxRows: number): Promise<{ events: JournalEvent[]; truncated: boolean }> {
    await this.flushAll()
    const newest = await this.db.rows<{ archived: number | null; seq: number | null; row: string | null }>(`SELECT a.last_seq AS archived, r.seq, r.row
      FROM (SELECT 1) AS one
      LEFT JOIN ${this.s}journal_archives a ON a.session_id = $1 AND a.stream_id = $2
      LEFT JOIN LATERAL (SELECT seq, row FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2 ORDER BY seq DESC LIMIT $3) r ON a.last_seq IS NULL
      ORDER BY r.seq DESC`, sessionId, runId, maxRows + 1)
    if (newest[0]?.archived != null) {
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
    const rows = newest.flatMap(({ row }) => row === null ? [] : [row])
    const kept: string[] = []
    let bytes = 0
    for (const row of rows.slice(0, maxRows)) {
      bytes += Buffer.byteLength(row) + 1
      if (bytes > maxBytes) break
      kept.push(row)
    }
    return { events: kept.reverse().flatMap((row) => parse(row) ?? []), truncated: kept.length < rows.length }
  }
  async readRunEventTail(sessionId: string, runId: string, maxBytes = LIVE_SNAPSHOT_MAX_BYTES, maxRows = LIVE_SNAPSHOT_MAX_ROWS): Promise<{ events: JournalEvent[]; truncated: boolean }> { return await this.tail(sessionId, runId, maxBytes, maxRows) }
  /**
   * The run's summary from its logical journal's tail. An archive-only run answers from the summary stored with its
   * archive, so a status lookup never inflates it; a run with neither rows nor an archive answers with its pruned summary.
   */
  private async latest(sessionId: string, runId: string): Promise<RunSummary> {
    await this.flushAll()
    const state = await this.db.row<{ live: boolean; summary: string | null; archived: number | null }>(`SELECT
      EXISTS (SELECT 1 FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2) AS live,
      (SELECT summary FROM ${this.s}journal_summaries WHERE session_id = $1 AND stream_id = $2) AS summary,
      (SELECT last_seq FROM ${this.s}journal_archives WHERE session_id = $1 AND stream_id = $2) AS archived`, sessionId, runId)
    if (state && !state.live) {
      const stored = state.summary === null ? null : parse(state.summary) as unknown as RunSummary | null
      if (state.archived === null) { if (stored) return stored }
      else { const persisted = archivedSummary(stored, sessionId, runId); if (persisted) return persisted }
    }
    return summaryFromTail(sessionId, runId, await this.tail(sessionId, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS))
  }
  async latestRunSummary(sessionId: string, runId: string): Promise<RunSummary> { return await this.latest(sessionId, runId) }
  async summary(sessionId: string, runId: string): Promise<RunSummary | null> {
    const summary = await this.latest(sessionId, runId)
    return summary.event_count || summary.journal_pruned ? summary : null
  }
  async findRunSummary(runId: string, sessionId?: string): Promise<RunSummary | null> {
    try { validateId(runId, 'run_id') } catch { return null }
    await this.flushAll()
    // A session restriction selects within that session, so a run ID another session also holds never hides it.
    const owner = async (table: string): Promise<{ session_id: string } | undefined> => sessionId === undefined
      ? await this.db.row<{ session_id: string }>(`SELECT session_id FROM ${this.s}${table} WHERE stream_id = $1 LIMIT 1`, runId)
      : await this.db.row<{ session_id: string }>(`SELECT session_id FROM ${this.s}${table} WHERE stream_id = $1 AND session_id = $2 LIMIT 1`, runId, sessionId)
    const live = await owner('journal_rows') ?? await owner('journal_archives')
    if (live) return await this.latest(live.session_id, runId)
    const pruned = await owner('journal_summaries')
    return pruned ? await this.prunedSummary(pruned.session_id, runId) : null
  }
  async sessionJournalFingerprint(sessionId: string): Promise<string> {
    try { validateId(sessionId, 'session_id') } catch { return '0:0:0' }
    await this.flushAll()
    const row = await this.db.row<{ runs: number; written: number | null; bytes: string | null }>(`SELECT count(DISTINCT stream_id)::integer AS runs, max(written_at) AS written, sum(char_length(row)) AS bytes FROM ${this.s}journal_rows WHERE session_id = $1`, sessionId)
    return `${String(row?.runs ?? 0)}:${String((row?.written ?? 0) * 1000)}:${row?.bytes ?? '0'}`
  }
  async staleInterruptedEvent(sessionId: string, runId: string, afterSeq: number | null = null, now = Date.now() / 1000): Promise<JournalEvent | null> {
    return staleInterruptedEvent(await this.latest(sessionId, runId), sessionId, runId, afterSeq, now)
  }
  async sessionIds(): Promise<string[]> {
    await this.flushAll()
    return (await this.db.rows<{ id: string }>(`SELECT id FROM (SELECT session_id AS id FROM ${this.s}journal_rows UNION SELECT session_id FROM ${this.s}journal_archives UNION SELECT session_id FROM ${this.s}journal_summaries) AS ids ORDER BY id COLLATE "C"`)).map((r) => r.id)
  }
  async streams(sessionId: string): Promise<string[]> {
    validateId(sessionId, 'session_id')
    await this.flushAll()
    return (await this.db.rows<{ id: string }>(`SELECT id FROM (SELECT stream_id AS id FROM ${this.s}journal_rows WHERE session_id = $1 UNION SELECT stream_id FROM ${this.s}journal_archives WHERE session_id = $1 UNION SELECT stream_id FROM ${this.s}journal_summaries WHERE session_id = $1) AS ids ORDER BY id COLLATE "C"`, sessionId)).map((r) => r.id)
  }
  async recoveryEvents(): Promise<Map<string, Record<string, unknown>[]>> { this.check(); return await Promise.resolve(readTurnJournalEvents(this.sessionDir)) }
  async deleteSession(sessionId: string): Promise<boolean> {
    try { validateId(sessionId, 'session_id') } catch { return false }
    await this.flushAll()
    return await this.db.transaction(async (tx) => {
      let removed = 0
      for (const table of ['journal_rows', 'journal_archives', 'journal_summaries']) removed += await tx.run(`DELETE FROM ${this.s}${table} WHERE session_id = $1`, sessionId)
      return removed > 0
    })
  }
  async importRun(sessionId: string, runId: string, run: { rows: JournalEvent[]; summary: RunSummary | null }): Promise<void> {
    validateId(sessionId, 'session_id')
    validateId(runId, 'run_id')
    await this.flushAll()
    await this.db.transaction(async (tx) => {
      // The imported rows replace the whole run, its archived prefix included.
      for (const table of ['journal_rows', 'journal_archives', 'journal_summaries']) await tx.run(`DELETE FROM ${this.s}${table} WHERE session_id = $1 AND stream_id = $2`, sessionId, runId)
      // Retention counts from a run's last row, not from when it was copied.
      if (run.rows.length) {
        await tx.run(`INSERT INTO ${this.s}journal_rows (session_id, stream_id, seq, row, written_at) SELECT $1, $2, u.seq, u.row, u.written FROM unnest($3::integer[], $4::text[], $5::double precision[]) AS u(seq, row, written)`,
          sessionId, runId, run.rows.map((row) => row.seq), run.rows.map((row) => JSON.stringify(row)), run.rows.map((row) => row.created_at || Date.now() / 1000))
      }
      if (run.summary) await tx.run(`INSERT INTO ${this.s}journal_summaries (session_id, stream_id, summary) VALUES ($1, $2, $3)`, sessionId, runId, JSON.stringify(run.summary))
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
    await this.flushAll()
    // The whole session's rows are read below; refuse before reading more than one replay may hold.
    const size = await this.db.row<{ live: string | null; archived: string | null }>(`SELECT (SELECT sum(octet_length(row) + 1) FROM ${this.s}journal_rows WHERE session_id = $1) AS live, (SELECT sum(bytes) FROM ${this.s}journal_archives WHERE session_id = $1) AS archived`, sid)
    if (Number(size?.live ?? 0) + Number(size?.archived ?? 0) > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
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
    const listed = await this.db.rows<{ stream_id: string; written: number; archived: number }>(`SELECT stream_id, max(written) AS written, max(archived) AS archived
      FROM (SELECT stream_id, written_at AS written, 0 AS archived FROM ${this.s}journal_rows WHERE session_id = $1 UNION ALL SELECT stream_id, archived_at, 1 FROM ${this.s}journal_archives WHERE session_id = $1) AS runs
      GROUP BY stream_id ORDER BY stream_id COLLATE "C"`, sid)
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
      if (await this.db.row(`SELECT 1 FROM ${this.s}journal_summaries WHERE session_id = $1 AND stream_id = $2`, sid, cursorRunId)) return result('cursor_pruned')
      const foreign = await this.db.row(`SELECT 1 FROM ${this.s}journal_rows WHERE stream_id = $1 AND session_id <> $2 UNION ALL SELECT 1 FROM ${this.s}journal_archives WHERE stream_id = $1 AND session_id <> $2 LIMIT 1`, cursorRunId, sid)
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
        await this.flushAll()
        // A run may finish between idle polls; the active tail alone cannot recover that history.
        const current = await this.db.rows<{ id: string }>(`SELECT DISTINCT stream_id AS id FROM ${this.s}journal_rows WHERE session_id = $1`, sid)
        if (current.some(({ id }) => id !== runId && !positions.has(id))) return result('replay_changed')
        const seq = previous?.seq ?? 0
        const state = await this.db.row<{ last: number | null; archived: number | null }>(`SELECT (SELECT max(seq) FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2) AS last, (SELECT last_seq FROM ${this.s}journal_archives WHERE session_id = $1 AND stream_id = $2) AS archived`, sid, runId)
        if ((state?.last ?? 0) < seq || state?.archived != null) return result('replay_changed')
        const taken = await take(runId, seq)
        if (taken.status === 'ok') positions.set(runId, { seq: taken.events.at(-1)?.seq ?? seq, archived: false })
        return taken
      } catch { return result('replay_changed') }
    } }
  }

  async prune(olderThan: number): Promise<number> { return (await this.pruneSettled({ now: olderThan + 1, retentionSeconds: 1 })).pruned }
  /**
   * Python `prune_settled_run_journals`, with the other adapters' semantics: compact settled runs into
   * `journal_archives` and remove their live rows, in one transaction. A run is due when it is older than the retention
   * cutoff, or while its session holds more live runs or bytes than the soft per-session budgets, oldest first. The
   * `keep` newest terminal runs, nonterminal runs, live writers and runs the session still names stay live even past a
   * budget; a session whose state cannot be read stays live whole. Past the instance archive budget the oldest archives
   * go, keeping their summaries. Yields after every session and parsed run, like the JSON sweep.
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
    const STAT_SQL = `SELECT stream_id, count(*)::integer AS rows, max(written_at) AS written, sum(octet_length(row) + 1) AS bytes FROM ${this.s}journal_rows WHERE session_id = $1`
    await this.flushAll()
    for (const { id: sid } of await this.db.rows<{ id: string }>(`SELECT session_id AS id FROM ${this.s}journal_rows GROUP BY session_id ORDER BY session_id COLLATE "C"`)) {
      if (!(await proceed())) return result
      await this.flushAll()
      const runs = (await this.db.rows<StatRow>(`${STAT_SQL} GROUP BY stream_id ORDER BY stream_id COLLATE "C"`, sid)).map(stat)
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
        if (!current || this.closed || current.has(rid) || this.busy(sid, rid, opts)) continue
        await this.flushAll()
        // The legacy fields stay as the JSON adapter writes them; `archived` carries the lookup summary.
        const stored = JSON.stringify({ ...summary, journal_pruned: true, journal_pruned_at: now, original_size: run.bytes, original_mtime: run.written, archived })
        const committed = await this.db.transaction(async (tx) => {
          const previous = (await tx.row<{ seq: number }>(`SELECT last_seq AS seq FROM ${this.s}journal_archives WHERE session_id = $1 AND stream_id = $2 FOR UPDATE`, sid, rid))?.seq ?? 0
          const latest = await tx.row<StatRow>(`${STAT_SQL} AND stream_id = $2 GROUP BY stream_id`, sid, rid)
          if (!latest || previous !== archive.previousSeq || latest.rows !== run.rows || latest.written !== run.written || Number(latest.bytes) !== run.bytes) return false
          await tx.run(`INSERT INTO ${this.s}journal_archives (session_id, stream_id, rows, bytes, last_seq, archived_at) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (session_id, stream_id) DO UPDATE SET rows = excluded.rows, bytes = excluded.bytes, last_seq = excluded.last_seq, archived_at = excluded.archived_at`, sid, rid, archive.blob, archive.bytes, archive.lastSeq, now)
          await tx.run(`INSERT INTO ${this.s}journal_summaries (session_id, stream_id, summary) VALUES ($1, $2, $3) ON CONFLICT (session_id, stream_id) DO UPDATE SET summary = excluded.summary`, sid, rid, stored)
          // Only the rows the archive holds: one appended since compaction stays live past it.
          await tx.run(`DELETE FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2 AND seq <= $3`, sid, rid, archive.lastSeq)
          return true
        })
        if (!committed) continue
        result.pruned += 1
        result.bytes_reclaimed += run.bytes
      }
    }
    if (maxArchiveBytes > 0) await this.trimArchives(maxArchiveBytes, opts, result)
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
    const previousSeq = (await this.db.row<{ seq: number }>(`SELECT last_seq AS seq FROM ${this.s}journal_archives WHERE session_id = $1 AND stream_id = $2`, sessionId, runId))?.seq ?? 0
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
   * continuation needs the prefix), a live writer, or no pruned summary stays; the delete itself rechecks live rows.
   */
  private async trimArchives(maxArchiveBytes: number, opts: PruneOptions, result: PruneResult): Promise<void> {
    await this.flushAll()
    let total = Number((await this.db.row<{ bytes: string | null }>(`SELECT sum(octet_length(rows)) AS bytes FROM ${this.s}journal_archives`))?.bytes ?? 0)
    if (total <= maxArchiveBytes) return
    for (const { session_id: sid, stream_id: rid, size } of await this.db.rows<{ session_id: string; stream_id: string; size: number }>(`SELECT session_id, stream_id, octet_length(rows) AS size FROM ${this.s}journal_archives ORDER BY archived_at, session_id COLLATE "C", stream_id COLLATE "C"`)) {
      if (total <= maxArchiveBytes || opts.signal?.aborted) return
      if (this.busy(sid, rid, opts) || (await this.prunedSummary(sid, rid))?.journal_pruned !== true) continue
      if (!opts.dryRun && !await this.db.run(`DELETE FROM ${this.s}journal_archives WHERE session_id = $1 AND stream_id = $2 AND NOT EXISTS (SELECT 1 FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2)`, sid, rid)) continue
      if (opts.dryRun && await this.db.row(`SELECT 1 FROM ${this.s}journal_rows WHERE session_id = $1 AND stream_id = $2 LIMIT 1`, sid, rid)) continue
      total -= size
      result.archives_removed += 1
    }
  }
}

/**
 * `eager` commits every row before `append` resolves. `terminal-only` holds rows and commits them together, in one
 * multi-row insert, on the terminal row or after 250 ms, whichever comes first. Commits run one at a time, in order.
 */
export class PostgresJournalWriter implements JournalWriter {
  private buffer: JournalEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private flushing: Promise<void> = Promise.resolve()
  constructor(private readonly journal: PostgresJournal, readonly sessionId: string, readonly runId: string, private readonly durability: 'eager' | 'terminal-only', private seq: number, private readonly now: () => number = () => Date.now() / 1000) {}
  async append(row: JournalInput, opts: { terminal: boolean }): Promise<JournalEvent> { return await this.write(row.event, row.payload, { ...(row.redacted === undefined ? {} : { redacted: row.redacted }), ...(row.created_at === undefined ? {} : { createdAt: row.created_at }) }, opts.terminal) }
  async appendSseEvent(eventName: string, payload: unknown, meta: JournalEventMeta = {}): Promise<JournalEvent> { return await this.write(eventName, payload, meta) }
  private async write(eventName: string, payload: unknown, meta: JournalEventMeta, terminal?: boolean): Promise<JournalEvent> {
    if (this.closed) throw new Error('run journal writer is closed')
    const name = eventName.trim()
    if (!name) throw new Error('event_name is required')
    const event = journalEvent(this.sessionId, this.runId, this.seq + 1, name, payload, { terminal, createdAt: meta.createdAt ?? this.now(), redacted: meta.redacted })
    this.buffer.push(event)
    this.seq += 1
    if (this.durability === 'eager' || event.terminal) {
      try { await this.flush() } catch (error) {
        // The failed row was never written: drop it and reuse its seq, unless a later row already follows it.
        if (this.buffer.at(-1) === event && this.seq === event.seq) { this.buffer.pop(); this.seq -= 1 }
        throw error
      }
    }
    else this.timer ??= setTimeout(() => { this.timer = null; this.flush().catch(() => { /* the next append or read retries */ }) }, TERMINAL_ONLY_FLUSH_MS).unref()
    return event
  }
  /** Commits held rows after any commit already under way; on failure they stay held for the next attempt. */
  flush(): Promise<void> {
    const run = this.flushing.then(async () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      if (!this.buffer.length) return
      const rows = this.buffer
      this.buffer = []
      try { await this.journal.commit(this.sessionId, this.runId, rows) } catch (error) { this.buffer = [...rows, ...this.buffer]; throw error }
    })
    this.flushing = run.catch(() => undefined)
    return run
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { await this.flush() } finally { this.journal.release(this) }
  }
}
