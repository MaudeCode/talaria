/**
 * `talaria-web serve` runs the server in a child so a self-update can restart it
 * (Python `os.execv`; Node has no in-place exec). The supervisor keeps the PID
 * that ctl, launchd, and systemd track, forwards signals, and respawns only
 * when the child exits with `RESTART_EXIT_CODE`.
 */
import { spawn } from 'node:child_process'

export const RESTART_EXIT_CODE = 75
export const WORKER_ENV = 'TALARIA_WEB_WORKER'

export interface SuperviseOptions {
  command: string[]
  env: NodeJS.ProcessEnv
  log: (line: string) => void
  /** Milliseconds between a restart exit and the respawn (port release). */
  restartDelayMs?: number
}

export async function supervise(opts: SuperviseOptions): Promise<number> {
  const [cmd, ...args] = opts.command
  if (!cmd) throw new Error('supervise: empty command')
  let stopping = false
  for (;;) {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...opts.env, [WORKER_ENV]: '1' } })
    const forward = (signal: NodeJS.Signals) => (): void => { stopping = true; child.kill(signal) }
    const handlers: [NodeJS.Signals, () => void][] = [['SIGTERM', forward('SIGTERM')], ['SIGINT', forward('SIGINT')], ['SIGHUP', forward('SIGHUP')]]
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const code = await new Promise<number>((resolve) => {
      child.on('exit', (status, signal) => { resolve(status ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1)) })
      child.on('error', (error) => { opts.log(`[serve] worker failed to start: ${error.message}`); resolve(1) })
    })
    for (const [signal, handler] of handlers) process.off(signal, handler)
    if (code !== RESTART_EXIT_CODE || stopping) return code
    opts.log('[serve] restarting the server with the updated source')
    await new Promise((r) => setTimeout(r, opts.restartDelayMs ?? 500))
  }
}
