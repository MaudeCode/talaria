/**
 * Startup readiness gate (Python `api/startup.py`). Starts ready; the server
 * arms it before deferred recovery and releases it when recovery settles.
 * `/api/` requests wait a bounded time, with a bounded number of waiters.
 */
import { lookup } from 'node:dns/promises'
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_EXIT_CODE } from './cli/supervise.js'
import { truthy, type ServerConfig } from './config.js'
import { isLoopback, listsTrustedProxy, trustsProxyBeyondLoopback } from './http/origin.js'

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

/** TAL-2197: startup refused a configuration; the worker exits with the code its supervisor treats as fatal. */
export class StartupConfigError extends Error {
  readonly exitCode = CONFIG_EXIT_CODE
}

/**
 * TAL-2197: a non-loopback bind with no sign-in method hands everyone who can reach the port a shell and the provider
 * keys, so startup refuses it before listening unless the operator accepts the risk with
 * `TALARIA_WEB_ALLOW_UNAUTHENTICATED=1`; then it warns. The host resolves as `listen` resolves it, so `localhost` and
 * every loopback spelling pass; an empty host listens on every interface.
 */
export async function refuseUnauthenticatedBind(host: string, env: ServerConfig['env'], auth: { isAuthEnabled: () => Promise<boolean> }, log: (line: string) => void): Promise<void> {
  const address = host ? (await lookup(host)).address : '::'
  if (isLoopback(address) || await auth.isAuthEnabled()) return
  if (!truthy(env.TALARIA_WEB_ALLOW_UNAUTHENTICATED)) {
    throw new StartupConfigError(`Refusing to listen on ${host || 'every interface'} with no sign-in method: anyone who can reach the port would get a shell and your provider keys. Set TALARIA_WEB_PASSWORD (or configure a passkey, OIDC, or a trusted auth header), bind to 127.0.0.1, or set TALARIA_WEB_ALLOW_UNAUTHENTICATED=1 to accept the risk.`)
  }
  log(`[!!] WARNING: Binding to ${host} with NO PASSWORD SET.`)
  log('     Anyone on the network can access your filesystem and agent.')
  log('     Set a password via Settings or TALARIA_WEB_PASSWORD env var.')
  log('     To suppress: bind to 127.0.0.1 or set a password.')
}

/**
 * Forwarding opt-in with no proxy listed outside this host. The text stays true whether or not loopback is
 * listed: the request log trusts loopback implicitly, but per-client limits use a forwarded client only from
 * a listed proxy, and a proxy on another host or a Docker bridge is ignored by both until it is listed.
 */
export function warnForwardedForWithoutProxy(env: ServerConfig['env'], log: (line: string) => void): void {
  if (!truthy(env.TALARIA_WEB_TRUST_FORWARDED_FOR) || trustsProxyBeyondLoopback(env)) return
  log('[!] TALARIA_WEB_TRUST_FORWARDED_FOR is set, but TALARIA_WEB_TRUSTED_PROXY_CIDRS lists no proxy outside this host.')
  log('    The request log trusts a proxy on this host through loopback; login, passkey, native OIDC start, and TTS limits')
  log('    use its forwarded client only once it is listed (TALARIA_WEB_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128).')
  log('    A proxy on another host or a Docker bridge must be listed instead (for example TALARIA_WEB_TRUSTED_PROXY_CIDRS=172.17.0.1);')
  log('    until then its X-Forwarded-For is ignored and its requests are logged with forwarded_for_ignored.')
  log('    The proxy must append the client address to X-Forwarded-For (nginx: $proxy_add_x_forwarded_for).')
}

/** Trusted-header sign-in counts the identity header only from a listed proxy (TAL-2203); with none listed it rejects every request. */
export function warnTrustedHeaderWithoutProxy(env: ServerConfig['env'], auth: { isTrustedAuthEnabled: () => boolean; warnOnce: (key: string, message: string) => void }): void {
  if (!auth.isTrustedAuthEnabled() || listsTrustedProxy(env)) return
  auth.warnOnce('trusted-auth-proxy', 'TALARIA_WEB_TRUSTED_AUTH_HEADER is set, but TALARIA_WEB_TRUSTED_PROXY_CIDRS lists no proxy; trusted-header sign-in rejects every request until the auth proxy\'s address is listed there (a proxy on this host: TALARIA_WEB_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128)')
}
