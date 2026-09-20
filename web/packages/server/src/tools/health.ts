/** Health, logs, dashboard probe, updates, and diagnostics (Python `api/agent_health.py`, `api/system_health.py`, `api/dashboard_probe.py`, `_handle_logs`, `api/updates.py`). */
import { existsSync, openSync, readSync, closeSync, statSync, statfsSync } from 'node:fs'
import { cpus, loadavg, freemem, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import type { Config, Dict } from '../config/agent-config.js'
import { dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { str } from '../util.js'

const LOG_FILES: Record<string, string> = { agent: 'agent.log', errors: 'errors.log', gateway: 'gateway.log' }
const LOG_TAILS = new Set([100, 200, 500, 1000])
const LOG_MAX_BYTES = 4 * 1024 * 1024

export function readLogTail(profileHome: string, fileKeyRaw: unknown, tailRaw: unknown): Dict {
  const fileKey = (str(fileKeyRaw ?? 'agent').trim().toLowerCase()) || 'agent'
  const filename = LOG_FILES[fileKey]
  if (!filename) throw new HttpFailure(400, 'Unknown log file')
  const parsedTail = Number.parseInt(str(tailRaw).trim(), 10)
  const tail = LOG_TAILS.has(parsedTail) ? parsedTail : 200
  const logDir = resolve(profileHome, 'logs')
  const path = resolve(logDir, filename)
  if (!existsSync(path) || !statSync(path).isFile()) return { file: fileKey, tail, lines: [], truncated: false, total_bytes: 0, mtime: null, hint: `Log file for ${fileKey} not found yet.` }
  const st = statSync(path)
  const total = st.size
  const readBytes = Math.min(total, LOG_MAX_BYTES)
  const buffer = Buffer.alloc(readBytes)
  const fd = openSync(path, 'r')
  try { readSync(fd, buffer, 0, readBytes, total - readBytes) } finally { closeSync(fd) }
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return { file: fileKey, tail, lines: lines.slice(-tail), truncated: total > readBytes, total_bytes: total, mtime: st.mtimeMs / 1000, hint: '' }
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

/** Python `build_agent_health_payload` + `gateway_chat_config_status`. ponytail: no gateway pid probing; the Agent gateway is reported unknown unless a remote base URL is configured. */
export function agentHealth(env: Record<string, string | undefined>): Dict {
  const mode = (env.HERMES_WEBUI_CHAT_BACKEND ?? '').trim().toLowerCase() === 'gateway' ? 'gateway' : 'local'
  const baseUrl = (env.HERMES_WEBUI_GATEWAY_BASE_URL ?? '').trim()
  return {
    alive: null,
    checked_at: checkedAt(),
    details: { state: 'unknown', reason: 'gateway_status_unavailable' },
    gateway_chat: { enabled: mode === 'gateway', backend: mode, base_url_configured: Boolean(baseUrl), api_key_configured: Boolean((env.HERMES_WEBUI_GATEWAY_API_KEY ?? '').trim()) },
  }
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

function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  const u = new URL(value)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error('invalid dashboard url')
  return `${u.protocol}//${u.host}`
}

/** Python `get_dashboard_status`: probe `hermes dashboard` on loopback only. */
export async function dashboardStatus(config: Config, env: Record<string, string | undefined>, f: typeof fetch = fetch): Promise<Dict> {
  const cfg = dict(dict(config.webui).dashboard)
  let enabled = str(cfg.enabled ?? 'auto').trim().toLowerCase() || 'auto'
  if (!['auto', 'always', 'never'].includes(enabled)) enabled = 'auto'
  if (enabled === 'never') return { running: false, enabled: 'never' }
  const raw = str(cfg.url ?? cfg.target)
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
      const payload = (await res.json())
      const p = dict(payload)
      if (!(typeof p.version === 'string' || p.hermes === true || str(p.app).toLowerCase().includes('hermes'))) continue
      const result: Dict = { running: true, enabled, host, port, url: browserUrl || base, browser_url: browserUrl || base }
      if (typeof p.version === 'string' && p.version.trim()) result.version = p.version.trim()
      return result
    } catch { /* next target */ }
  }
  return { running: false, enabled }
}

/** npm builds carry no git checkout to fast-forward; report the installed versions and defer to the package manager. */
export function updatesCheck(webuiVersion: string, agentVersion: string, includeAgent: boolean, channel: string): Dict {
  const target = (name: string, version: string): Dict => ({ name, behind: null, current_sha: null, latest_sha: null, current_version: version, manual_update: true, no_git: true })
  return { webui: target('webui', webuiVersion), agent: includeAgent ? target('agent', agentVersion) : { name: 'agent', behind: 0, current_sha: null, latest_sha: null, manual_update: true, no_git: true, ignored: true }, checked_at: Date.now() / 1000, include_agent: includeAgent, channel, cached: false }
}

/** Python `summarize_update_payload` deterministic fallback (no LLM callback). */
export function summarizeUpdates(updates: Dict, target: string | null): Dict {
  const details: Dict[] = []
  for (const [key, label] of [['webui', 'WebUI'], ['agent', 'Agent']] as const) {
    if (target && key !== target) continue
    const info = dict(updates[key])
    const behind = Number.parseInt(str(info.behind ?? 0), 10) || 0
    if (behind <= 0) continue
    details.push({ name: key, label, behind, current_sha: info.current_sha ?? null, latest_sha: info.latest_sha ?? null, compare_url: info.compare_url ?? null, commits: [], commits_limit: 24, commits_truncated: false })
  }
  const notice = details.length ? details.map((d) => `${str(d.label)} has ${String(d.behind)} update${Number(d.behind) === 1 ? '' : 's'} available.`) : ['Everything is up to date.']
  const sections = [{ title: "What you'll notice", items: notice }]
  const summary = sections.map((s) => [s.title, ...s.items.map((i) => `- ${i}`), ''].join('\n')).join('\n').trim()
  return { ok: true, summary, summary_sections: sections, generated_by: 'fallback', cached: false, target: target ?? null, targets: details }
}

export const LOG_FILE_KEYS = Object.keys(LOG_FILES)
export const logPath = (profileHome: string, key: string): string => join(profileHome, 'logs', LOG_FILES[key] ?? '')
