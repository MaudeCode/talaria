/** Health, gateway status, logs, dashboard probe and link settings, and diagnostics (Python `api/agent_health.py`, `api/system_health.py`, `api/dashboard_probe.py`, `_handle_logs`). */
import { readCapped } from '../http/capped.js'
import { constants, existsSync, fstatSync, openSync, readSync, readFileSync, closeSync, statSync, statfsSync } from 'node:fs'
import { cpus, loadavg, freemem, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { GatewayStatus } from '@maudecode/talaria-web-contracts'
import type { Config, Dict } from '../config/agent-config.js'
import { dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { str } from '../util.js'

const LOG_FILES: Record<string, string> = { agent: 'agent.log', errors: 'errors.log', gateway: 'gateway.log' }
const LOG_TAILS = new Set([100, 200, 500, 1000])
const LOG_MAX_BYTES = 4 * 1024 * 1024

// Opening with O_NOFOLLOW refuses a symlinked log atomically; O_NONBLOCK keeps a FIFO in its place from blocking the open.
const LOG_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export function readLogTail(profileHome: string, fileKeyRaw: unknown, tailRaw: unknown): Dict {
  const fileKey = (str(fileKeyRaw ?? 'agent').trim().toLowerCase()) || 'agent'
  const filename = LOG_FILES[fileKey]
  if (!filename) throw new HttpFailure(400, 'Unknown log file')
  const parsedTail = Number.parseInt(str(tailRaw).trim(), 10)
  const tail = LOG_TAILS.has(parsedTail) ? parsedTail : 200
  const logDir = resolve(profileHome, 'logs')
  const path = resolve(logDir, filename)
  const notFound = { file: fileKey, tail, lines: [], truncated: false, total_bytes: 0, mtime: null, hint: `Log file for ${fileKey} not found yet.` }
  let fd: number
  try { fd = openSync(path, LOG_OPEN_FLAGS) } catch (error) {
    // Python `_handle_logs` refused a log resolving outside the logs dir; refusing every symlink makes the open itself the check.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new HttpFailure(400, 'Invalid log file')
    return notFound
  }
  let st: ReturnType<typeof fstatSync>
  let buffer: Buffer
  try {
    st = fstatSync(fd)
    if (!st.isFile()) return notFound
    const readBytes = Math.min(st.size, LOG_MAX_BYTES)
    buffer = Buffer.alloc(readBytes)
    readSync(fd, buffer, 0, readBytes, st.size - readBytes)
  } finally { closeSync(fd) }
  const total = st.size
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return { file: fileKey, tail, lines: lines.slice(-tail), truncated: total > buffer.length, total_bytes: total, mtime: st.mtimeMs / 1000, hint: '' }
}

const checkedAt = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v * 10) / 10))

/** Python `build_system_health_payload` with Node primitives (loadavg-based CPU, statfs on the home volume). */
export function systemHealth(home: string, runtime: Dict): Dict {
  const errors: { metric: string; code: string }[] = []
  let cpu: Dict | null = null
  let memory: Dict | null = null
  let disk: Dict | null = null
  try {
    const cores = Math.max(1, cpus().length)
    cpu = { percent: clamp(((loadavg()[0] ?? 0) / cores) * 100) }
  } catch { errors.push({ metric: 'cpu', code: 'cpu_unavailable' }) }
  try {
    const total = totalmem()
    const used = total - freemem()
    memory = { used_bytes: used, total_bytes: total, percent: clamp((used / total) * 100) }
  } catch { errors.push({ metric: 'memory', code: 'memory_unavailable' }) }
  try {
    const fs = statfsSync(home)
    const total = fs.blocks * fs.bsize
    const used = total - fs.bavail * fs.bsize
    if (total <= 0) throw new Error('disk_unavailable')
    disk = { used_bytes: used, total_bytes: total, percent: clamp((used / total) * 100) }
  } catch { errors.push({ metric: 'disk', code: 'disk_unavailable' }) }
  const available = cpu !== null || memory !== null || disk !== null
  return { status: available && !errors.length ? 'ok' : available ? 'partial' : 'unavailable', available, checked_at: checkedAt(), cpu, memory, disk, webui_runtime: runtime, errors }
}

