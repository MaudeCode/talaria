/**
 * `talaria-web serve` runs the server in a child so a self-update can restart it
 * (Python `os.execv`; Node has no in-place exec). The supervisor keeps the PID
 * that ctl, launchd, and systemd track, forwards signals, and respawns only
 * when the child requests a restart, or once after an updated worker fails before readiness.
 *
 * Lifetime contract (TAL-1432): a worker never outlives its supervisor holding the port.
 * - The supervisor forwards the first stop signal once, kills its own worker if it has not exited
 *   within `stopGraceMs`, and returns or respawns only after that worker's `close`.
 * - The worker (`watchRetirement`) retires on a stop signal or when its IPC supervisor disconnects:
 *   before its close path exists it exits at once; after, it stops listening, drains its local chat runs
 *   (`RUN_DRAIN_MS`, then saves the rest as interrupted), and exits within `WORKER_SHUTDOWN_MS`, which is
 *   shorter than the supervisor's grace. A later repeated signal ends the drain's wait early, once.
 * A process stuck in an uninterruptible kernel wait ignores SIGKILL too; the supervisor then keeps
 * waiting rather than start a successor that cannot bind.
 */
import { spawn } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { atomicWriteText } from '../fs/atomic.js'
import { readUpdateRollback, rollbackPaths } from '../tools/update-rollback.js'
import { homeDotenvKeys, setHomeDotenvKeys } from './dotenv.js'

export const RESTART_EXIT_CODE = 75
export const WORKER_ENV = 'TALARIA_WEB_WORKER'
export const WORKER_SHUTDOWN_MS = 10_000
export const STOP_GRACE_MS = 15_000
/**
 * TAL-1628: how the worker's shutdown budget is spent on local chat runs. They may finish on their own for
 * `RUN_DRAIN_MS`; the rest is the settlement margin, in which `RUN_SETTLE_MS` saves each unfinished run as interrupted
 * and what remains closes storage, all before `WORKER_SHUTDOWN_MS`.
 */
export const RUN_SETTLEMENT_MARGIN_MS = 4_000
export const RUN_DRAIN_MS = WORKER_SHUTDOWN_MS - RUN_SETTLEMENT_MARGIN_MS
export const RUN_SETTLE_MS = 2_500
/** Signals this close together are one stop request delivered twice (a terminal's process group and the supervisor's forward). */
export const DUPLICATE_SIGNAL_MS = 1_000

export interface SuperviseOptions {
  command: string[]
  env: NodeJS.ProcessEnv
  log: (line: string) => void
  packageRoot?: string
  stateDir?: string
  /** Milliseconds between a restart exit and the respawn (port release). */
  restartDelayMs?: number
  /** Milliseconds a stopping worker may take before the supervisor kills it. */
  stopGraceMs?: number
}

export async function supervise(opts: SuperviseOptions): Promise<number> {
  const [cmd, ...args] = opts.command
  if (!cmd) throw new Error('supervise: empty command')
  const cwd = process.cwd()
  let stopping = false
  let afterRestart = false
  let rolledBack = false
  for (;;) {
    const env: NodeJS.ProcessEnv = { ...opts.env, [WORKER_ENV]: '1' }
    // Reload home-file values in each worker; the supervisor may hold credentials revoked since startup.
    for (const key of homeDotenvKeys(env)) Reflect.deleteProperty(env, key)
    setHomeDotenvKeys(env, new Set())
    const paths = opts.packageRoot && opts.stateDir ? rollbackPaths(opts.packageRoot, opts.stateDir) : null
    const pendingUpdate = paths && existsSync(paths.previous) ? readUpdateRollback(opts.stateDir) : null
    const child = spawn(cmd, args, { cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env })
    let ready = false
    child.on('message', (message) => {
      if (message !== 'ready' || ready) return
      ready = true
      if (afterRestart && !rolledBack && paths && pendingUpdate) {
        // A later update may already have written a different marker after this worker started listening.
        if (JSON.stringify(readUpdateRollback(opts.stateDir)) !== JSON.stringify(pendingUpdate)) return
        try {
          rmSync(paths.failed, { recursive: true, force: true })
          rmSync(paths.marker, { force: true })
        } catch (error) { opts.log(`[serve] could not finish update recovery cleanup: ${(error as Error).message}`) }
      }
    })
    let killTimer: NodeJS.Timeout | undefined
    const forward = (signal: NodeJS.Signals) => (): void => {
      // The worker shuts down once; repeating the signal would only cut its cleanup short.
      if (stopping) return
      stopping = true
      child.kill(signal)
      const graceMs = opts.stopGraceMs ?? STOP_GRACE_MS
      killTimer = setTimeout(() => {
        opts.log(`[serve] worker ${String(child.pid)} did not exit within ${String(graceMs)} ms of ${signal}; killing it`)
        child.kill('SIGKILL')
      }, graceMs)
    }
    const handlers: [NodeJS.Signals, () => void][] = [['SIGTERM', forward('SIGTERM')], ['SIGINT', forward('SIGINT')], ['SIGHUP', forward('SIGHUP')]]
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const code = await new Promise<number>((resolve) => {
      child.on('close', (status, signal) => { resolve(status ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1)) })
      child.on('error', (error) => {
        // A started worker still owns its port: wait for its close rather than return or respawn beside it.
        if (child.pid !== undefined) { opts.log(`[serve] worker error: ${error.message}`); return }
        opts.log(`[serve] worker failed to start: ${error.message}`)
        resolve(1)
      })
    })
    clearTimeout(killTimer)
    for (const [signal, handler] of handlers) process.off(signal, handler)
    if (stopping) return code
    if (code !== RESTART_EXIT_CODE) {
      const marker = readUpdateRollback(opts.stateDir)
      if (!afterRestart || ready || rolledBack || !marker || !paths || !opts.packageRoot || !existsSync(paths.previous)) return code
      try {
        rmSync(paths.failed, { recursive: true, force: true })
        renameSync(opts.packageRoot, paths.failed)
        try { renameSync(paths.previous, opts.packageRoot) }
        catch (error) { renameSync(paths.failed, opts.packageRoot); throw error }
        // Record the attempt before spawning again; never loop if the restored worker also crashes.
        rolledBack = true
        try { atomicWriteText(paths.marker, JSON.stringify({ ...marker, failedVersion: marker.version })) }
        catch (error) { opts.log(`[serve] could not persist failed update: ${(error as Error).message}`) }
        opts.log(`[serve] update to ${marker.version} failed to start; restored ${marker.previousVersion}`)
        continue
      } catch (error) {
        opts.log(`[serve] update rollback failed: ${(error as Error).message}`)
        return code
      }
    }
    rolledBack = false
    afterRestart = true
    opts.log('[serve] restarting the server with the updated source')
    await new Promise((r) => setTimeout(r, opts.restartDelayMs ?? 500))
  }
}

