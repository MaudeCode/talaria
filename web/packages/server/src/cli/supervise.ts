/**
 * `talaria-web serve` runs the server in a child so a self-update can restart it
 * (Python `os.execv`; Node has no in-place exec). The supervisor keeps the PID
 * that ctl, launchd, and systemd track, forwards signals, and respawns only
 * when the child requests a restart, or once after an updated worker fails before readiness.
 */
import { spawn } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { atomicWriteText } from '../fs/atomic.js'
import { readUpdateRollback, rollbackPaths } from '../tools/update-rollback.js'

export const RESTART_EXIT_CODE = 75
export const WORKER_ENV = 'TALARIA_WEB_WORKER'

export interface SuperviseOptions {
  command: string[]
  env: NodeJS.ProcessEnv
  log: (line: string) => void
  packageRoot?: string
  stateDir?: string
  /** Milliseconds between a restart exit and the respawn (port release). */
  restartDelayMs?: number
}

export async function supervise(opts: SuperviseOptions): Promise<number> {
  const [cmd, ...args] = opts.command
  if (!cmd) throw new Error('supervise: empty command')
  const cwd = process.cwd()
  let stopping = false
  let afterRestart = false
  let rolledBack = false
  for (;;) {
    const child = spawn(cmd, args, { cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...opts.env, [WORKER_ENV]: '1' } })
    let ready = false
    const paths = opts.packageRoot && opts.stateDir ? rollbackPaths(opts.packageRoot, opts.stateDir) : null
    child.on('message', (message) => {
      if (message !== 'ready' || ready) return
      ready = true
      if (afterRestart && !rolledBack && paths) {
        try { rmSync(paths.marker, { force: true }) }
        catch (error) { opts.log(`[serve] could not clear update rollback marker: ${(error as Error).message}`) }
      }
    })
    const forward = (signal: NodeJS.Signals) => (): void => { stopping = true; child.kill(signal) }
    const handlers: [NodeJS.Signals, () => void][] = [['SIGTERM', forward('SIGTERM')], ['SIGINT', forward('SIGINT')], ['SIGHUP', forward('SIGHUP')]]
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const code = await new Promise<number>((resolve) => {
      child.on('close', (status, signal) => { resolve(status ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1)) })
      child.on('error', (error) => { opts.log(`[serve] worker failed to start: ${error.message}`); resolve(1) })
    })
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
        atomicWriteText(paths.marker, JSON.stringify({ ...marker, failedVersion: marker.version }))
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