const REMOTE_PROBE_TIMEOUT_MS = 2000
const REMOTE_PROBE_CACHE_TTL_S = 5
const REMOTE_PROBE_PATHS = ['/health/detailed', '/health', '/v1/health']
const REMOTE_PROBE_BODY_LIMIT_BYTES = 64 * 1024
const DASHBOARD_PROBE_BODY_LIMIT_BYTES = 64 * 1024
const GATEWAY_FRESHNESS_THRESHOLD_S = 120

export interface AgentHealthDeps {
  env: Record<string, string | undefined>
  /** Root Hermes home (gateway runtime files are root-level singletons) and the active profile home fallback. */
  hermesHome: string
  profileHome: () => string
  fetch: () => typeof fetch
  now: () => number
}

/** Python `_remote_gateway_base_url`: an explicit remote gateway wins over local signals; health-path suffixes are stripped. */
export function remoteGatewayBaseUrl(env: Record<string, string | undefined>): string | null {
  for (const name of ['GATEWAY_HEALTH_URL', 'HERMES_GATEWAY_HEALTH_URL', 'HERMES_API_URL', 'HERMES_WEBUI_GATEWAY_BASE_URL']) {
    const value = (env[name] ?? '').trim()
    if (!value) continue
    let base = value.replace(/\/+$/, '')
    for (const suffix of ['/health/detailed', '/health', '/v1/health', '/status']) if (base.endsWith(suffix)) { base = base.slice(0, -suffix.length).replace(/\/+$/, ''); break }
    return base
  }
  return null
}

function ageSeconds(status: Dict | null, state: string, now: number): number | null {
  if (status?.gateway_state !== state) return null
  const raw = status.updated_at
  if (typeof raw !== 'string' || !raw) return null
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return null // naive timestamps are refused, as in Python
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return null
  return now - t / 1000
}

export function runtimeStatusIsFresh(status: Dict | null, now: number): boolean {
  const age = ageSeconds(status, 'running', now)
  if (age === null) return false
  return age < 0 ? -age <= GATEWAY_FRESHNESS_THRESHOLD_S : age <= GATEWAY_FRESHNESS_THRESHOLD_S
}

function runtimeDetailSubset(status: Dict | null): Dict {
  if (!status) return {}
  const details: Dict = {}
  if (typeof status.gateway_state === 'string' && status.gateway_state) details.gateway_state = status.gateway_state
  if (typeof status.updated_at === 'string' && status.updated_at) details.updated_at = status.updated_at
  const agents = Number(status.active_agents ?? 0)
  if (Number.isFinite(agents)) details.active_agents = Math.max(0, Math.trunc(agents))
  if (typeof status.platforms === 'object' && status.platforms !== null && !Array.isArray(status.platforms)) {
    const platforms = status.platforms as Dict
    details.platform_count = Object.keys(platforms).length
    const states: Record<string, number> = {}
    for (const payload of Object.values(platforms)) { const state = (payload as Dict | null)?.state; if (typeof state === 'string' && state) states[state] = (states[state] ?? 0) + 1 }
    if (Object.keys(states).length) details.platform_states = states
  }
  return details
}