export interface Retirement {
  readonly retiring: boolean
  /** Registers the shared close path once the server is listening, and what a repeated stop signal escalates. */
  attach: (close: () => Promise<void>, escalate?: () => void) => void
}

export interface RetirementOptions {
  log: (line: string) => void
  /** Also retire when the IPC supervisor disconnects or is already gone. */
  supervised?: boolean
  deadlineMs?: number
  exit?: (code: number) => void
  /** Signal and IPC event source; tests substitute an emitter. */
  events?: NodeJS.EventEmitter & { connected?: boolean }
  /** Milliseconds clock for telling a repeated signal from a duplicate delivery. */
  now?: () => number
}

/** Retires the server on SIGTERM/SIGINT/SIGHUP and, for a supervised worker, on loss of its supervisor. */
export function watchRetirement(opts: RetirementOptions): Retirement {
  const events = opts.events ?? process
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const deadlineMs = opts.deadlineMs ?? WORKER_SHUTDOWN_MS
  const now = opts.now ?? (() => Date.now())
  let close: (() => Promise<void>) | null = null
  let escalate: (() => void) | null = null
  let retiring = false
  let retiredAt = 0
  let escalated = false
  let exited = false
  const finish = (code: number): void => { if (!exited) { exited = true; exit(code) } }
  const run = (shutdown: () => Promise<void>): void => {
    const timer = setTimeout(() => {
      opts.log(`[webui] shutdown did not finish within ${String(deadlineMs)} ms; exiting`)
      finish(1)
    }, deadlineMs)
    void Promise.resolve().then(shutdown).then(
      () => { clearTimeout(timer); finish(0) },
      (error: unknown) => { clearTimeout(timer); opts.log(`[webui] shutdown failed: ${(error as Error).message}`); finish(1) },
    )
  }
  const retire = (reason: string): void => {
    if (retiring) return
    retiring = true
    retiredAt = now()
    opts.log(`[webui] ${reason}; shutting down`)
    // Nothing has been served before the close path exists.
    if (close) run(close)
    else finish(0)
  }
  // TAL-1628: a stop signal repeated after the first one's duplicate window escalates the shutdown once.
  const signalled = (signal: NodeJS.Signals): void => {
    if (!retiring) { retire(`${signal} received`); return }
    if (escalated || !close || !escalate || now() - retiredAt < DUPLICATE_SIGNAL_MS) return
    escalated = true
    opts.log(`[webui] ${signal} received again; interrupting local runs now`)
    escalate()
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) events.on(signal, () => { signalled(signal) })
  if (opts.supervised) {
    events.on('disconnect', () => { retire('supervisor disconnected') })
    // The listener must not keep a worker alive that would otherwise exit.
    if (events === process) process.channel?.unref()
    if (!events.connected) retire('supervisor disconnected')
  }
  return {
    get retiring() { return retiring },
    attach: (shutdown, onEscalate) => { if (!retiring) { close = shutdown; escalate = onEscalate ?? null } },
  }
}
