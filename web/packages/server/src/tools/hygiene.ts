/**
 * Periodic process hygiene (Python `background_process._run_process_hygiene`
 * and `logging_hygiene.rotate_webui_log`): copy-truncate log rotation every
 * tick, run-journal retention on a long interval. Node closes session
 * channels on the last unsubscribe, so the channel reaper has nothing to do.
 */
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { join } from 'node:path'
import type { RunJournal } from '../sessions/journal.js'
import { isSafeSessionId } from '../sessions/session.js'
import type { SessionBackend } from '../sessions/storage/backend.js'

export const HYGIENE_INTERVAL_MS = 60_000
const RETENTION_INTERVAL_S = 6 * 3600
const LOG_DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** Python `webui_log_paths`: an absolute `HERMES_WEBUI_LOG_FILE` wins, else the launcher's `bootstrap-<port>.log`. */
export function webuiLogPaths(env: Record<string, string | undefined>, stateDir: string, port: number): string[] {
  const configured = (env.HERMES_WEBUI_LOG_FILE ?? '').trim()
  if (configured.startsWith('/')) return [configured]
  return [join(stateDir, `bootstrap-${String(port)}.log`)]
}

export function webuiLogMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.HERMES_WEBUI_LOG_MAX_BYTES
  if (raw === undefined) return LOG_DEFAULT_MAX_BYTES
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : LOG_DEFAULT_MAX_BYTES
}

/** Python `_rotate_one`: copy the oversized sink into `<log>.1` and truncate the same descriptor in place. */
export function rotateOne(target: string, limit: number, log: (line: string) => void): boolean {
  let fd: number
  try { fd = openSync(target, 'r+') } catch { return false }
  try {
    const size = fstatSync(fd).size
    if (size <= limit) return false
    const previous = `${target}.1`
    const out = openSync(previous, 'w')
    try {
      const buf = Buffer.alloc(1 << 16)
      let offset = 0
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, offset)
        if (n <= 0) break
        writeFully(out, buf.subarray(0, n))
        offset += n
      }
    } finally { closeSync(out) }
    ftruncateSync(fd, 0)
    log(`[webui] Rotated the WebUI log at ${target} (${String(size)} bytes) into ${previous}`)
    return true
  } catch (error) {
    log(`[webui] WARNING: Could not rotate the WebUI log at ${target}: ${(error as Error).message}`)
    return false
  } finally { closeSync(fd) }
}

export function rotateWebuiLog(paths: string[], limit: number, log: (line: string) => void): boolean {
  if (limit <= 0) return false
  return paths.filter(existsSync).map((p) => rotateOne(p, limit, log)).some(Boolean)
}

/**
 * The runs a session's persisted state still names, which retention leaves live for the prior Stable's recovery path. A
 * journal session without a session document (an owner observation, or a session already deleted) names none; an
 * unreadable document answers null, so the sweep leaves that session alone.
 */
export function sessionRunReferences(sessions: Pick<SessionBackend, 'readDocument'>): (sessionId: string) => Promise<ReadonlySet<string> | null> {
  return async (sessionId) => {
    if (!isSafeSessionId(sessionId)) return new Set()
    try {
      const active = (await sessions.readDocument(sessionId, { metadataOnly: true }))?.doc.active_stream_id
      return new Set(typeof active === 'string' && active.trim() ? [active.trim()] : [])
    } catch { return null }
  }
}

export interface HygieneDeps {
  env: Record<string, string | undefined>
  stateDir: string
  port: () => number
  journal: RunJournal
  now: () => number
  log: (line: string) => void
  /** Session state retention must read before archiving a session's journals. */
  sessions?: Pick<SessionBackend, 'readDocument'>
  /** Extra per-tick sweeps (completion dedupe, terminal idle reaper). */
  sweeps?: (() => void | Promise<void>)[]
}

export class HygieneTicker {
  private timer: NodeJS.Timeout | null = null
  private retentionLastRun: number | null = null
  private retention: Promise<void> | null = null
  private readonly sweeps = new Map<() => void | Promise<void>, Promise<void>>()
  private abort = new AbortController()
  constructor(private readonly deps: HygieneDeps) {}

  start(intervalMs = HYGIENE_INTERVAL_MS): void {
    if (this.timer) return
    if (this.abort.signal.aborted) this.abort = new AbortController()
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    this.timer.unref()
  }

  /** Stops scheduling, aborts retention at its next yield, and drains all accepted sweeps. */
  stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.abort.abort()
    return this.pending()
  }

  /**
   * Python `_run_process_hygiene`: every step is best effort. Retention runs in
   * the background, one sweep at a time; the returned promise settles when the
   * current sweep (if any) does.
   */
  tick(): Promise<void> {
    if (this.abort.signal.aborted) return this.pending()
    const step = (label: string, run: () => void): void => { try { run() } catch (error) { this.warn(label, error) } }
    step('WebUI log rotation', () => { rotateWebuiLog(webuiLogPaths(this.deps.env, this.deps.stateDir, this.deps.port()), webuiLogMaxBytes(this.deps.env), this.deps.log) })
    for (const sweep of this.deps.sweeps ?? []) {
      if (this.sweeps.has(sweep)) continue
      const pending = Promise.resolve().then(sweep)
        .catch((error: unknown) => { this.warn('hygiene sweep', error) })
        .finally(() => { this.sweeps.delete(sweep) })
      this.sweeps.set(sweep, pending)
    }
    if (this.retention) return this.pending()
    const now = this.deps.now()
    const { signal } = this.abort
    if (this.retentionLastRun !== null && now - this.retentionLastRun < RETENTION_INTERVAL_S) return this.pending()
    this.retentionLastRun = now
    this.retention = this.deps.journal.pruneSettled({ now, signal, ...(this.deps.sessions ? { protectedRuns: sessionRunReferences(this.deps.sessions) } : {}) })
      .then((result) => { if (result.pruned) this.deps.log(`[webui] run-journal retention archived ${String(result.pruned)} journals (${String(result.bytes_reclaimed)} live bytes)`) })
      .catch((error: unknown) => { this.warn('run-journal retention', error) })
      .finally(() => { this.retention = null })
    return this.pending()
  }

  private pending(): Promise<void> {
    if (!this.sweeps.size) return this.retention ?? Promise.resolve()
    return Promise.all([...this.sweeps.values(), this.retention]).then(() => { /* all sweeps have settled */ })
  }

  private warn(label: string, error: unknown): void { this.deps.log(`[webui] WARNING: ${label} failed: ${(error as Error).message}`) }
}
