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

export interface HygieneDeps {
  env: Record<string, string | undefined>
  stateDir: string
  port: () => number
  journal: RunJournal
  activeJournalPaths: () => Set<string>
  now: () => number
  log: (line: string) => void
  /** Extra per-tick sweeps (completion dedupe, terminal idle reaper). */
  sweeps?: (() => void)[]
}

export class HygieneTicker {
  private timer: NodeJS.Timeout | null = null
  private retentionLastRun: number | null = null
  private retention: Promise<void> | null = null
  private abort = new AbortController()
  constructor(private readonly deps: HygieneDeps) {}

  start(intervalMs = HYGIENE_INTERVAL_MS): void {
    if (this.timer) return
    if (this.abort.signal.aborted) this.abort = new AbortController()
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    this.timer.unref()
  }

  /** Stops the schedule; an in-flight retention sweep stops at its next yield. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.abort.abort()
  }

  /**
   * Python `_run_process_hygiene`: every step is best effort. Retention runs in
   * the background, one sweep at a time; the returned promise settles when the
   * current sweep (if any) does.
   */
  tick(): Promise<void> {
    const step = (label: string, run: () => void): void => { try { run() } catch (error) { this.warn(label, error) } }
    step('WebUI log rotation', () => { rotateWebuiLog(webuiLogPaths(this.deps.env, this.deps.stateDir, this.deps.port()), webuiLogMaxBytes(this.deps.env), this.deps.log) })
    for (const sweep of this.deps.sweeps ?? []) step('hygiene sweep', sweep)
    if (this.retention) return this.retention
    const now = this.deps.now()
    const { signal } = this.abort
    if (signal.aborted || (this.retentionLastRun !== null && now - this.retentionLastRun < RETENTION_INTERVAL_S)) return Promise.resolve()
    this.retentionLastRun = now
    this.retention = this.deps.journal.pruneSettled({ now, signal, isActive: (path) => this.deps.activeJournalPaths().has(path) })
      .then((result) => { if (result.pruned) this.deps.log(`[webui] run-journal retention pruned ${String(result.pruned)} files (${String(result.bytes_reclaimed)} bytes)`) })
      .catch((error: unknown) => { this.warn('run-journal retention', error) })
      .finally(() => { this.retention = null })
    return this.retention
  }

  private warn(label: string, error: unknown): void { this.deps.log(`[webui] WARNING: ${label} failed: ${(error as Error).message}`) }
}
