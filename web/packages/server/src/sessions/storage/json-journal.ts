/* eslint-disable @typescript-eslint/require-await -- Synchronous JSON transactions implement the async storage port. */
import { rmSync } from 'node:fs'
import { closeSync, existsSync, fsync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, constants as fsConstants, type BigIntStats } from 'node:fs'
import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { atomicWriteTextAsync, writeFully, writeFullyAsync } from '../../fs/atomic.js'
import { dirname, join } from 'node:path'


import { LIVE_SNAPSHOT_MAX_BYTES, LIVE_SNAPSHOT_MAX_ROWS, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS, SESSION_REPLAY_MAX_BYTES, SESSION_REPLAY_MAX_ROWS, staleInterruptedEvent, retentionPolicy, RUN_JOURNAL_DIR_NAME, SSE_RELAY_CLOSE_EVENTS, validateId, parseRunJournalEventId, journalEvent, selectAuthoritativeTerminalEvent, summaryFromEvents, type JournalEvent, type RunSummary, type PruneOptions, type PruneResult } from '../journal.js'
import type { JournalBackend, JournalEventMeta, JournalInput, SessionJournalReplay } from './backend.js'
import { ARCHIVE_DIR, ARCHIVE_SUFFIX, JournalArchiveError, JournalReadLimit, NOFOLLOW, StagedFile, fsyncDir, logicalBytes, runLines, stageArchive } from './json-journal-archive.js'
const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/
const PRUNED_SUMMARY_SUFFIX = '.summary.json'
const RUN_OWNER_CACHE_MAX = 1000

