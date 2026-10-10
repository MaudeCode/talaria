/**
 * Startup readiness gate (Python `api/startup.py`). Starts ready; the server
 * arms it before deferred recovery and releases it when recovery settles.
 * `/api/` requests wait a bounded time, with a bounded number of waiters.
 */
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { truthy, type ServerConfig } from './config.js'
import { isLoopback } from './http/origin.js'

export const STARTUP_WAIT_SECONDS = 10
export const STARTUP_WAIT_SLOT_COUNT = 8
export const STARTUP_RECOVERY_CONDITION = 'startup_recovery'
export const STARTUP_IMMEDIATE_PATHS = new Set(['/api/health/restart', '/api/csp-report'])

export class StartupGate {
  ready = true
  phase = 'session recovery'
  private waiters = 0
  private resolvers: (() => void)[] = []

  arm(phase = 'session recovery'): void {
    this.ready = false
    this.phase = phase
  }

  release(): void {
    this.ready = true
    const pending = this.resolvers
    this.resolvers = []
    for (const resolve of pending) resolve()
  }

  /** `true` when the request may proceed; `false` when it should get the startup 503. */
  async wait(timeoutMs = STARTUP_WAIT_SECONDS * 1000): Promise<boolean> {
    if (this.ready) return true
    if (this.waiters >= STARTUP_WAIT_SLOT_COUNT) return false
    this.waiters += 1
    try {
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { resolve(this.ready) }, timeoutMs)
        this.resolvers.push(() => { clearTimeout(timer); resolve(true) })
      })
    } finally {
      this.waiters -= 1
    }
  }
}

/** Credential files in `HERMES_HOME` that must never be group- or world-accessible. */
const SENSITIVE_FILES = ['.env', 'auth.json', 'google_token.json', 'google_client_secret.json']
// Never follow a link (or a swap after the check) to an unrelated target; never block on a FIFO.
const O_CHMOD = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/**
 * Python `fix_credential_permissions`: tighten credential files to 0600 at startup (the Agent skips this in
 * containers). `HERMES_SKIP_CHMOD` bypasses it; an operator `HERMES_HOME_MODE` keeps group bits and clears world bits.
 */
export function fixCredentialPermissions(config: Pick<ServerConfig, 'env' | 'hermesHome'>, log: (line: string) => void): void {
  // Windows has no POSIX group/world bits to clear.
  if (process.platform === 'win32' || truthy(config.env.HERMES_SKIP_CHMOD)) return
  const declaredMode = /^[0-7]+$/.test((config.env.HERMES_HOME_MODE ?? '').trim())
  for (const name of SENSITIVE_FILES) {
    let fd: number | undefined
    try {
      fd = openSync(join(config.hermesHome, name), O_CHMOD)
      const stat = fstatSync(fd)
      const current = stat.mode & 0o777
      if (!stat.isFile() || (current & (declaredMode ? 0o007 : 0o077)) === 0) continue
      const next = declaredMode ? current & ~0o007 : 0o600
      fchmodSync(fd, next)
      log(`  [security] fixed permissions on ${name} (0${current.toString(8)} -> 0${next.toString(8)})`)
    } catch { /* missing, a link, or not ours; best effort, never abort startup */ } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

/**
 * Python `server.py` startup check: a non-loopback bind with no auth method exposes the filesystem and agent.
 * `boundAddress` is the listener's resolved address, so `localhost` and every loopback spelling stay quiet.
 */
export async function warnUnauthenticatedBind(host: string, boundAddress: string, auth: { isAuthEnabled: () => Promise<boolean> }, log: (line: string) => void): Promise<void> {
  if (isLoopback(boundAddress) || await auth.isAuthEnabled()) return
  log(`[!!] WARNING: Binding to ${host} with NO PASSWORD SET.`)
  log('     Anyone on the network can access your filesystem and agent.')
  log('     Set a password via Settings or HERMES_WEBUI_PASSWORD env var.')
  log('     To suppress: bind to 127.0.0.1 or set a password.')
}
