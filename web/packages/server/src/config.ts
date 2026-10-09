/**
 * Process configuration from the environment (Python `api/config.py`
 * HOST/PORT/TLS/STATE_DIR block). Everything is a plain value computed once at
 * startup so tests can build a config for a temp directory without touching
 * `process.env`.
 */
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export type Env = Record<string, string | undefined>

export interface ServerConfig {
  host: string
  port: number
  tlsCert: string | null
  tlsKey: string | null
  hermesHome: string
  stateDir: string
  sessionDir: string
  settingsFile: string
  /** `web/` checkout or npm package root that owns `static/`. */
  webRoot: string
  staticRoot: string
  distRoot: string
  defaultWorkspace: string
  maxUploadBytes: number
  /** Total bytes one archive upload may extract (zip/tar-bomb guard). */
  maxExtractedBytes: number
  botName: string
  env: Env
  /** The user's home directory (tests pass a temp dir). */
  homeDir: string
}

export function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

export function platformDefaultHermesHome(env: Env, home = homedir()): string {
  if (process.platform === 'win32') {
    const localAppData = (env.LOCALAPPDATA ?? '').trim()
    if (localAppData) {
      const next = resolve(localAppData, 'hermes')
      const legacy = resolve(home, '.hermes')
      if (existsSync(resolve(legacy, 'webui')) && !existsSync(resolve(next, 'webui'))) return legacy
      return next
    }
  }
  return resolve(home, '.hermes')
}

function envMbBytes(raw: string | undefined, defaultMb: number, warn: (line: string) => void, name: string): number {
  const value = (raw ?? '').trim()
  if (!value) return defaultMb * 1024 * 1024
  const m = /^(\d+)\s*(?:m|mb|mib)?$/i.exec(value)
  const mb = m ? Number(m[1]) : 0
  if (!m || mb <= 0) {
    warn(`Invalid ${name}=${JSON.stringify(value)}; expected a positive integer in MB. Falling back to ${defaultMb}MB.`)
    return defaultMb * 1024 * 1024
  }
  return mb * 1024 * 1024
}

function ensureWorkspaceDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Ordered workspace candidates: explicit, env, ~/workspace, ~/work, STATE_DIR/workspace (Python `_workspace_candidates`). */
export function resolveDefaultWorkspace(raw: string | null | undefined, opts: { env: Env; stateDir: string; home?: string }): string {
  const home = opts.home ?? homedir()
  const candidates: string[] = []
  const add = (candidate: string | null | undefined) => {
    if (!candidate) return
    const path = resolve(candidate.replace(/^~(?=$|\/)/, home))
    if (!candidates.includes(path)) candidates.push(path)
  }
  add(raw)
  add(opts.env.HERMES_WEBUI_DEFAULT_WORKSPACE)
  const homeWorkspace = resolve(home, 'workspace')
  const homeWork = resolve(home, 'work')
  if (existsSync(homeWorkspace)) add(homeWorkspace)
  if (existsSync(homeWork)) add(homeWork)
  add(homeWorkspace)
  add(resolve(opts.stateDir, 'workspace'))
  for (const candidate of candidates) if (ensureWorkspaceDir(candidate)) return candidate
  throw new Error('Could not create or access any usable workspace directory. Set HERMES_WEBUI_DEFAULT_WORKSPACE to a writable path.')
}

export interface LoadConfigOptions {
  env?: Env
  webRoot: string
  home?: string
  warn?: (line: string) => void
}

export function loadConfig(opts: LoadConfigOptions): ServerConfig {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const warn = opts.warn ?? ((line) => { console.error(`[webui] WARNING: ${line}`) })
  const hermesHome = resolve((env.HERMES_HOME ?? '').trim().replace(/^~(?=$|\/)/, home) || platformDefaultHermesHome(env, home))
  const stateDir = resolve((env.HERMES_WEBUI_STATE_DIR ?? '').trim().replace(/^~(?=$|\/)/, home) || resolve(hermesHome, 'webui'))
  const port = Number.parseInt(env.HERMES_WEBUI_PORT ?? '8787', 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid HERMES_WEBUI_PORT=${JSON.stringify(env.HERMES_WEBUI_PORT)}`)
  const staticRoot = resolve(opts.webRoot, 'static')
  const maxUploadBytes = envMbBytes(env.HERMES_WEBUI_MAX_UPLOAD_MB, 20, warn, 'HERMES_WEBUI_MAX_UPLOAD_MB')
  // Python `_max_extracted_bytes`: a positive (fractional) MB value, else ten times the upload cap.
  const extractedMb = Number((env.HERMES_WEBUI_MAX_EXTRACTED_MB ?? '').trim() || Number.NaN)
  return {
    host: env.HERMES_WEBUI_HOST ?? '127.0.0.1',
    port,
    tlsCert: (env.HERMES_WEBUI_TLS_CERT ?? '').trim() || null,
    tlsKey: (env.HERMES_WEBUI_TLS_KEY ?? '').trim() || null,
    hermesHome,
    stateDir,
    sessionDir: resolve(stateDir, 'sessions'),
    settingsFile: resolve(stateDir, 'settings.json'),
    webRoot: opts.webRoot,
    staticRoot,
    distRoot: resolve(staticRoot, 'dist'),
    defaultWorkspace: resolveDefaultWorkspace(null, { env, stateDir, home }),
    maxUploadBytes,
    maxExtractedBytes: Number.isFinite(extractedMb) && extractedMb > 0 ? Math.floor(extractedMb * 1024 * 1024) : 10 * maxUploadBytes,
    botName: env.HERMES_WEBUI_BOT_NAME ?? 'Hermes',
    homeDir: home,
    env,
  }
}
