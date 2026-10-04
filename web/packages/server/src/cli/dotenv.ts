/**
 * `.env` loading with the launcher precedence (Python `bootstrap.py` +
 * `ctl.sh`): the checkout `.env` applies unconditionally unless
 * `HERMES_WEBUI_PRESERVE_ENV` keeps values already in the environment; the
 * Hermes home `.env` is a fallback for keys the environment lacks (provider
 * credentials referenced as `${VAR}` in config.yaml) and never sets the
 * operator auth or isolation keys. `HERMES_WEBUI_NO_DOTENV=1` skips both.
 */
import { join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const READONLY = new Set(['UID', 'GID', 'EUID', 'EGID', 'PPID'])
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Deployment posture the agent-writable Hermes home `.env` may not set: otherwise a contained user could disable
 * isolation or swap the auth configuration on the next start (#4589).
 */
const PROTECTED_ENV_KEYS: ReadonlySet<string> = new Set([
  'HERMES_WEBUI_ISOLATED_PROFILE',
  'HERMES_WEBUI_PASSWORD',
  'HERMES_WEBUI_PASSKEY',
  'HERMES_WEBUI_COOKIE_NAME',
  'HERMES_WEBUI_SECURE',
  'HERMES_WEBUI_SESSION_TTL',
  'HERMES_WEBUI_SESSION_SLIDING',
  'HERMES_WEBUI_TRUSTED_AUTH_HEADER',
  'HERMES_WEBUI_TRUSTED_GROUPS_HEADER',
  'HERMES_WEBUI_GROUP_PROFILE_MAP',
  'HERMES_WEBUI_TRUSTED_AUTH_LOGOUT_URL',
  'HERMES_WEBUI_TRUSTED_PROXY_CIDRS',
  'HERMES_WEBUI_OIDC_ISSUER',
  'HERMES_WEBUI_OIDC_CLIENT_ID',
  'HERMES_WEBUI_OIDC_CLIENT_SECRET',
  'HERMES_WEBUI_OIDC_REDIRECT_URI',
  'HERMES_WEBUI_OIDC_SCOPES',
  'HERMES_WEBUI_OIDC_ALLOW_CLAIM',
  'HERMES_WEBUI_OIDC_ALLOW_VALUES',
  'HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS',
  'HERMES_WEBUI_OIDC_PROFILE_CLAIM',
  'HERMES_WEBUI_OIDC_PROFILE_MAP',
  'HERMES_WEBUI_OIDC_OWNER_CLAIM',
  'HERMES_WEBUI_OIDC_OWNER_VALUES',
])

function unescapeDouble(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]
    if (c === '\\' && i < raw.length - 1) {
      const n = raw[i + 1]
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : `\\${String(n)}`
      i += 1
    } else out += c ?? ''
  }
  return out
}

/** Python `ctl.sh _apply_env_file_safely`: `export` prefix, double-quoted escapes, single quotes, trailing `# comment`. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const exported = /^export\s+(.+)$/.exec(line)
    if (exported) line = (exported[1] ?? '').replace(/^\s+/, '')
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).replace(/\s+/g, '')
    if (!KEY_RE.test(key) || READONLY.has(key)) continue
    let value = line.slice(eq + 1).replace(/^\s+/, '')
    const dq = /^"((?:[^"\\]|\\.)*)"(?:\s*#.*)?\s*$/.exec(value)
    const sq = /^'([^']*)'(?:\s*#.*)?\s*$/.exec(value)
    if (dq) value = unescapeDouble(dq[1] ?? '')
    else if (sq) value = sq[1] ?? ''
    else value = value.replace(/\s#.*$/, '').replace(/\s+$/, '')
    out[key] = value
  }
  return out
}

export interface DotenvOptions {
  env: Record<string, string | undefined>
  /** The checkout `.env` (a git checkout of `web/`); absent for npm installs. */
  repoEnvFile?: string | null
  /** `$HERMES_HOME/.env`, applied only for keys the environment lacks and never for `PROTECTED_ENV_KEYS`. */
  hermesEnvFile?: string | null
  log?: (line: string) => void
}

/** Apply both files into `env` (mutating) and return the keys that were set. */
export function loadLauncherDotenv(opts: DotenvOptions): string[] {
  const { env } = opts
  if (['1', 'true', 'yes', 'on'].includes((env.HERMES_WEBUI_NO_DOTENV ?? '').trim().toLowerCase())) return []
  const applied: string[] = []
  const preserve = ['1', 'true', 'yes', 'on'].includes((env.HERMES_WEBUI_PRESERVE_ENV ?? '').trim().toLowerCase())
  const read = (path: string | null | undefined): Record<string, string> | null => {
    if (!path || !existsSync(path)) return null
    try { return parseDotenv(readFileSync(path, 'utf8')) } catch (error) { opts.log?.(`[bootstrap] Warning: could not load ${path}: ${(error as Error).message}`); return null }
  }
  const repo = read(opts.repoEnvFile)
  if (repo) for (const [k, v] of Object.entries(repo)) { if (preserve && env[k] !== undefined) continue; env[k] = v; applied.push(k) }
  const hermes = read(opts.hermesEnvFile)
  if (hermes) {
    for (const [k, v] of Object.entries(hermes)) {
      if (PROTECTED_ENV_KEYS.has(k)) { opts.log?.(`[bootstrap] Warning: ignoring protected key ${k} in ${String(opts.hermesEnvFile)}; set it in the deployment environment instead`); continue }
      if (env[k] !== undefined) continue
      env[k] = v
      applied.push(k)
    }
  }
  return applied
}

/**
 * Startup order shared by the launcher, `serve`, and `ctl`: the checkout `.env`
 * first (it may define `HERMES_HOME`), then the Hermes home resolved from the
 * result, then `$HERMES_HOME/.env` as a fallback. One authoritative home.
 */
export function loadStartupEnv(opts: { env: Record<string, string | undefined>; webRoot: string; home: string; log?: (line: string) => void }): { hermesHome: string } {
  loadLauncherDotenv({ env: opts.env, repoEnvFile: join(opts.webRoot, '.env'), hermesEnvFile: null, ...(opts.log ? { log: opts.log } : {}) })
  const hermesHome = resolve((opts.env.HERMES_HOME ?? '').trim().replace(/^~(?=$|\/)/, opts.home) || join(opts.home, '.hermes'))
  const fromHome = loadLauncherDotenv({ env: opts.env, repoEnvFile: null, hermesEnvFile: join(hermesHome, '.env'), ...(opts.log ? { log: opts.log } : {}) })
  // Values that came from the default profile's own `.env` are that profile's credentials, not process-wide ones. The
  // supervisor worker inherits both the values and this marker, so a second load must keep what the first recorded.
  opts.env[HOME_DOTENV_KEYS_VAR] = [...new Set([...homeDotenvKeys(opts.env), ...fromHome])].join(',')
  return { hermesHome }
}

/** Names of the variables `loadStartupEnv` copied from `$HERMES_HOME/.env` (the default profile's file). */
export const HOME_DOTENV_KEYS_VAR = 'HERMES_WEBUI_HOME_DOTENV_KEYS'

export function homeDotenvKeys(env: Record<string, string | undefined>): Set<string> {
  return new Set((env[HOME_DOTENV_KEYS_VAR] ?? '').split(',').map((k) => k.trim()).filter(Boolean))
}

/** Forget that `name` came from the default profile's `.env` (it was removed or replaced there at runtime). */
export function setHomeDotenvKeys(env: Record<string, string | undefined>, keys: Set<string>): void {
  env[HOME_DOTENV_KEYS_VAR] = [...keys].join(',')
}