function readJsonFile(path: string): Dict | null {
  try { const v: unknown = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : null } catch { return null }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

const remoteCache = new Map<string, { until: number; result: Dict; inflight: Promise<Dict> | null }>()

async function runRemoteProbe(base: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<Dict> {
  const apiKey = (env.HERMES_WEBUI_GATEWAY_API_KEY ?? env.API_SERVER_KEY ?? '').trim()
  let lastStatus: number | null = null
  let lastError: string | null = null
  for (const path of REMOTE_PROBE_PATHS) {
    const headers: Record<string, string> = path === '/health/detailed' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    try {
      const res = await fetchImpl(base + path, { headers, signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) })
      if (res.ok) {
        const details: Dict = { state: 'alive', reason: 'remote_gateway', endpoint: base + path, status_code: res.status }
        const body = ((await readCapped(res, REMOTE_PROBE_BODY_LIMIT_BYTES).catch(() => null)) ?? null)?.toString('utf8') ?? null
        if (body !== null) { try { const data: unknown = JSON.parse(body); if (data && typeof data === 'object' && 'gateway_state' in data) details.gateway_state = (data as Dict).gateway_state } catch { /* not json */ } }
        return { alive: true, checked_at: checkedAt(), details }
      }
      lastStatus = res.status
    } catch (error) { lastError = (error as Error).name || 'Error' }
  }
  const details: Dict = { state: 'down', reason: 'remote_gateway_unreachable', endpoint: base }
  if (lastStatus !== null) details.status_code = lastStatus
  if (lastError !== null) details.error = lastError
  return { alive: false, checked_at: checkedAt(), details }
}

/** Python `build_agent_health_payload` + `gateway_chat_config_status`: remote probe (5 s single-flight cache) else local pid/state files. */
export async function agentHealth(deps: AgentHealthDeps): Promise<Dict> {
  const { env } = deps
  const mode = (env.HERMES_WEBUI_CHAT_BACKEND ?? '').trim().toLowerCase() === 'gateway' ? 'gateway' : 'local'
  const gatewayChat = { enabled: mode === 'gateway', backend: mode, base_url_configured: Boolean((env.HERMES_WEBUI_GATEWAY_BASE_URL ?? '').trim()), api_key_configured: Boolean((env.HERMES_WEBUI_GATEWAY_API_KEY ?? '').trim()) }
  const remote = remoteGatewayBaseUrl(env)
  if (remote !== null) {
    const now = deps.now()
    let entry = remoteCache.get(remote)
    if (entry && entry.until > now && !entry.inflight) return { ...entry.result, checked_at: checkedAt(), gateway_chat: gatewayChat }
    if (!entry?.inflight) {
      const inflight = runRemoteProbe(remote, env, deps.fetch()).then((result) => { remoteCache.set(remote, { until: deps.now() + REMOTE_PROBE_CACHE_TTL_S, result, inflight: null }); return result })
      entry = { until: 0, result: {}, inflight }
      remoteCache.set(remote, entry)
    }
    return { ...(await entry.inflight!), gateway_chat: gatewayChat }
  }
  const rootPid = join(deps.hermesHome, 'gateway.pid')
  const pidPath = existsSync(rootPid) ? rootPid : existsSync(join(deps.profileHome(), 'gateway.pid')) ? join(deps.profileHome(), 'gateway.pid') : rootPid
  const statusPath = join(dirname(pidPath), 'gateway_state.json')
  const runtimeStatus = readJsonFile(statusPath)
  const safe = runtimeDetailSubset(runtimeStatus)
  const checked = checkedAt()
  let runningPid: number | null = null
  try { const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10); if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) runningPid = pid } catch { runningPid = null }
  const now = deps.now()
  if (runningPid !== null) return { alive: true, checked_at: checked, details: { state: 'alive', ...safe }, gateway_chat: gatewayChat }
  if (runtimeStatusIsFresh(runtimeStatus, now)) return { alive: true, checked_at: checked, details: { state: 'alive', reason: 'cross_container_freshness', ...safe }, gateway_chat: gatewayChat }
  const stoppedAge = ageSeconds(runtimeStatus, 'stopped', now)
  if (stoppedAge !== null && stoppedAge > GATEWAY_FRESHNESS_THRESHOLD_S) return { alive: null, checked_at: checked, details: { state: 'unknown', reason: 'gateway_stale_stopped_state', ...safe }, gateway_chat: gatewayChat }
  const runningAge = ageSeconds(runtimeStatus, 'running', now)
  if (runningAge !== null && runningAge > GATEWAY_FRESHNESS_THRESHOLD_S) return { alive: null, checked_at: checked, details: { state: 'unknown', reason: 'gateway_stale_running_state', ...safe }, gateway_chat: gatewayChat }
  if (runtimeStatus) return { alive: false, checked_at: checked, details: { state: 'down', reason: 'gateway_not_running', ...safe }, gateway_chat: gatewayChat }
  return { alive: null, checked_at: checked, details: { state: 'unknown', reason: 'gateway_not_configured' }, gateway_chat: gatewayChat }
}

