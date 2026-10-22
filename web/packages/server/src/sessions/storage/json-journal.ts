/* eslint-disable @typescript-eslint/require-await -- Synchronous JSON transactions implement the async storage port. */
import { rmSync } from 'node:fs'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, constants as fsConstants, type BigIntStats } from 'node:fs'
import { open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { atomicWriteTextAsync, writeFully } from '../../fs/atomic.js'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'


import { RUN_JOURNAL_DIR_NAME, SSE_RELAY_CLOSE_EVENTS, validateId, parseRunJournalEventId, terminalStateForEvent, selectAuthoritativeTerminalEvent, summaryFromEvents, type JournalEvent, type RunSummary, type PruneOptions, type PruneResult } from '../journal.js'
import type { JournalBackend, JournalEventMeta, JournalInput, SessionJournalReplay } from './backend.js'
const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/
const SESSION_REPLAY_MAX_BYTES = 4 * 1024 * 1024
const SESSION_REPLAY_MAX_ROWS = 4096
const LIVE_SNAPSHOT_MAX_BYTES = 1024 * 1024
const LIVE_SNAPSHOT_MAX_ROWS = 512
const RUN_SUMMARY_MAX_BYTES = 4 * 1024 * 1024
const RUN_SUMMARY_MAX_ROWS = 512
const RUN_EVENTS_PAGE_BYTES = 64 * 1024
const PRUNED_SUMMARY_SUFFIX = '.summary.json'
const RUN_OWNER_CACHE_MAX = 1000

const TURN_JOURNAL_DIR = '_turn_journal'
const TURN_JOURNAL_ID_RE = /^[A-Za-z0-9_.-]+$/
const createdAt = (event: Record<string, unknown>): number => { const value = Number(event.created_at ?? 0); return Number.isFinite(value) ? value : 0 }
export class JsonJournal implements JournalBackend {
  private readonly runOwners = new Map<string, string>()
  constructor(readonly sessionDir: string, private readonly env: Record<string, string | undefined> = {}) {}

  root(): string {
    return join(this.sessionDir, RUN_JOURNAL_DIR_NAME)
  }

  pathFor(sessionId: string, runId: string): string {
    return join(this.root(), validateId(sessionId, 'session_id'), `${validateId(runId, 'run_id')}.jsonl`)
  }

  /** Python `delete_run_journal`: remove one session's journal directory; false for a missing or unsafe id. */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (/^\.+$/.test(sessionId)) return false
    let dir: string
    try { dir = join(this.root(), validateId(sessionId, 'session_id')) } catch { return false }
    for (const [rid, sid] of this.runOwners) if (sid === sessionId) this.runOwners.delete(rid)
    if (dir === this.root() || !existsSync(dir)) return false
    try { rmSync(dir, { recursive: true, force: true }) } catch { return false }
    return !existsSync(dir)
  }


  async recoveryEvents(): Promise<Map<string, Record<string, unknown>[]>> {
    const dir = join(this.sessionDir, TURN_JOURNAL_DIR)
    const out = new Map<string, Record<string, unknown>[]>()
    let names: string[]
    try { names = readdirSync(dir).sort() } catch { return out }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const stem = name.slice(0, -'.jsonl'.length)
      const tilde = stem.indexOf('~')
      const sid = tilde > 0 ? stem.slice(0, tilde) : stem
      if (!TURN_JOURNAL_ID_RE.test(sid)) continue
      let text: string
      try {
        if (!statSync(join(dir, name)).isFile()) continue
        text = readFileSync(join(dir, name), 'utf8')
      } catch { continue }
      const events = out.get(sid) ?? []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { const event = JSON.parse(line) as unknown; if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event as Record<string, unknown>) } catch { /* a torn line */ }
      }
      out.set(sid, events)
    }
    for (const events of out.values()) events.sort((a, b) => createdAt(a) - createdAt(b))
    return out
  }

  private fsyncMode(): 'eager' | 'terminal-only' {
    const mode = (this.env.HERMES_WEBUI_RUN_JOURNAL_FSYNC ?? 'terminal-only').trim().toLowerCase()
    return mode === 'eager' ? 'eager' : 'terminal-only'
  }

  async writer(sessionId: string, runId: string): Promise<JsonJournalWriter> { return (await this.open(sessionId, runId, { durability: this.fsyncMode() })) }

  private readonly writers = new Set<JsonJournalWriter>()
  register(writer: JsonJournalWriter): void { this.writers.add(writer) }
  release(writer: JsonJournalWriter): void { this.writers.delete(writer) }

  async open(sessionId: string, runId: string, opts: { durability: 'eager' | 'terminal-only' }): Promise<JsonJournalWriter> {
    if (this.closed) throw new Error('Storage is closed')
    return new JsonJournalWriter(this, sessionId, runId, opts.durability)
  }
  private closed = false
  async close(): Promise<void> { this.closed = true; this.runOwners.clear(); await Promise.all([...this.writers].map(async (writer) => { await writer.close(); })) }

  async *read(sessionId: string, runId: string, fromSeq: number): AsyncGenerator<JournalEvent> {
    yield* this.iterRunEventsNow(sessionId, runId, { afterSeq: fromSeq - 1 })
  }
  async *iterRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): AsyncGenerator<JournalEvent> { yield* this.iterRunEventsNow(sessionId, runId, opts) }
  async readRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): Promise<JournalEvent[]> { return this.readRunEventsNow(sessionId, runId, opts) }
  async readRunEventTail(sessionId: string, runId: string, maxBytes?: number, maxRows?: number): Promise<{ events: JournalEvent[]; truncated: boolean }> { return this.readRunEventTailNow(sessionId, runId, maxBytes, maxRows) }
  async latestRunSummary(sessionId: string, runId: string): Promise<RunSummary> { return this.latestRunSummaryNow(sessionId, runId) }
  async summary(sessionId: string, runId: string): Promise<RunSummary | null> {
    const summary = this.latestRunSummaryNow(sessionId, runId)
    return summary.event_count || summary.journal_pruned ? summary : null
  }
  async findRunSummary(runId: string): Promise<RunSummary | null> { return this.findRunSummaryNow(runId) }
  async sessionJournalFingerprint(sessionId: string): Promise<string> { return this.sessionJournalFingerprintNow(sessionId) }
  async staleInterruptedEvent(sessionId: string, runId: string, afterSeq: number | null = null, now?: number): Promise<JournalEvent | null> { return this.staleInterruptedEventNow(sessionId, runId, afterSeq, now) }
  async sessionIds(): Promise<string[]> {
    try { return readdirSync(this.root(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && SAFE_ID_RE.test(entry.name)).map((entry) => entry.name).sort() } catch { return [] }
  }
  async streams(sessionId: string): Promise<string[]> {
    const dir = join(this.root(), validateId(sessionId, 'session_id'))
    try { return [...new Set(readdirSync(dir).filter((name) => name.endsWith('.jsonl') || name.endsWith(PRUNED_SUMMARY_SUFFIX)).map((name) => name.replace(/(?:\.jsonl|\.summary\.json)$/, '')))].sort() } catch { return [] }
  }
  async prune(olderThan: number): Promise<number> { return (await this.pruneSettled({ now: olderThan + 1, retentionSeconds: 1 })).pruned }


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

  readRunEventsNow(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): JournalEvent[] {
    return [...this.iterRunEventsNow(sessionId, runId, opts)]
  }

  /**
   * `readRunEventsNow` one page at a time, so a replay that waits on a slow reader holds one page of the journal rather
   * than all of it (run-state contract: recovery never parses an unbounded journal in one request).
   */
  *iterRunEventsNow(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): Generator<JournalEvent> {
    let fd: number
    try { fd = openSync(this.pathFor(sessionId, runId), fsConstants.O_RDONLY) } catch { return }
    try {
      const page = Buffer.alloc(RUN_EVENTS_PAGE_BYTES)
      const decoder = new StringDecoder('utf8')
      let position = 0
      let rest = ''
      for (;;) {
        let n = 0
        try { n = readSyncAt(fd, page, 0, position) } catch { n = 0 }
        position += n
        const lines = (rest + (n > 0 ? decoder.write(page.subarray(0, n)) : decoder.end())).split('\n')
        rest = n > 0 ? lines.pop() ?? '' : ''
        for (const event of JsonJournal.parseLines(lines.join('\n')).events) {
          const seq = event.seq || 0
          if (opts.afterSeq !== null && opts.afterSeq !== undefined && seq <= opts.afterSeq) continue
          if (opts.maxSeq !== null && opts.maxSeq !== undefined && seq > opts.maxSeq) continue
          yield event
        }
        if (n <= 0) return
      }
    } finally {
      closeSync(fd)
    }
  }

  readRunEventTailNow(sessionId: string, runId: string, maxBytes = LIVE_SNAPSHOT_MAX_BYTES, maxRows = LIVE_SNAPSHOT_MAX_ROWS): { events: JournalEvent[]; truncated: boolean } {
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
    return JsonJournal.parseTail(raw, start, maxRows)
  }

  /** The bounded tail of `raw`, read from byte `start`: drop the partial first line, keep the last `maxRows` rows. */
  private static parseTail(raw: Buffer, start: number, maxRows: number): { events: JournalEvent[]; truncated: boolean } {
    let text = raw.toString('utf8')
    if (start) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n').filter((l) => l.length > 0)
    const rowsTruncated = lines.length > maxRows
    const { events } = JsonJournal.parseLines(lines.slice(-maxRows).join('\n'))
    return { events, truncated: start > 0 || rowsTruncated }
  }

  /** `readRunEventTailNow` off the event loop, plus the identity of the file it read. */
  private static async readTailAsync(path: string, maxBytes: number, maxRows: number): Promise<{ events: JournalEvent[]; st: BigIntStats }> {
    const handle = await open(path, 'r')
    try {
      const st = await handle.stat({ bigint: true })
      const size = Number(st.size)
      const start = Math.max(0, size - maxBytes)
      const raw = Buffer.alloc(Math.min(size, maxBytes))
      let got = 0
      while (got < raw.length) {
        const { bytesRead } = await handle.read(raw, got, raw.length - got, start + got)
        if (bytesRead <= 0) break
        got += bytesRead
      }
      return { events: JsonJournal.parseTail(raw.subarray(0, got), start, maxRows).events, st }
    } finally {
      await handle.close()
    }
  }

  static readonly selectAuthoritativeTerminalEvent = selectAuthoritativeTerminalEvent
  static readonly summaryFromEvents = summaryFromEvents

  private loadPrunedSummary(path: string): RunSummary | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX), 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as RunSummary) : null
    } catch {
      return null
    }
  }

  latestRunSummaryNow(sessionId: string, runId: string): RunSummary {
    const path = this.pathFor(sessionId, runId)
    if (!existsSync(path)) {
      const pruned = this.loadPrunedSummary(path)
      if (pruned) return pruned
    }
    const tail = this.readRunEventTailNow(sessionId, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS)
    const summary = JsonJournal.summaryFromEvents(sessionId, runId, tail.events)
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
   *
   * The sweep is incremental so requests keep running on the event loop: I/O is
   * async and it yields after every session and every parsed journal. Sessions
   * whose metadata already rules out pruning (no more journals than the keep
   * count, or none past the cutoff) are not parsed, so `terminal` counts only
   * the journals inspected. `signal` stops the sweep at its next yield;
   * `pause` replaces the default yield (`setImmediate`).
   */
  async pruneSettled(opts: PruneOptions = {}): Promise<PruneResult> {
    const result: PruneResult = { examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0 }
    const days = Number.parseFloat(this.env.HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS ?? '14')
    const retention = opts.retentionSeconds ?? (Number.isFinite(days) ? Math.max(0, days) * 86400 : 14 * 86400)
    const keepEnv = Number.parseInt(this.env.HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT ?? '3', 10)
    const keep = opts.keepRecent ?? (Number.isFinite(keepEnv) ? Math.max(0, keepEnv) : 3)
    const now = opts.now ?? Date.now() / 1000
    const cutoff = now - retention
    const root = this.root()
    // Yield to queued requests, then report whether the sweep may continue.
    const proceed = async (): Promise<boolean> => { await (opts.pause ?? nextTurn)(); return !opts.signal?.aborted }
    if (retention <= 0 || !existsSync(root)) return result
    const sessions = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && SAFE_ID_RE.test(d.name)).map((d) => d.name).sort()
    for (const sid of sessions) {
      if (!(await proceed())) return result
      const dir = join(root, sid)
      // The session may be deleted while the sweep runs.
      let names: string[]
      try { names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort() } catch { continue }
      result.examined += names.length
      let expired = 0
      for (const name of names) {
        if (opts.signal?.aborted) return result
        try { if ((await stat(join(dir, name))).mtimeMs / 1000 <= cutoff) expired += 1 } catch { /* vanished */ }
      }
      if (names.length <= keep || expired === 0) continue
      const terminalRuns: { st: BigIntStats; path: string; summary: RunSummary }[] = []
      for (const name of names) {
        const path = join(dir, name)
        let tail
        try { tail = await JsonJournal.readTailAsync(path, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS) } catch { continue }
        const summary = JsonJournal.summaryFromEvents(sid, name.slice(0, -'.jsonl'.length), tail.events)
        if (summary.terminal) {
          result.terminal += 1
          terminalRuns.push({ st: tail.st, path, summary })
        }
        if (!(await proceed())) return result
      }
      terminalRuns.sort((a, b) => (b.st.mtimeNs > a.st.mtimeNs ? 1 : b.st.mtimeNs < a.st.mtimeNs ? -1 : b.path.localeCompare(a.path)))
      for (const { st, path, summary } of terminalRuns.slice(keep)) {
        if (opts.signal?.aborted) return result
        const mtime = Number(st.mtimeNs) / 1e9
        if (mtime > cutoff) continue
        // Still the parsed file with no live writer. ctime catches a replacement that reuses the inode, size, and mtime.
        const stillPrunable = (): boolean => {
          if ([...this.writers].some((writer) => writer.path === path) || opts.isActive?.(path)) return false
          let cur
          try { cur = lstatSync(path, { bigint: true }) } catch { return false }
          return cur.isFile() && cur.dev === st.dev && cur.ino === st.ino && cur.size === st.size && cur.mtimeNs === st.mtimeNs && cur.ctimeNs === st.ctimeNs
        }
        if (!stillPrunable()) continue
        const size = Number(st.size)
        if (opts.dryRun) { result.pruned += 1; result.bytes_reclaimed += size; continue }
        const summaryPath = path.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX)
        const pruned = { ...summary, journal_pruned: true, journal_pruned_at: now, original_size: size, original_mtime: mtime }
        const prior = await readFile(summaryPath, 'utf8').catch(() => null)
        try { await atomicWriteTextAsync(summaryPath, JSON.stringify(pruned)) } catch { continue }
        // Re-check after the write's async gap; no await separates this check from the unlink.
        if (!stillPrunable()) {
          // Roll back to the summary that was there before, if any.
          await (prior === null ? unlink(summaryPath) : atomicWriteTextAsync(summaryPath, prior)).catch(() => undefined)
          continue
        }
        try { unlinkSync(path) } catch { continue }
        result.pruned += 1
        result.bytes_reclaimed += size
      }
    }
    return result
  }

  /** Locate a run across sessions (Python `find_run_summary`). */
  findRunSummaryNow(runId: string): RunSummary | null {
    let rid: string
    try {
      rid = validateId(runId, 'run_id')
    } catch {
      return null
    }
    const cached = this.runOwners.get(rid)
    if (cached !== undefined) {
      this.runOwners.delete(rid)
      const summary = this.resolvedRunSummary(cached, rid, false) ?? this.resolvedRunSummary(cached, rid, true)
      if (summary) return summary
    }
    let sessions: string[]
    try {
      sessions = readdirSync(this.root()).filter((sid) => SAFE_ID_RE.test(sid) && !/^\.+$/.test(sid))
    } catch {
      return null
    }
    for (const sid of sessions) {
      const summary = this.resolvedRunSummary(sid, rid, false)
      if (summary) return summary
    }
    for (const sid of sessions) {
      const summary = this.resolvedRunSummary(sid, rid, true)
      if (summary) return summary
    }
    return null
  }

  private resolvedRunSummary(sessionId: string, runId: string, pruned: boolean): RunSummary | null {
    const journalPath = this.pathFor(sessionId, runId)
    const path = pruned ? journalPath.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX) : journalPath
    if (!existsSync(path)) return null
    const summary = pruned ? this.loadPrunedSummary(journalPath) : this.latestRunSummaryNow(sessionId, runId)
    if (!summary) return null
    // Cache ownership only; appends and retention summaries must always be read fresh.
    if (!this.closed) {
      this.runOwners.set(runId, sessionId)
      if (this.runOwners.size > RUN_OWNER_CACHE_MAX) this.runOwners.delete(this.runOwners.keys().next().value!)
    }
    summary.path = path
    return summary
  }

  sessionJournalFingerprintNow(sessionId: string): string {
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
  async readSessionRunEvents(sessionId: string, afterEventId: string | null | undefined): Promise<SessionJournalReplay> {
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
    const positions = new Map<string, { offset: number; seq: number; dev: bigint; ino: bigint; complete: boolean }>()
    let retainedRows = 0
    let retainedBytes = 0
    const result = (status: string, events: JournalEvent[] = []): SessionJournalReplay => ({ status, events, cursor_run_id: cursorRunId, cursor_seq: cursorSeq })
    const parse = (runId: string, raw: Buffer, afterSeq = 0): SessionJournalReplay => {
      retainedBytes += raw.length
      if (retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
      const events: JournalEvent[] = []
      let expected = afterSeq + 1
      for (const line of raw.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        let event: JournalEvent
        try { event = JSON.parse(line) as JournalEvent } catch { return result('replay_malformed') }
        if (event?.seq !== expected || event.event_id !== `${runId}:${String(expected)}` || event.run_id !== runId || event.session_id !== sid) return result('replay_noncontiguous')
        expected += 1
        retainedRows += 1
        if (retainedRows > SESSION_REPLAY_MAX_ROWS) return result('replay_limit_rows')
        events.push(event)
      }
      return result('ok', events)
    }
    let names: string[] = []
    try { names = (await readdir(sessionRoot)).filter((n) => n.endsWith('.jsonl')).sort() } catch { names = [] }
    for (const name of names) {
      const runId = name.slice(0, -'.jsonl'.length)
      try { validateId(runId, 'run_id') } catch { continue }
      const path = join(sessionRoot, name)
      let raw: Buffer
      let st: BigIntStats
      try {
        const handle = await open(path, 'r')
        try {
          st = await handle.stat({ bigint: true })
          if (Number(st.size) + retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
          raw = await readFile(handle)
        } finally { await handle.close() }
      } catch { continue }
      const parsed = parse(runId, raw)
      if (parsed.status !== 'ok') return parsed
      const events = parsed.events
      positions.set(runId, { offset: raw.length, seq: events.at(-1)?.seq ?? 0, dev: st.dev, ino: st.ino, complete: !raw.length || raw.at(-1) === 10 })
      let createdAt = Number.POSITIVE_INFINITY
      for (const e of events) createdAt = Math.min(createdAt, e.created_at || 0)
      if (!Number.isFinite(createdAt)) createdAt = Number(st.mtimeMs) / 1000
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
    return { ...result('ok', replay), readActiveTail: async (runId) => {
      const path = this.pathFor(sid, runId)
      const previous = positions.get(runId)
      try {
        const handle = await open(path, 'r')
        try {
          const st = await handle.stat({ bigint: true })
          const offset = previous?.offset ?? 0
          if (previous && (previous.dev !== st.dev || previous.ino !== st.ino || st.size < BigInt(offset) || (!previous.complete && st.size > BigInt(offset)))) return result('replay_changed')
          const size = Number(st.size) - offset
          if (size + retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
          const raw = Buffer.alloc(size)
          if (size && (await handle.read(raw, 0, size, offset)).bytesRead !== size) return result('replay_changed')
          return parse(runId, raw, previous?.seq ?? 0)
        } finally { await handle.close() }
      } catch { return result('replay_changed') }
    } }
  }

  /** Python `stale_interrupted_event`: a synthetic terminal row for a journal whose worker died. */
  staleInterruptedEventNow(sessionId: string, runId: string, afterSeq: number | null = null, now = Date.now() / 1000): JournalEvent | null {
    const summary = this.latestRunSummaryNow(sessionId, runId)
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

export class JsonJournalWriter {
  private fd: number | null = null
  private seq = 0
  private closed = false
  readonly path: string

  constructor(private readonly journal: JsonJournal, readonly sessionId: string, readonly runId: string, private readonly fsyncMode: 'eager' | 'terminal-only', private readonly now: () => number = () => Date.now() / 1000) {
    this.path = journal.pathFor(sessionId, runId)
    journal.register(this)
    // Resume the sequence when a journal already exists for this stream id (never in practice; ids are fresh).
    try {
      const existing = journal.readRunEventsNow(sessionId, runId)
      this.seq = existing[existing.length - 1]?.seq ?? 0
    } catch { this.seq = 0 }
  }

  async append(row: JournalInput, opts: { terminal: boolean }): Promise<JournalEvent> {
    return this.appendSseEventNow(row.event, row.payload, row.redacted === undefined ? {} : { redacted: row.redacted }, opts.terminal, row.created_at)
  }

  async appendSseEvent(eventName: string, payload: unknown, meta: JournalEventMeta = {}): Promise<JournalEvent> { return this.appendSseEventNow(eventName, payload, meta) }

  private appendSseEventNow(eventName: string, payload: unknown, meta: JournalEventMeta = {}, terminal?: boolean, createdAt?: number): JournalEvent {
    if (this.closed) throw new Error('run journal writer is closed')
    const name = eventName.trim()
    if (!name) throw new Error('event_name is required')
    const terminalState = terminalStateForEvent(name, payload)
    this.seq += 1
    const event: JournalEvent = {
      version: 1, event_id: `${this.runId}:${String(this.seq)}`, seq: this.seq, run_id: this.runId, session_id: this.sessionId, event: name, type: name,
      created_at: createdAt ?? meta.createdAt ?? this.now(), terminal: terminal ?? Boolean(terminalState), terminal_state: terminalState, payload: payload ?? {},
      ...(meta.redacted === undefined ? {} : { redacted: meta.redacted }),
    }
    mkdirSync(join(this.path, '..'), { recursive: true })
    this.fd ??= openSync(this.path, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600)
    writeFully(this.fd, `${JSON.stringify(event)}\n`)
    if (this.fsyncMode === 'eager' || event.terminal) { try { fsyncSync(this.fd) } catch { /* best effort */ } }
    if (SSE_RELAY_CLOSE_EVENTS.has(name)) this.closeHandle()
    return event
  }

  private closeHandle(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd) } catch { /* ignore */ }
      this.fd = null
    }
  }

  async close(): Promise<void> {
    this.closeHandle()
    this.closed = true
    this.journal.release(this)
  }
}