const TURN_JOURNAL_DIR = '_turn_journal'
const TURN_JOURNAL_ID_RE = /^[A-Za-z0-9_.-]+$/
const createdAt = (event: Record<string, unknown>): number => { const value = Number(event.created_at ?? 0); return Number.isFinite(value) ? value : 0 }
/** Legacy `_turn_journal/*.jsonl` recovery rows under the session directory, grouped by session and ordered by time. */
export function readTurnJournalEvents(sessionDir: string): Map<string, Record<string, unknown>[]> {
  const dir = join(sessionDir, TURN_JOURNAL_DIR)
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

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** A run's open journal files: its archive and its live journal, either absent. */
interface RunFiles { archive: FileHandle | null; live: FileHandle | null; liveStat: BigIntStats | null; close(): Promise<void> }
const NO_FILES: RunFiles = { archive: null, live: null, liveStat: null, close: async () => undefined }

export { JournalArchiveError } from './json-journal-archive.js'
export class JsonJournal implements JournalBackend {
  private readonly runOwners = new Map<string, string>()
  /** Bumped by each session deletion, so archival in flight never publishes into a deleted session. */
  private readonly deletions = new Map<string, number>()
  private readonly policy
  constructor(readonly sessionDir: string, private readonly env: Record<string, string | undefined> = {}) { this.policy = retentionPolicy(env) }

  root(): string {
    return join(this.sessionDir, RUN_JOURNAL_DIR_NAME)
  }

  pathFor(sessionId: string, runId: string): string {
    return join(this.root(), validateId(sessionId, 'session_id'), `${validateId(runId, 'run_id')}.jsonl`)
  }

  archivePathFor(sessionId: string, runId: string): string {
    return join(this.root(), validateId(sessionId, 'session_id'), ARCHIVE_DIR, `${validateId(runId, 'run_id')}${ARCHIVE_SUFFIX}`)
  }

  /** The run's archive, null when it has none; an archive path that is anything but a plain file refuses. */
  private async openArchive(sessionId: string, runId: string): Promise<FileHandle | null> {
    const path = this.archivePathFor(sessionId, runId)
    try {
      if (!lstatSync(dirname(path)).isDirectory()) throw new JournalArchiveError('The run-journal archive directory is not a directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error instanceof JournalArchiveError ? error : new JournalArchiveError('The run-journal archive directory is unreadable', { cause: error })
    }
    let handle: FileHandle
    try { handle = await open(path, fsConstants.O_RDONLY | (NOFOLLOW ?? 0)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new JournalArchiveError('The run-journal archive is unreadable', { cause: error })
    }
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new JournalArchiveError('The run-journal archive is not a file') }
    return handle
  }

  /**
   * Every reader, the writer's resume, and archival open a run here; `pin` refuses a symlinked live journal. The live
   * journal is opened first: retention removes it only after publishing the archive, so either the held live handle
   * still reads the run or the archive already exists, and a concurrent sweep never makes a run read as empty.
   */
  private async openRun(sessionId: string, runId: string, pin = false): Promise<RunFiles> {
    try { validateId(sessionId, 'session_id'); validateId(runId, 'run_id') } catch { return NO_FILES }
    let live: FileHandle | null = null
    let liveStat: BigIntStats | null = null
    try {
      live = await open(this.pathFor(sessionId, runId), fsConstants.O_RDONLY | (pin ? NOFOLLOW ?? 0 : 0))
      liveStat = await live.stat({ bigint: true })
    } catch (error) {
      await live?.close().catch(() => undefined)
      // Only a missing journal is absent; any other failure could hide rows already persisted past the archive.
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error
      live = null
      liveStat = null
    }
    let archive: FileHandle | null
    try { archive = await this.openArchive(sessionId, runId) } catch (error) { await live?.close(); throw error }
    return { archive, live, liveStat, close: async () => { await archive?.close(); await live?.close() } }
  }

  /** Python `delete_run_journal`: remove one session's journal directory; false for a missing or unsafe id. */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (/^\.+$/.test(sessionId)) return false
    let dir: string
    try { dir = join(this.root(), validateId(sessionId, 'session_id')) } catch { return false }
    for (const [rid, sid] of this.runOwners) if (sid === sessionId) this.runOwners.delete(rid)
    this.deletions.set(sessionId, (this.deletions.get(sessionId) ?? 0) + 1)
    if (dir === this.root() || !existsSync(dir)) return false
    try { rmSync(dir, { recursive: true, force: true }) } catch { return false }
    return !existsSync(dir)
  }


  async recoveryEvents(): Promise<Map<string, Record<string, unknown>[]>> { return readTurnJournalEvents(this.sessionDir) }

  private fsyncMode(): 'eager' | 'terminal-only' {
    const mode = (this.env.HERMES_WEBUI_RUN_JOURNAL_FSYNC ?? 'terminal-only').trim().toLowerCase()
    return mode === 'eager' ? 'eager' : 'terminal-only'
  }

  async writer(sessionId: string, runId: string): Promise<JsonJournalWriter> { return (await this.open(sessionId, runId, { durability: this.fsyncMode() })) }

  private readonly writers = new Set<JsonJournalWriter>()
  /** A run's owner is known from its first writer, so its first lookup skips the cross-session scan. */
  register(writer: JsonJournalWriter): void { this.writers.add(writer); this.rememberOwner(writer.runId, writer.sessionId) }
  release(writer: JsonJournalWriter): void { this.writers.delete(writer) }

  /** Resumes the run's sequence past its archived prefix and live rows; an untrusted archive refuses the writer. */
  async open(sessionId: string, runId: string, opts: { durability: 'eager' | 'terminal-only' }): Promise<JsonJournalWriter> {
    if (this.closed) throw new Error('Storage is closed')
    this.pathFor(sessionId, runId)
    let seq = 0
    for await (const event of this.iterRunEvents(sessionId, runId)) seq = event.seq
    if (this.closed) throw new Error('Storage is closed')
    return new JsonJournalWriter(this, sessionId, runId, opts.durability, undefined, seq)
  }
  private closed = false
  async close(): Promise<void> { this.closed = true; this.runOwners.clear(); await Promise.all([...this.writers].map(async (writer) => { await writer.close(); })) }

  async *read(sessionId: string, runId: string, fromSeq: number): AsyncGenerator<JournalEvent> {
    yield* this.iterRunEvents(sessionId, runId, { afterSeq: fromSeq - 1 })
  }

  /**
   * The run's rows, archive first, one page at a time, so a replay that waits on a slow reader holds one page of the
   * journal rather than all of it (run-state contract: recovery never parses an unbounded journal in one request).
   */
  async *iterRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): AsyncGenerator<JournalEvent> {
    const files = await this.openRun(sessionId, runId)
    try {
      for await (const line of runLines(files.archive, files.live, sessionId, runId)) {
        const event = line.event
        if (!event) continue
        const seq = event.seq || 0
        if (opts.afterSeq !== null && opts.afterSeq !== undefined && seq <= opts.afterSeq) continue
        if (opts.maxSeq !== null && opts.maxSeq !== undefined && seq > opts.maxSeq) continue
        yield event
      }
    } finally { await files.close() }
  }
  async readRunEvents(sessionId: string, runId: string, opts: { afterSeq?: number | null; maxSeq?: number | null } = {}): Promise<JournalEvent[]> {
    const events: JournalEvent[] = []
    for await (const event of this.iterRunEvents(sessionId, runId, opts)) events.push(event)
    return events
  }
  async readRunEventTail(sessionId: string, runId: string, maxBytes = LIVE_SNAPSHOT_MAX_BYTES, maxRows = LIVE_SNAPSHOT_MAX_ROWS): Promise<{ events: JournalEvent[]; truncated: boolean }> {
    const files = await this.openRun(sessionId, runId)
    try { return await JsonJournal.tailOf(files, sessionId, runId, maxBytes, maxRows) } finally { await files.close() }
  }
  async latestRunSummary(sessionId: string, runId: string): Promise<RunSummary> {
    return (await this.summaryOf(sessionId, runId)) ?? { ...JsonJournal.summaryFromEvents(sessionId, runId, []), journal_truncated: false }
  }
  async summary(sessionId: string, runId: string): Promise<RunSummary | null> {
    const summary = await this.latestRunSummary(sessionId, runId)
    return summary.event_count || summary.journal_pruned ? summary : null
  }
  async sessionJournalFingerprint(sessionId: string): Promise<string> { return this.sessionJournalFingerprintNow(sessionId) }
  async sessionIds(): Promise<string[]> {
    try { return readdirSync(this.root(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && SAFE_ID_RE.test(entry.name)).map((entry) => entry.name).sort() } catch { return [] }
  }
  async streams(sessionId: string): Promise<string[]> {
    const dir = join(this.root(), validateId(sessionId, 'session_id'))
    let archived: string[] = []
    try { archived = readdirSync(join(dir, ARCHIVE_DIR)).filter((name) => name.endsWith(ARCHIVE_SUFFIX)).map((name) => name.slice(0, -ARCHIVE_SUFFIX.length)) } catch { /* none */ }
    try { return [...new Set([...archived, ...readdirSync(dir).filter((name) => name.endsWith('.jsonl') || name.endsWith(PRUNED_SUMMARY_SUFFIX)).map((name) => name.replace(/(?:\.jsonl|\.summary\.json)$/, ''))])].sort() } catch { return [] }
  }
  async importRun(sessionId: string, runId: string, run: { rows: JournalEvent[]; summary: RunSummary | null }): Promise<void> {
    if (this.closed) throw new Error('Storage is closed')
    const path = this.pathFor(sessionId, runId)
    const summaryPath = path.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX)
    mkdirSync(dirname(path), { recursive: true })
    // The imported rows replace the whole run, its archived prefix included.
    rmSync(this.archivePathFor(sessionId, runId), { force: true })
    if (run.rows.length) await atomicWriteTextAsync(path, run.rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    else rmSync(path, { force: true })
    if (run.summary) await atomicWriteTextAsync(summaryPath, JSON.stringify(run.summary))
    else rmSync(summaryPath, { force: true })
  }
  async prune(olderThan: number): Promise<number> { return (await this.pruneSettled({ now: olderThan + 1, retentionSeconds: 1 })).pruned }

  /** The bounded tail of `raw`, read from byte `start`: drop the partial first line, keep the last `maxRows` rows. */
  private static parseTail(raw: Buffer, start: number, maxRows: number): { events: JournalEvent[]; truncated: boolean } {
    let text = raw.toString('utf8')
    if (start) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n').filter((l) => l.length > 0)
    const rowsTruncated = lines.length > maxRows
    const events: JournalEvent[] = []
    for (const raw of lines.slice(-maxRows)) {
      if (!raw.trim()) continue
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed as JournalEvent)
      } catch { /* a torn line */ }
    }
    return { events, truncated: start > 0 || rowsTruncated }
  }

  /**
   * The last `maxBytes` of the run's logical journal, parsed by `parseTail`. A live-only run reads just its tail; an
   * archived one streams through, holding at most twice the window.
   */
  private static async tailOf(files: RunFiles, sessionId: string, runId: string, maxBytes: number, maxRows: number): Promise<{ events: JournalEvent[]; truncated: boolean }> {
    if (!files.archive) {
      if (!files.live || !files.liveStat) return { events: [], truncated: false }
      const size = Number(files.liveStat.size)
      const start = Math.max(0, size - maxBytes)
      const raw = Buffer.alloc(Math.min(size, maxBytes))
      let got = 0
      try {
        while (got < raw.length) {
          const { bytesRead } = await files.live.read(raw, got, raw.length - got, start + got)
          if (bytesRead <= 0) break
          got += bytesRead
        }
      } catch { return { events: [], truncated: false } }
      return JsonJournal.parseTail(raw.subarray(0, got), start, maxRows)
    }
    let kept: Buffer[] = []
    let keptBytes = 0
    let total = 0
    for await (const chunk of logicalBytes(runLines(files.archive, files.live, sessionId, runId))) {
      kept.push(chunk)
      keptBytes += chunk.length
      total += chunk.length
      if (keptBytes > 2 * maxBytes) {
        const joined = Buffer.concat(kept)
        kept = [Buffer.from(joined.subarray(joined.length - maxBytes))]
        keptBytes = maxBytes
      }
    }
    const joined = Buffer.concat(kept)
    const raw = joined.length > maxBytes ? joined.subarray(joined.length - maxBytes) : joined
    return JsonJournal.parseTail(raw, total - raw.length, maxRows)
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

  /**
   * The run's summary from its logical journal's tail. An archive-only run answers from the summary published with its
   * archive, so a status lookup never inflates the archive. A run with neither a live journal nor an archive answers with
   * the summary an earlier release left when it pruned the events (`journal_pruned`), or null.
   */
  private async summaryOf(sessionId: string, runId: string): Promise<RunSummary | null> {
    const files = await this.openRun(sessionId, runId)
    let tail: { events: JournalEvent[]; truncated: boolean }
    try {
      if (!files.live) {
        const path = this.pathFor(sessionId, runId)
        if (!files.archive) return this.loadPrunedSummary(path)
        const persisted = JsonJournal.archivedSummary(this.loadPrunedSummary(path), sessionId, runId)
        if (persisted) return persisted
      }
      tail = await JsonJournal.tailOf(files, sessionId, runId, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS)
    } finally { await files.close() }
    return JsonJournal.summaryFromTail(sessionId, runId, tail)
  }

  private static summaryFromTail(sessionId: string, runId: string, tail: { events: JournalEvent[]; truncated: boolean }): RunSummary {
    const summary = JsonJournal.summaryFromEvents(sessionId, runId, tail.events)
    const last = tail.events[tail.events.length - 1]
    if (last) summary.event_count = last.seq || tail.events.length
    summary.journal_truncated = tail.truncated
    return summary
  }

  /** The tail summary an archive's `.summary.json` carries under `archived`; null for a summary this release did not write. */
  private static archivedSummary(stored: RunSummary | null, sessionId: string, runId: string): RunSummary | null {
    const archived = (stored as { archived?: unknown } | null)?.archived as { event_count?: unknown; journal_truncated?: unknown } | undefined
    if (stored?.session_id !== sessionId || stored.run_id !== runId || typeof archived?.event_count !== 'number' || typeof archived.journal_truncated !== 'boolean') return null
    const { stream_id, last_seq, last_event_id, terminal, terminal_state, last_event } = stored
    return { session_id: sessionId, run_id: runId, stream_id, event_count: archived.event_count, last_seq, last_event_id, terminal, terminal_state, last_event, journal_truncated: archived.journal_truncated }
  }

  /**
   * Python `prune_settled_run_journals`: archive settled journals as verified gzip under `<session>/_archive/` and remove
   * their live bytes. A run is due when it is older than `HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS` (14), or while its
   * session holds more live journals or bytes than the soft `..._MAX_RUNS_PER_SESSION` (40) and
   * `..._MAX_BYTES_PER_SESSION` (256 MiB) budgets, oldest first. The `HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT` (3) newest
   * terminal journals, nonterminal journals, live writers and runs the session still names stay live even past a budget.
   * Each archived run also leaves the `.summary.json` the previous Stable reads once the live journal is gone.
   *
   * The sweep is incremental so requests keep running on the event loop: I/O is async and it yields after every session
   * and every parsed journal. Sessions whose metadata already rules out archival (no more journals than the keep count,
   * none past the cutoff, and within both budgets) are not parsed, so `terminal` counts only the journals inspected.
   * `signal` stops the sweep at its next yield; `pause` replaces the default yield (`setImmediate`).
   */
  async pruneSettled(opts: PruneOptions = {}): Promise<PruneResult> {
    const result: PruneResult = { examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0 }
    const retention = opts.retentionSeconds ?? this.policy.retentionSeconds
    const keep = opts.keepRecent ?? this.policy.keepRecent
    const maxRuns = opts.maxRuns ?? this.policy.maxRuns
    const maxBytes = opts.maxBytes ?? this.policy.maxBytes
    const now = opts.now ?? Date.now() / 1000
    const cutoff = now - retention
    const root = this.root()
    // Yield to queued requests, then report whether the sweep may continue.
    const proceed = async (): Promise<boolean> => { await (opts.pause ?? nextTurn)(); return !opts.signal?.aborted }
    // Without O_NOFOLLOW archival cannot pin what it reads and publishes, so every journal stays live.
    if (retention <= 0 || NOFOLLOW === undefined || !existsSync(root)) return result
    const references = async (sid: string): Promise<ReadonlySet<string> | null> => {
      if (!opts.protectedRuns) return new Set()
      try { return await opts.protectedRuns(sid) } catch { return null }
    }
    const sessions = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && SAFE_ID_RE.test(d.name)).map((d) => d.name).sort()
    for (const sid of sessions) {
      if (!(await proceed())) return result
      const dir = join(root, sid)
      const generation = this.deletions.get(sid) ?? 0
      // The session may be deleted while the sweep runs.
      let names: string[]
      try { names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort() } catch { continue }
      result.examined += names.length
      let expired = 0
      let liveBytes = 0
      for (const name of names) {
        if (opts.signal?.aborted) return result
        try {
          const st = await stat(join(dir, name))
          liveBytes += st.size
          if (st.mtimeMs / 1000 <= cutoff) expired += 1
        } catch { /* vanished */ }
      }
      let liveRuns = names.length
      const overBudget = (): boolean => (maxRuns > 0 && liveRuns > maxRuns) || (maxBytes > 0 && liveBytes > maxBytes)
      if (names.length <= keep || (expired === 0 && !overBudget())) continue
      // Unreadable session state cannot prove which runs it still names, so the whole session stays live.
      const named = await references(sid)
      if (!named) continue
      const terminalRuns: { st: BigIntStats; rid: string; summary: RunSummary; archived: { event_count: number; journal_truncated: boolean } }[] = []
      for (const name of names) {
        const rid = name.slice(0, -'.jsonl'.length)
        let files: RunFiles
        try { files = await this.openRun(sid, rid, true) } catch { continue }
        let tail
        try { tail = files.liveStat ? await JsonJournal.tailOf(files, sid, rid, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_MAX_ROWS) : null } catch { tail = null } finally { await files.close() }
        if (tail && files.liveStat) {
          const summary = JsonJournal.summaryFromEvents(sid, rid, tail.events)
          if (summary.terminal) {
            result.terminal += 1
            terminalRuns.push({ st: files.liveStat, rid, summary, archived: { event_count: JsonJournal.summaryFromTail(sid, rid, tail).event_count, journal_truncated: tail.truncated } })
          }
        }
        if (!(await proceed())) return result
      }
      terminalRuns.sort((a, b) => (b.st.mtimeNs > a.st.mtimeNs ? 1 : b.st.mtimeNs < a.st.mtimeNs ? -1 : b.rid.localeCompare(a.rid)))
      // Oldest first, so the budgets archive the oldest settled runs. Each due run publishes its archive and legacy
      // summary; one fsync of both directories then makes the session's publications durable before any live bytes go.
      const published: { rid: string; size: number; archivable: () => boolean }[] = []
      for (const { st, rid, summary, archived } of terminalRuns.slice(keep).reverse()) {
        if (opts.signal?.aborted) break
        const mtime = Number(st.mtimeNs) / 1e9
        if ((mtime > cutoff && !overBudget()) || named.has(rid)) continue
        const path = join(dir, `${rid}.jsonl`)
        // Still the parsed file, with no live writer, in the session the sweep started. ctime catches a replacement
        // that reuses the inode, size, and mtime.
        const archivable = (): boolean => {
          if ((this.deletions.get(sid) ?? 0) !== generation || [...this.writers].some((writer) => writer.path === path) || opts.isActive?.(path)) return false
          try { return sameFile(lstatSync(path, { bigint: true }), st) } catch { return false }
        }
        if (!archivable()) continue
        const size = Number(st.size)
        if (!opts.dryRun) {
          // The legacy fields stay as the previous Stable reads them; `archived` carries this release's lookup summary.
          const legacy = JSON.stringify({ ...summary, journal_pruned: true, journal_pruned_at: now, original_size: size, original_mtime: mtime, archived })
          if (!(await this.publishRun(sid, rid, st, legacy, archivable, opts.signal))) continue
          published.push({ rid, size, archivable })
        } else {
          result.pruned += 1
          result.bytes_reclaimed += size
        }
        liveRuns -= 1
        liveBytes -= size
      }
      if (!published.length) continue
      try { await fsyncDir(join(dir, ARCHIVE_DIR)); await fsyncDir(dir) } catch { continue }
      // Recheck after the async publication: the session may now name the run, or it may have changed or been deleted.
      const current = await references(sid)
      for (const { rid, size, archivable } of published) {
        if (!current || current.has(rid) || !archivable()) continue
        try { unlinkSync(join(dir, `${rid}.jsonl`)) } catch { continue }
        result.pruned += 1
        result.bytes_reclaimed += size
      }
      if (opts.signal?.aborted) return result
    }
    return result
  }

  /**
   * Publish a verified archive of the run's logical journal, then the legacy summary the previous Stable reads once the
   * live journal is gone. The caller fsyncs both directories before removing live bytes, so a failure at any step leaves
   * the live copy readable and a crash between steps leaves copies that read as one run. Directories are created
   * without recursion and every directory entry is created or renamed synchronously, so a session deleted meanwhile is
   * never recreated.
   */
  private async publishRun(sid: string, rid: string, st: BigIntStats, legacySummary: string, archivable: () => boolean, signal?: AbortSignal): Promise<boolean> {
    const sessionDir = join(this.root(), sid)
    const dir = join(sessionDir, ARCHIVE_DIR)
    try { mkdirSync(dir, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false }
    let dirStat: BigIntStats
    try { dirStat = lstatSync(dir, { bigint: true }) } catch { return false }
    if (!dirStat.isDirectory()) return false
    const sameDir = (): boolean => { try { const cur = lstatSync(dir, { bigint: true }); return cur.isDirectory() && cur.dev === dirStat.dev && cur.ino === dirStat.ino } catch { return false } }
    let files: RunFiles
    try { files = await this.openRun(sid, rid, true) } catch { return false }
    let archive: Awaited<ReturnType<typeof stageArchive>> = null
    let summary: StagedFile | null = null
    try {
      if (!files.liveStat || !sameFile(files.liveStat, st)) return false
      archive = await stageArchive(dir, `${rid}${ARCHIVE_SUFFIX}`, logicalBytes(runLines(files.archive, files.live, sid, rid)), signal)
      if (!archive) return false
      summary = await StagedFile.create(sessionDir, `${rid}${PRUNED_SUMMARY_SUFFIX}`, async (handle) => { await writeFullyAsync(handle, legacySummary) })
      if (!summary) return false
      // Concurrent fsyncs share one device flush.
      await Promise.all([archive.file.sync(), summary.sync()])
      if (!(await archive.verify())) return false
      return archive.file.publish(() => archivable() && sameDir()) && summary.publish(archivable)
    } catch { return false } finally {
      await files.close()
      await archive?.file.discard()
      await summary?.discard()
    }
  }

  /** Locate a run across sessions (Python `find_run_summary`): live journals first, then archived and pruned runs. */
  async findRunSummary(runId: string): Promise<RunSummary | null> {
    let rid: string
    try {
      rid = validateId(runId, 'run_id')
    } catch {
      return null
    }
    const cached = this.runOwners.get(rid)
    if (cached !== undefined) {
      this.runOwners.delete(rid)
      const summary = (await this.resolvedRunSummary(cached, rid, false)) ?? (await this.resolvedRunSummary(cached, rid, true))
      if (summary) return summary
    }
    let sessions: string[]
    try {
      sessions = readdirSync(this.root()).filter((sid) => SAFE_ID_RE.test(sid) && !/^\.+$/.test(sid))
    } catch {
      return null
    }
    for (const sid of sessions) {
      const summary = await this.resolvedRunSummary(sid, rid, false)
      if (summary) return summary
    }
    for (const sid of sessions) {
      const summary = await this.resolvedRunSummary(sid, rid, true)
      if (summary) return summary
    }
    return null
  }

  private async resolvedRunSummary(sessionId: string, runId: string, settled: boolean): Promise<RunSummary | null> {
    const journalPath = this.pathFor(sessionId, runId)
    const archivePath = this.archivePathFor(sessionId, runId)
    const summaryPath = journalPath.replace(/\.jsonl$/, PRUNED_SUMMARY_SUFFIX)
    let path: string
    if (!settled) path = journalPath
    else {
      try { lstatSync(archivePath); path = archivePath } catch { path = summaryPath }
    }
    if (!existsSync(path)) return null
    const summary = await this.summaryOf(sessionId, runId)
    if (!summary) return null
    this.rememberOwner(runId, sessionId)
    summary.path = path
    return summary
  }

  /** Cache ownership only; appends and retention summaries must always be read fresh. */
  private rememberOwner(runId: string, sessionId: string): void {
    if (this.closed) return
    this.runOwners.delete(runId)
    this.runOwners.set(runId, sessionId)
    if (this.runOwners.size > RUN_OWNER_CACHE_MAX) this.runOwners.delete(this.runOwners.keys().next().value!)
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
    const positions = new Map<string, { offset: number; seq: number; dev: bigint; ino: bigint; complete: boolean; archived: boolean }>()
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
    let runIds: string[] = []
    try { runIds = (await readdir(sessionRoot)).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length)) } catch { runIds = [] }
    try { runIds.push(...(await readdir(join(sessionRoot, ARCHIVE_DIR))).filter((n) => n.endsWith(ARCHIVE_SUFFIX)).map((n) => n.slice(0, -ARCHIVE_SUFFIX.length))) } catch { /* no archives */ }
    for (const runId of [...new Set(runIds)].sort()) {
      try { validateId(runId, 'run_id') } catch { continue }
      let files: RunFiles
      try { files = await this.openRun(sid, runId) } catch { return result('replay_unreadable') }
      try {
        let raw: Buffer
        let st: BigIntStats
        if (!files.archive) {
          if (!files.live || !files.liveStat) continue
          st = files.liveStat
          if (Number(st.size) + retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
          raw = await readFile(files.live)
        } else {
          const chunks: Buffer[] = []
          let size = 0
          // The budget stops the read per chunk, before an oversized row is assembled or parsed.
          for await (const chunk of logicalBytes(runLines(files.archive, files.live, sid, runId, { remaining: SESSION_REPLAY_MAX_BYTES - retainedBytes }))) {
            size += chunk.length
            if (size + retainedBytes > SESSION_REPLAY_MAX_BYTES) return result('replay_limit_bytes')
            chunks.push(chunk)
          }
          raw = Buffer.concat(chunks)
          st = files.liveStat ?? await files.archive.stat({ bigint: true })
        }
        const parsed = parse(runId, raw)
        if (parsed.status !== 'ok') return parsed
        const events = parsed.events
        // An archived run has no live offset to continue from; its active tail always asks for a snapshot.
        positions.set(runId, { offset: raw.length, seq: events.at(-1)?.seq ?? 0, dev: st.dev, ino: st.ino, complete: !raw.length || raw.at(-1) === 10, archived: Boolean(files.archive) })
        let createdAt = Number.POSITIVE_INFINITY
        for (const e of events) createdAt = Math.min(createdAt, e.created_at || 0)
        if (!Number.isFinite(createdAt)) createdAt = Number(st.mtimeMs) / 1000
        runs.push({ createdAt, runId, events })
      } catch (error) {
        if (error instanceof JournalReadLimit) return result('replay_limit_bytes')
        if (error instanceof JournalArchiveError) return result('replay_unreadable')
        continue
      } finally { await files.close() }
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
      if (previous?.archived) return result('replay_changed')
      try {
        // A run may finish between idle polls; the active tail alone cannot recover that history.
        const current = await readdir(sessionRoot)
        if (current.some((name) => name.endsWith('.jsonl') && name !== `${runId}.jsonl` && !positions.has(name.slice(0, -'.jsonl'.length)))) return result('replay_changed')
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
  async staleInterruptedEvent(sessionId: string, runId: string, afterSeq: number | null = null, now = Date.now() / 1000): Promise<JournalEvent | null> {
    return staleInterruptedEvent(await this.latestRunSummary(sessionId, runId), sessionId, runId, afterSeq, now)
  }
}

export class JsonJournalWriter {
  private fd: number | null = null
  // fsyncs run on the thread pool; this tail orders them and every close after them.
  private syncs: Promise<void> = Promise.resolve()
  private seq: number
  private closed = false
  readonly path: string

  /** `seq` is the run's last journaled seq, which `JsonJournal.open` resolves (never nonzero in practice; ids are fresh). */
  constructor(private readonly journal: JsonJournal, readonly sessionId: string, readonly runId: string, private readonly fsyncMode: 'eager' | 'terminal-only', private readonly now: () => number = () => Date.now() / 1000, seq = 0) {
    this.path = journal.pathFor(sessionId, runId)
    this.seq = seq
    journal.register(this)
  }

  async append(row: JournalInput, opts: { terminal: boolean }): Promise<JournalEvent> {
    return this.appendSseEventNow(row.event, row.payload, row.redacted === undefined ? {} : { redacted: row.redacted }, opts.terminal, row.created_at)
  }

  async appendSseEvent(eventName: string, payload: unknown, meta: JournalEventMeta = {}): Promise<JournalEvent> { return this.appendSseEventNow(eventName, payload, meta) }

  /** Writes stay synchronous so frames land in order; a durable frame settles only after its fsync, so callers publish it durable. */
  private async appendSseEventNow(eventName: string, payload: unknown, meta: JournalEventMeta = {}, terminal?: boolean, createdAt?: number): Promise<JournalEvent> {
    if (this.closed) throw new Error('run journal writer is closed')
    const name = eventName.trim()
    if (!name) throw new Error('event_name is required')
    this.seq += 1
    const event = journalEvent(this.sessionId, this.runId, this.seq, name, payload, { terminal, createdAt: createdAt ?? meta.createdAt ?? this.now(), redacted: meta.redacted })
    if (this.fd === null) {
      mkdirSync(dirname(this.path), { recursive: true })
      this.fd = openSync(this.path, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600)
    }
    const fd = this.fd
    writeFully(fd, `${JSON.stringify(event)}\n`)
    // Best effort, as before: a failed fsync never fails the append.
    if (this.fsyncMode === 'eager' || event.terminal) this.syncs = this.syncs.then(() => new Promise((resolve) => { fsync(fd, () => { resolve() }) }))
    // Every frame waits for earlier fsyncs, so appends settle (and callers publish) in append order.
    const settled = this.syncs
    if (SSE_RELAY_CLOSE_EVENTS.has(name)) this.closeHandle()
    await settled
    return event
  }

  /** Detach the fd now so the next append reopens; close it once queued fsyncs finish. */
  private closeHandle(): void {
    const fd = this.fd
    if (fd === null) return
    this.fd = null
    this.syncs = this.syncs.then(() => { try { closeSync(fd) } catch { /* ignore */ } })
  }

  async close(): Promise<void> {
    this.closed = true
    this.closeHandle()
    await this.syncs
    this.journal.release(this)
  }
}