const PLATFORM_LABELS: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', email: 'Email', web: 'Web', api: 'API' }
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const titleCase = (name: string): string => name.replace(/(^|[^a-z])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase())

/**
 * Python `_gateway_status_payload`: `health` (`agentHealth`) decides running and configured; when it is inconclusive
 * (`alive` null), stale running metadata or any known gateway session marks the gateway configured, and sessions mean running.
 */
export function gatewayStatus(health: Dict, identity: ReadonlyMap<string, { raw_source: string; platform: string }>, sessionsPath: string): GatewayStatus {
  const details = dict(health.details)
  const state = textOrNull(details.state)
  const reason = textOrNull(details.reason)
  const gatewayState = textOrNull(details.gateway_state)
  const hasSessions = identity.size > 0
  const running = health.alive === true || (health.alive !== false && hasSessions)
  const configured = health.alive === true || health.alive === false || reason === 'gateway_stale_running_state' || gatewayState === 'running' || hasSessions
  const names = new Set<string>()
  for (const meta of identity.values()) {
    const name = (meta.raw_source || meta.platform).trim().toLowerCase()
    if (name) names.add(name)
  }
  const platforms = [...names].map((name) => ({ name, label: PLATFORM_LABELS[name] ?? titleCase(name) })).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  let lastActive = ''
  if (running) { try { lastActive = statSync(sessionsPath).mtime.toISOString() } catch { lastActive = '' } }
  return { running, configured, platforms, last_active: lastActive, session_count: identity.size, health: { state, reason, gateway_state: gatewayState } }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const DASHBOARD_PORT = 9119

function baseUrl(host: string, port: number, scheme = 'http'): string {
  const display = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${scheme}://${display}:${String(port)}`
}

function normalizeDashboardUrl(raw: string): [string, number, string, string] | null {
  const value = raw.trim()
  if (!value) return null
  const u = new URL(value)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error('invalid dashboard url')
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!LOOPBACK.has(host)) throw new Error('dashboard url must be loopback')
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  const scheme = u.protocol.replace(':', '')
  return [host, port, scheme, baseUrl(host, port, scheme)]
}

/** Python `normalize_dashboard_browser_url`: an http(s) origin with no credentials, path, query, or fragment; 400 otherwise. */
export function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  let u: URL
  try { u = new URL(value) } catch { throw new HttpFailure(400, 'invalid dashboard URL') }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpFailure(400, 'invalid dashboard URL scheme')
  if (u.username || u.password) throw new HttpFailure(400, 'invalid dashboard URL credentials')
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new HttpFailure(400, 'invalid dashboard URL path')
  return `${u.protocol}//${u.host}`
}

const DASHBOARD_MODES = ['auto', 'always', 'never'] as const
type DashboardMode = (typeof DASHBOARD_MODES)[number]

/** Python `str(value or "auto").strip().lower()` checked against the known modes; null for anything else. */
function dashboardMode(raw: unknown): DashboardMode | null {
  const mode = (raw ? str(raw) : 'auto').trim().toLowerCase()
  return (DASHBOARD_MODES as readonly string[]).includes(mode) ? (mode as DashboardMode) : null
}

/** The configured dashboard link: `url`, else the legacy `target`. */
const dashboardLink = (cfg: Dict): string => str(cfg.url ?? cfg.target)

/** Python `get_dashboard_config`: the profile's `webui.dashboard` link settings; 400 for an invalid stored URL. */
export function dashboardConfig(config: Config): { enabled: DashboardMode; url: string } {
  const cfg = dict(dict(config.webui).dashboard)
  return { enabled: dashboardMode(cfg.enabled) ?? 'auto', url: normalizeBrowserUrl(dashboardLink(cfg)) }
}

