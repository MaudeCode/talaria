/**
 * Background MCP server health probes (Python `api/mcp_health.py`): demand
 * driven, fingerprint keyed, at most four in flight, eight seconds each, one
 * probe per server identity per 120 s. `unknown` is never treated as healthy.
 */
import { readCapped } from '../http/capped.js'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { str } from '../util.js'

type Dict = Record<string, unknown>
export const HEALTH_INTERVAL_S = 120
export const PROBE_TIMEOUT_MS = 8000
const PROBE_BODY_LIMIT_BYTES = 64 * 1024
const MAX_CONCURRENT_PROBES = 4
const MAX_PROBE_BODY_BYTES = 64 * 1024
const AUTH_STATUSES = new Set([401, 403, 407])
const PROTOCOL_MISMATCH_STATUSES = new Set([404, 405, 406, 415])
const PROTOCOL_VERSION_RE = /\d{4}-\d{2}-\d{2}/
const INITIALIZE_REQUEST = { jsonrpc: '2.0', id: 'hermes-webui-health', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes-webui-health', version: '1' } } }

export type Health = 'healthy' | 'needs_auth' | 'unhealthy' | 'unknown'
export interface HealthRow { health?: Health; detail?: string; checked_at?: number; pending: boolean }

function jsonRpcFromBody(raw: string): Dict | null {
  const text = raw.slice(0, MAX_PROBE_BODY_BYTES).trim()
  if (!text) return null
  const parse = (s: string): Dict | null => { try { const v: unknown = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : null } catch { return null } }
  const direct = parse(text)
  if (direct) return direct
  // SSE: the reply is the first `data:` payload of an event block.
  for (const block of text.split(/(?:\r\n|\r|\n){2}/)) {
    const data = block.split(/\r\n|\r|\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
    if (!data) continue
    const parsed = parse(data)
    if (parsed) return parsed
  }
  return null
}

function initializeResult(payload: Dict | null): Dict | null {
  const result = payload?.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const r = result as Dict
  return typeof r.protocolVersion === 'string' && PROTOCOL_VERSION_RE.test(r.protocolVersion) ? r : null
}

function statusResult(code: number, payload: Dict | null): [Health, string] {
  if (code >= 200 && code < 300) {
    if (initializeResult(payload)) return ['healthy', `HTTP ${String(code)}`]
    const error = payload?.error
    if (error && typeof error === 'object') return ['unhealthy', `initialize rejected: ${str((error as Dict).message) || 'error'}`]
    return ['unknown', 'unexpected initialize reply']
  }
  if (AUTH_STATUSES.has(code)) return ['needs_auth', `HTTP ${String(code)}`]
  if (PROTOCOL_MISMATCH_STATUSES.has(code)) return ['unknown', `HTTP ${String(code)} (protocol mismatch)`]
  return ['unhealthy', `HTTP ${String(code)}`]
}

async function probeHttp(url: string, cfg: Dict, fetchImpl: typeof fetch): Promise<[Health, string]> {
  let scheme = ''
  try { scheme = new URL(url).protocol } catch { return ['unhealthy', 'unsupported url scheme'] }
  if (scheme !== 'http:' && scheme !== 'https:') return ['unhealthy', 'unsupported url scheme']
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (cfg.headers && typeof cfg.headers === 'object') for (const [k, v] of Object.entries(cfg.headers as Dict)) if (typeof v === 'string') headers[k] = v
  const deadline = Date.now() + PROBE_TIMEOUT_MS
  let sessionId: string | null = null
  let protocolVersion: string | null = null
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(INITIALIZE_REQUEST), redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    sessionId = res.headers.get('mcp-session-id')
    let payload: Dict | null = null
    if (res.ok) {
      const remaining = deadline - Date.now()
      const text = await Promise.race([readCapped(res, PROBE_BODY_LIMIT_BYTES).then((b) => (b ? b.toString('utf8') : '')), new Promise<string>((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, Math.max(1, remaining)).unref() })]).catch(() => '')
      payload = jsonRpcFromBody(text)
      protocolVersion = str(initializeResult(payload)?.protocolVersion) || null
    }
    return statusResult(res.status, payload)
  } catch (error) {
    return ['unhealthy', (error as Error).name === 'TimeoutError' ? 'timeout' : (error as Error).message || 'transport error']
  } finally {
    if (sessionId) {
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        const terminate = { ...headers, 'Mcp-Session-Id': sessionId, ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) }
        try { await fetchImpl(url, { method: 'DELETE', headers: terminate, signal: AbortSignal.timeout(remaining) }) } catch { /* best effort */ }
      }
    }
  }
}