/** Python `save_dashboard_config` validation: 400 for an unknown mode or an unsafe URL; an empty URL clears it. */
export function parseDashboardConfig(body: { enabled?: unknown; url?: unknown }): { enabled: DashboardMode; url: string } {
  const enabled = dashboardMode(body.enabled)
  if (!enabled) throw new HttpFailure(400, 'invalid dashboard enabled mode')
  return { enabled, url: normalizeBrowserUrl(body.url ? str(body.url) : '') }
}

/** Writes `next` to `webui.dashboard` in place, replacing a non-object `webui` or `dashboard`. */
export function applyDashboardConfig(config: Config, next: { enabled: DashboardMode; url: string }): void {
  if (!config.webui || typeof config.webui !== 'object' || Array.isArray(config.webui)) config.webui = {}
  const webui = config.webui as Dict
  if (!webui.dashboard || typeof webui.dashboard !== 'object' || Array.isArray(webui.dashboard)) webui.dashboard = {}
  const dashboard = webui.dashboard as Dict
  dashboard.enabled = next.enabled
  // `url` replaces the legacy `target`, so clearing the URL clears the link.
  Reflect.deleteProperty(dashboard, 'target')
  if (next.url) dashboard.url = next.url
  else Reflect.deleteProperty(dashboard, 'url')
}

/** Python `get_dashboard_status`: probe `hermes dashboard` on loopback only. */
export async function dashboardStatus(config: Config, env: Record<string, string | undefined>, f: typeof fetch = fetch): Promise<Dict> {
  const cfg = dict(dict(config.webui).dashboard)
  const enabled = dashboardMode(cfg.enabled) ?? 'auto'
  if (enabled === 'never') return { running: false, enabled: 'never' }
  const raw = dashboardLink(cfg)
  let browserUrl = ''
  try { browserUrl = raw ? normalizeBrowserUrl(raw) : '' } catch { return { running: false, enabled, error: 'invalid dashboard url' } }
  let override: [string, number, string, string] | null = null
  try { override = normalizeDashboardUrl(raw) } catch { override = null }
  const targets: [string, number, string, string][] = override ? [override] : [['127.0.0.1', DASHBOARD_PORT, 'http', baseUrl('127.0.0.1', DASHBOARD_PORT)], ['localhost', DASHBOARD_PORT, 'http', baseUrl('localhost', DASHBOARD_PORT)]]
  if (enabled === 'always') {
    if (browserUrl && !override) return { running: true, enabled, url: browserUrl, browser_url: browserUrl }
    const [host, port, , base] = targets[0] ?? ['127.0.0.1', DASHBOARD_PORT, 'http', baseUrl('127.0.0.1', DASHBOARD_PORT)]
    return { running: true, enabled, host, port, url: browserUrl || base, browser_url: browserUrl || base }
  }
  const bindHost = (env.HERMES_WEBUI_HOST ?? '127.0.0.1').trim().toLowerCase().replace(/[[\]]/g, '')
  if (!LOOPBACK.has(bindHost)) return { running: false, enabled }
  for (const [host, port, , base] of targets) {
    try {
      const res = await f(`${base}/api/status`, { headers: { Accept: 'application/json', 'User-Agent': 'hermes-webui-dashboard-probe' }, signal: AbortSignal.timeout(500) })
      if (res.status !== 200) continue
      const raw = await readCapped(res, DASHBOARD_PROBE_BODY_LIMIT_BYTES).catch(() => null)
      if (!raw) continue
      let payload: unknown
      try { payload = JSON.parse(raw.toString('utf8')) } catch { continue }
      const p = dict(payload)
      if (!(typeof p.version === 'string' || p.hermes === true || str(p.app).toLowerCase().includes('hermes'))) continue
      const result: Dict = { running: true, enabled, host, port, url: browserUrl || base, browser_url: browserUrl || base }
      if (typeof p.version === 'string' && p.version.trim()) result.version = p.version.trim()
      return result
    } catch { /* next target */ }
  }
  return { running: false, enabled }
}

export const LOG_FILE_KEYS = Object.keys(LOG_FILES)
export const logPath = (profileHome: string, key: string): string => join(profileHome, 'logs', LOG_FILES[key] ?? '')