function commandExists(command: string, env: unknown): boolean {
  if (isAbsolute(command) || command.includes('/')) { try { accessSync(command, fsConstants.X_OK); return true } catch { return false } }
  const path = env && typeof env === 'object' && typeof (env as Dict).PATH === 'string' ? (env as Dict).PATH as string : process.env.PATH ?? ''
  for (const dir of path.split(delimiter).filter(Boolean)) { try { accessSync(join(dir, command), fsConstants.X_OK); return true } catch { /* next */ } }
  return false
}

export async function probeServer(cfg: unknown, fetchImpl: typeof fetch): Promise<[Health, string]> {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['unhealthy', 'invalid config']
  const c = cfg as Dict
  const url = str(c.url).trim()
  if (url) return probeHttp(url, c, fetchImpl)
  const command = str(c.command).trim()
  if (command) return commandExists(command, c.env) ? ['unknown', 'stdio server not probed'] : ['unhealthy', `command not found: ${command.split('/').pop() ?? command}`]
  return ['unhealthy', 'invalid config']
}

export function configFingerprint(cfg: unknown): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value as Dict).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Dict)[k])}`).join(',')}}`
    return JSON.stringify(value ?? null) ?? 'null'
  }
  return createHash('sha256').update(canonical(cfg)).digest('hex').slice(0, 16)
}

export class McpHealthProber {
  private readonly state = new Map<string, { health: Health; detail: string; checked_at: number }>()
  private readonly inFlight = new Set<string>()
  private readonly startedAt = new Map<string, number>()
  constructor(private readonly deps: { fetch: () => typeof fetch; now: () => number; log: (line: string) => void }) {}

  /** Python `refresh_and_read`: schedule due probes and read back the verdicts for these exact configs. */
  refreshAndRead(servers: Dict): Record<string, HealthRow> {
    const now = this.deps.now()
    const current = new Map(Object.entries(servers).map(([name, cfg]) => [name, configFingerprint(cfg)]))
    for (const key of [...this.startedAt.keys()]) {
      const [name, fp] = key.split('\n') as [string, string]
      if (now - (this.startedAt.get(key) ?? 0) >= HEALTH_INTERVAL_S && current.get(name) !== fp) { this.startedAt.delete(key); this.state.delete(key) }
    }
    const due: [string, unknown, string][] = []
    for (const [name, fp] of current) {
      const key = `${name}\n${fp}`
      if (this.inFlight.has(key)) continue
      const started = this.startedAt.get(key)
      if (started !== undefined && now - started < HEALTH_INTERVAL_S) continue
      if (this.inFlight.size >= MAX_CONCURRENT_PROBES) continue
      this.inFlight.add(key)
      this.startedAt.set(key, now)
      due.push([name, servers[name], key])
    }
    const readable: Record<string, HealthRow> = {}
    for (const [name, fp] of current) {
      const key = `${name}\n${fp}`
      const started = this.startedAt.get(key)
      readable[name] = { ...(this.state.get(key) ?? {}), pending: this.inFlight.has(key) || started === undefined || now - started >= HEALTH_INTERVAL_S }
    }
    for (const [, cfg, key] of due) {
      void probeServer(cfg, this.deps.fetch()).catch((): [Health, string] => ['unknown', 'health check failed']).then(([health, detail]) => {
        this.state.set(key, { health, detail, checked_at: this.deps.now() })
      }).finally(() => { this.inFlight.delete(key) })
    }
    return readable
  }

  /** Resolve once every in-flight probe has settled (tests). */
  async settle(): Promise<void> {
    while (this.inFlight.size) await new Promise((r) => setTimeout(r, 10))
  }
}
