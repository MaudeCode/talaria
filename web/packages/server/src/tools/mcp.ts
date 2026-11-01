/** MCP server inventory from config.yaml plus the Agent's already-known runtime status and the background health verdicts (Python MCP handlers). */
import { createHash } from 'node:crypto'
import { McpCostPatchSchema, type McpEventsSchema, type SidecarResult } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import type { SidecarLike } from '../sidecar/client.js'
import { dict, isDict, type AgentConfig, type Config, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { readCapped } from '../http/capped.js'
import { redactString } from '../redact.js'
import { str } from '../util.js'
import type { McpHealthProber } from './mcp-health.js'

const MASK = '••••••'
const SENSITIVE = ['auth', 'token', 'key', 'secret', 'password', 'credential']
const STDIO_LIFECYCLE_KEYS = ['idle_timeout_seconds', 'max_lifetime_seconds']

export function maskSecrets(obj: unknown): unknown {
  if (!isDict(obj)) return obj
  const out: Dict = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && SENSITIVE.some((s) => k.toLowerCase().includes(s))) out[k] = MASK
    else if (isDict(v)) out[k] = maskSecrets(v)
    else out[k] = v
  }
  return out
}

function stripMasked(submitted: unknown, existing: unknown): unknown {
  if (!isDict(submitted) || !isDict(existing)) return submitted
  const out: Dict = {}
  for (const [k, v] of Object.entries(submitted)) {
    if (v === MASK && typeof existing[k] === 'string') out[k] = existing[k]
    else if (isDict(v) && isDict(existing[k])) out[k] = stripMasked(v, existing[k])
    else out[k] = v
  }
  return out
}

/** Native `_parse_boolish`: `fallback` for an absent or unreadable value (`enabled` defaults on, `events` off). */
export function parseEnabled(value: unknown, fallback = true): boolean {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(n)) return true
    if (['false', '0', 'no', 'off'].includes(n)) return false
  }
  return fallback
}

type McpEvents = z.infer<typeof McpEventsSchema>
type McpEventsData = SidecarResult<'mcp.events'>
const NO_SUBSCRIPTIONS = { active: 0, refresh_overdue: 0, lapsed: 0, pending: 0, paused: 0 }

/**
 * TAL-1510: one server's events opt-in and native subscription health, by `McpEventsStateSchema` precedence. `data` is
 * null when the sidecar could not answer: an opted-in server is then `error`, never a guessed healthy state.
 */
export function eventsView(cfg: unknown, summary: Dict, runtime: Dict | null, data: McpEventsData | null): McpEvents {
  const enabled = isDict(cfg) && parseEnabled(cfg.events, false)
  const row = data?.servers.find((s) => s.name === summary.name)
  const subscriptions = { ...(row?.subscriptions ?? NO_SUBSCRIPTIONS) }
  const supported = data?.supported === true
  const state: McpEvents['state'] = !data ? (enabled ? 'error' : 'off') : !supported ? 'unsupported' : !enabled ? 'off'
    : data.callback === 'missing' ? 'needs_public_url' : data.callback === 'not_https' ? 'invalid_public_url'
      : subscriptions.lapsed ? 'lapsed' : subscriptions.refresh_overdue ? 'refresh_overdue' : subscriptions.active ? 'subscribed'
        : summary.active === true ? 'ready' : 'unavailable'
  return { supported, enabled, can_edit: summary.can_toggle === true && (supported || enabled), state,
    detail: state === 'unavailable' ? safeText(runtime?.error, 300) : '', utilities: row?.utilities ?? 0, subscriptions }
}

/** Python `_server_summary`. */
export function serverSummary(name: string, cfg: unknown, runtime: Dict | null): Dict {
  const rt = runtime ?? {}
  const out: Dict = { name }
  if (!isDict(cfg)) {
    return { ...out, transport: 'invalid', timeout: 120, connect_timeout: 60, enabled: false, can_toggle: false, active: false, status: 'invalid_config', tool_count: null, health: 'not_checked', health_detail: '', health_checked_at: null, health_pending: false }
  }
  let enabled = parseEnabled(cfg.enabled)
  let connected = enabled && Boolean(rt.connected)
  if ('url' in cfg) {
    out.transport = 'http'
    if ('headers' in cfg) out.headers = maskSecrets(cfg.headers)
    out.url = cfg.url
  } else if ('command' in cfg) {
    out.transport = 'stdio'
    out.command = cfg.command ?? ''
    out.args = cfg.args ?? []
    if ('env' in cfg) out.env = maskSecrets(cfg.env)
  } else {
    out.transport = 'invalid'
    enabled = false
    connected = false
  }
  out.timeout = cfg.timeout ?? 120
  out.connect_timeout = cfg.connect_timeout ?? 60
  out.enabled = enabled
  out.can_toggle = out.transport !== 'invalid'
  out.active = connected
  out.status = out.transport === 'invalid' ? 'invalid_config' : !enabled ? 'disabled' : connected ? 'active' : 'configured'
  out.tool_count = runtime ? (typeof rt.tools === 'number' ? rt.tools : Array.isArray(rt.tools) ? rt.tools.length : null) : null
  if (!enabled || out.transport === 'invalid') Object.assign(out, { health: 'not_checked', health_detail: '', health_checked_at: null, health_pending: false })
  else Object.assign(out, { health: str(rt.health) || 'unknown', health_detail: str(rt.health_detail), health_checked_at: rt.health_checked_at ?? null, health_pending: Boolean(rt.health_pending) })
  return out
}

function schemaType(schema: unknown): string {
  if (!isDict(schema)) return 'unknown'
  const t = schema.type
  if (Array.isArray(t)) return t.filter(Boolean).map(String).join('/')
  if (typeof t === 'string' && t) return t
  for (const c of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[c]) && schema[c].length) return c
  return 'unknown'
}

function safeText(value: unknown, limit: number): string {
  let text = redactString(str(value)).trim().replace(/Authorization:\s*Bearer\s+\S+/gi, '[REDACTED CREDENTIAL]')
  if (text.length > limit) text = text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
  return text
}

function schemaSummary(schema: unknown, limit = 12): Dict[] {
  if (!isDict(schema) || !isDict(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const out: Dict[] = []
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (out.length >= limit) break
    const p = dict(prop)
    out.push({ name, type: schemaType(p), required: required.has(name), description: safeText(p.description, 200) })
  }
  return out
}

function toolSchema(tool: Dict): unknown {
  for (const key of ['parameters', 'inputSchema', 'input_schema', 'schema']) {
    const value = tool[key]
    if (isDict(value)) return key === 'schema' && isDict(value.parameters) ? value.parameters : value
  }
  return {}
}

function toolSummary(name: string, toolRaw: unknown, server: Dict): Dict {
  const tool: Dict = typeof toolRaw === 'string' ? { name: toolRaw } : isDict(toolRaw) ? toolRaw : {}
  return { name: str(tool.name) || name, server: str(server.name), description: safeText(tool.description, 360), active: Boolean(server.active), enabled: Boolean(server.enabled), status: str(server.status) || 'unknown', schema_summary: schemaSummary(toolSchema(tool)) }
}

export class McpService {
  constructor(private readonly deps: { sidecar: () => SidecarLike | null; config: AgentConfig; health?: McpHealthProber }) {}

  private async runtime(profileHome: string, servers: Dict): Promise<Map<string, Dict>> {
    const byName = new Map<string, Dict>()
    const sidecar = this.deps.sidecar()
    if (sidecar) {
      try {
        for (const entry of (await sidecar.call('mcp.status', { profile_home: profileHome })).servers) byName.set(entry.name, entry)
      } catch { /* runtime unavailable → configured only */ }
    }
    const enabledServers = Object.fromEntries(Object.entries(servers).filter(([, cfg]) => isDict(cfg) && parseEnabled(cfg.enabled)))
    const verdicts = this.deps.health?.refreshAndRead(profileHome, await this.probeConfigs(profileHome, enabledServers)) ?? {}
    for (const [name, cfg] of Object.entries(servers)) {
      const entry = { ...(byName.get(name) ?? { name }) }
      const enabled = isDict(cfg) ? parseEnabled(cfg.enabled) : false
      const verdict = verdicts[name]
      Object.assign(entry, enabled ? { health: verdict?.health ?? 'unknown', health_detail: verdict?.detail ?? '', health_checked_at: verdict?.checked_at ?? null, health_pending: verdict?.pending ?? true } : { health: 'not_checked', health_detail: '', health_checked_at: null, health_pending: false })
      byName.set(name, entry)
    }
    return byName
  }

  /**
   * `servers` with each remote url/headers rendered by the Agent in this profile's secret scope, as it connects. The
   * resolved values stay in this process for the probe; without the sidecar the raw references fail the probe closed.
   */
  private async probeConfigs(profileHome: string, servers: Dict): Promise<Dict> {
    const sidecar = this.deps.sidecar()
    if (!sidecar || !Object.values(servers).some((cfg) => isDict(cfg) && 'url' in cfg)) return servers
    let targets: SidecarResult<'mcp.probe_targets'>['targets'] = []
    try { targets = (await sidecar.call('mcp.probe_targets', { profile_home: profileHome, servers })).targets } catch { return servers }
    const rendered = { ...servers }
    for (const target of targets) {
      const cfg = rendered[target.name]
      if (isDict(cfg)) rendered[target.name] = { ...cfg, url: target.url, headers: target.headers }
    }
    return rendered
  }

  private async policies(profileHome: string, config: Config): Promise<SidecarResult<'mcp.cost_policies'> | null> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return null
    try { return await sidecar.call('mcp.cost_policies', { profile_home: profileHome, servers: dict(config.mcp_servers) }) }
    catch { return null }
  }

  private policyView(profileHome: string, config: Config, policy: SidecarResult<'mcp.cost_policies'>['policies'][number]): Dict {
    const { package_revision, ...view } = policy
    // Bind the edit to the complete saved config, package declaration and profile, without exposing any of them.
    const revision = createHash('sha256').update(JSON.stringify([profileHome, config, policy.name, package_revision])).digest('hex')
    const overrides = { ...view.overrides }
    if (overrides.tool_costs) overrides.tool_costs = Object.fromEntries(Object.entries(overrides.tool_costs).map(([name, value]) => [
      safeText(name, 200), typeof value === 'object' && !Array.isArray(value)
        ? { ...value, ...(value.note !== undefined ? { note: safeText(value.note, 2000) } : {}) } : value,
    ]))
    if (overrides.cost_unit !== null) overrides.cost_unit = safeText(overrides.cost_unit, 32)
    return { ...view, overrides, revision, provenance: 'declared_estimate', reload_required: true, runtime_state: 'unknown',
      cost_unit: safeText(view.cost_unit, 32), tool_costs: view.tool_costs.map((tool) => ({ ...tool, name: safeText(tool.name, 200), note: safeText(tool.note, 2000) })) }
  }

  private async events(profileHome: string, servers: Dict): Promise<McpEventsData | null> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return null
    try { return await sidecar.call('mcp.events', { profile_home: profileHome, servers }) }
    catch { return null }
  }

  private async inventory(profileHome: string): Promise<{ servers: Dict; runtime: Map<string, Dict>; summaries: Map<string, Dict> }> {
    const config = await this.deps.config.read(profileHome)
    const servers = dict(config.mcp_servers)
    const runtime = await this.runtime(profileHome, servers)
    const [policies, events] = await Promise.all([this.policies(profileHome, config), this.events(profileHome, servers)])
    const summaries = new Map<string, Dict>(Object.entries(servers).map(([name, cfg]) => {
      const rt = runtime.get(name) ?? null
      const summary = serverSummary(name, cfg, rt)
      return [name, { ...summary, events: eventsView(cfg, summary, rt, events) }]
    }))
    if (policies?.supported) for (const policy of policies.policies) {
      const rt = runtime.get(policy.name) ?? null
      const summary = summaries.get(policy.name) ?? { ...serverSummary(policy.name, { command: '', enabled: rt?.disabled !== true }, rt), transport: str(rt?.transport) || 'package', can_toggle: false }
      summary.cost_policy = this.policyView(profileHome, config, policy)
      summaries.set(policy.name, summary)
    }
    return { servers, runtime, summaries }
  }

  async servers(profileHome: string): Promise<Dict> {
    const { summaries } = await this.inventory(profileHome)
    const rows = [...summaries.values()]
    return { servers: rows, toggle_supported: true, reload_required: true, health_pending: rows.some((r) => Boolean(r.enabled) && Boolean(r.health_pending)) }
  }

  /** `q` keeps tools whose name, server, or description contains it (case-insensitive); `total` counts the unfiltered inventory. */
  async tools(profileHome: string, q = ''): Promise<Dict> {
    const { runtime, summaries } = await this.inventory(profileHome)
    let tools: Dict[] = []
    for (const [serverName, rt] of runtime) {
      const raw = Array.isArray(rt.tools) ? rt.tools : Array.isArray(rt.tool_schemas) ? rt.tool_schemas : null
      if (!raw) continue
      const server = summaries.get(serverName) ?? { name: serverName }
      raw.forEach((tool, index) => { const row = toolSummary(`${serverName}:${String(index)}`, tool, server); if (row.name) tools.push(row) })
    }
    let source = 'mcp_runtime_status'
    if (!tools.length) {
      const sidecar = this.deps.sidecar()
      if (sidecar) {
        try {
          // The registry view also holds the launch profile's unscoped registrations; list only servers in this profile's
          // effective config: config.yaml, plus portable-plugin servers that only the runtime status reports.
          tools = (await sidecar.call('mcp.registry_tools', { profile_home: profileHome })).tools
            .filter((t) => summaries.has(t.server) || runtime.has(t.server))
            .map((t) => toolSummary(t.name, { name: t.name, ...t.schema }, summaries.get(t.server) ?? { name: t.server, enabled: true, active: false, status: 'configured' }))
        } catch { tools = [] }
      }
      source = tools.length ? 'tool_registry' : 'none'
    }
    tools.sort((a, b) => `${str(a.server)}\0${str(a.name)}`.localeCompare(`${str(b.server)}\0${str(b.name)}`))
    const total = tools.length
    const needle = q.trim().toLowerCase()
    if (needle) tools = tools.filter((t) => [t.name, t.server, t.description].some((v) => str(v).toLowerCase().includes(needle)))
    return { tools, total, source, inventory_scope: 'already_known_runtime_only', unavailable_servers: [...summaries.values()].filter((s) => Boolean(s.enabled) && !s.active).map((s) => str(s.name)) }
  }

  async delete(profileHome: string, name: string): Promise<{ ok: true; deleted: string }> {
    if (!name) throw new HttpFailure(400, 'name is required')
    await this.deps.config.update(profileHome, (c) => {
      const servers = dict(c.mcp_servers)
      if (!(name in servers)) throw new HttpFailure(404, `MCP server '${name}' not found`)
      Reflect.deleteProperty(servers, name)
      c.mcp_servers = servers
    })
    return { ok: true, deleted: name }
  }

  async toggle(profileHome: string, name: string, enabledRaw: unknown): Promise<{ ok: true; name: string; enabled: boolean }> {
    if (!name) throw new HttpFailure(400, 'name is required')
    if (enabledRaw === undefined) throw new HttpFailure(400, 'enabled field is required')
    const enabled = Boolean(enabledRaw)
    await this.deps.config.update(profileHome, (c) => {
      const servers = dict(c.mcp_servers)
      if (!(name in servers)) throw new HttpFailure(404, `MCP server '${name}' not found`)
      if (!serverSummary(name, servers[name], null).can_toggle) throw new HttpFailure(400, `MCP server '${name}' has invalid config`)
      servers[name] = { ...dict(servers[name]), enabled }
      c.mcp_servers = servers
    })
    return { ok: true, name, enabled }
  }

  private async updatePolicy(profileHome: string, name: string, body: Dict): Promise<{ ok: true; server: Dict }> {
    const parsed = McpCostPatchSchema.safeParse(body.cost_policy)
    if (!parsed.success || Object.keys(body).some((key) => !['cost_policy', 'config_revision'].includes(key))) throw new HttpFailure(400, 'Invalid cost policy patch')
    let summary: Dict = {}
    await this.deps.config.update(profileHome, async (config) => {
      const result = await this.policies(profileHome, config)
      const policy = result?.supported ? result.policies.find((p) => p.name === name) : null
      if (!policy) throw new HttpFailure(503, 'Declared MCP cost policy is unavailable')
      const current = this.policyView(profileHome, config, policy)
      if (typeof body.config_revision !== 'string' || body.config_revision !== current.revision) throw new HttpFailure(409, 'MCP configuration changed; refresh before editing')
      if (!policy.can_edit) throw new HttpFailure(409, 'Package policy requires a native server override in config.yaml')
      const servers = dict(config.mcp_servers)
      const server = { ...dict(servers[name]) }
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value === null) Reflect.deleteProperty(server, key)
        else server[key] = value
      }
      config.mcp_servers = { ...servers, [name]: server }
      const validated = await this.policies(profileHome, config)
      const updated = validated?.supported ? validated.policies.find((p) => p.name === name) : null
      if (!updated?.valid) throw new HttpFailure(400, 'Invalid declared cost policy')
      if (updated.package_revision !== policy.package_revision) throw new HttpFailure(409, 'MCP package policy changed; refresh before editing')
      summary = { ...serverSummary(name, server, null), cost_policy: this.policyView(profileHome, config, updated) }
    })
    return { ok: true, server: summary }
  }

  /** TAL-1510: only the `events` key changes; opting out removes it (the native default). Nothing else is added. */
  private async updateEvents(profileHome: string, name: string, body: Dict): Promise<{ ok: true; server: Dict }> {
    if (typeof body.events !== 'boolean' || Object.keys(body).length !== 1) throw new HttpFailure(400, 'events must be the only field and a boolean')
    const events = body.events
    await this.deps.config.update(profileHome, async (c) => {
      const servers = dict(c.mcp_servers)
      if (!(name in servers)) throw new HttpFailure(404, `MCP server '${name}' not found`)
      if (!serverSummary(name, servers[name], null).can_toggle) throw new HttpFailure(400, `MCP server '${name}' has invalid config`)
      if (events && !(await this.events(profileHome, servers))?.supported) throw new HttpFailure(409, 'The installed Agent does not support MCP events')
      const server = { ...dict(servers[name]) }
      if (events) server.events = true
      else Reflect.deleteProperty(server, 'events')
      c.mcp_servers = { ...servers, [name]: server }
    })
    const summary = (await this.inventory(profileHome)).summaries.get(name)
    if (!summary) throw new HttpFailure(404, `MCP server '${name}' not found`)
    return { ok: true, server: summary }
  }

  async update(profileHome: string, name: string, body: Dict): Promise<{ ok: true; server: Dict }> {
    if (!name) throw new HttpFailure(400, 'name is required')
    if ('cost_policy' in body) return this.updatePolicy(profileHome, name, body)
    if ('events' in body) return this.updateEvents(profileHome, name, body)
    let summary: Dict = {}
    await this.deps.config.update(profileHome, (c) => {
      const servers = dict(c.mcp_servers)
      const existing = dict(servers[name])
      const server: Dict = { ...existing }
      if (body.url) {
        for (const key of ['command', 'args', 'env', 'cwd', ...STDIO_LIFECYCLE_KEYS]) Reflect.deleteProperty(server, key)
        if (isDict(server.lifecycle)) {
          const lifecycle = { ...server.lifecycle }
          for (const key of STDIO_LIFECYCLE_KEYS) Reflect.deleteProperty(lifecycle, key)
          if (Object.keys(lifecycle).length) server.lifecycle = lifecycle
          else Reflect.deleteProperty(server, 'lifecycle')
        }
        server.url = str(body.url).trim()
        if (body.headers) server.headers = stripMasked(body.headers, existing.headers ?? {})
      } else if (body.command) {
        for (const key of ['url', 'headers', 'auth', 'oauth', 'ssl_verify', 'client_cert', 'client_key', 'skip_preflight', 'transport', 'identity_header', 'strict_redirect_headers']) Reflect.deleteProperty(server, key)
        server.command = str(body.command).trim()
        if (body.args) server.args = Array.isArray(body.args) ? body.args : [body.args]
        if (body.env) server.env = stripMasked(body.env, existing.env ?? {})
      } else throw new HttpFailure(400, 'url or command is required')
      for (const key of ['headers', 'args', 'env', 'timeout']) {
        if (body[key] === null) Reflect.deleteProperty(server, key)
      }
      if (body.timeout !== undefined && body.timeout !== null) {
        const t = Number.parseInt(str(body.timeout), 10)
        if (Number.isFinite(t)) server.timeout = t
      }
      servers[name] = server
      c.mcp_servers = servers
      summary = serverSummary(name, server, null)
    })
    return { ok: true, server: summary }
  }
}

export function notesSources(config: Config, enabled: boolean): Dict {
  if (!enabled) return { enabled: false, sources: [], source: 'disabled', inventory_scope: 'disabled_by_default', attach_supported: false, automatic_recall_unchanged: true, recent_ai_notes: [] }
  const hints = new Set(['joplin', 'obsidian', 'notion', 'llm-wiki', 'llmwiki', 'wiki', 'notes', 'note', 'knowledge', 'kb', 'readwise', 'logseq'])
  const sources = Object.entries(dict(config.mcp_servers)).filter(([name]) => [...hints].some((h) => name.toLowerCase().includes(h))).map(([name, cfg]) => ({ id: name, name, kind: 'mcp', enabled: isDict(cfg) ? parseEnabled(cfg.enabled) : false, tools: [] }))
  return { enabled: true, sources, source: sources.length ? 'config' : 'none', inventory_scope: 'already_known_runtime_only', attach_supported: false, automatic_recall_unchanged: true, recent_ai_notes: [] }
}

/** A Joplin call that failed; its message is fixed text safe to return to the client (Python `ValueError`). */
export class JoplinError extends Error {}

/** Python `_joplin_connection_from_config`: the `joplin` MCP server's env (name matched case-insensitively), then the process env. */
function joplinConnection(config: Config, env: Record<string, string | undefined>): { url: string; token: string } {
  const server = Object.entries(dict(config.mcp_servers)).find(([name]) => name.trim().toLowerCase() === 'joplin')?.[1]
  const serverEnv = dict(dict(server).env)
  return { url: (str(serverEnv.JOPLIN_URL) || env.JOPLIN_URL || 'http://127.0.0.1:41184').replace(/\/+$/, ''), token: str(serverEnv.JOPLIN_TOKEN) || env.JOPLIN_TOKEN || '' }
}

/**
 * Python `_joplin_api_get`: the token rides in the `Authorization` header, and in the query only for `/search`, which
 * some Web Clipper builds refuse without it. 8 s timeout, 2,000,000-byte read cap; failures carry no URL or token.
 */
async function joplinGet(config: Config, env: Record<string, string | undefined>, fetchImpl: typeof fetch, path: string, params: Record<string, string | number>): Promise<Dict> {
  const { url, token } = joplinConnection(config, env)
  if (!token) throw new JoplinError('Joplin token is not configured')
  const safePath = '/' + path.replace(/^\/+/, '')
  const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))
  if (safePath === '/search') query.set('token', token)
  let raw: Buffer | null
  try {
    const res = await fetchImpl(`${url}${safePath}?${query.toString()}`, { headers: { Authorization: `token ${token}` }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new JoplinError(`Joplin API returned HTTP ${String(res.status)}`)
    }
    raw = await readCapped(res, 2_000_000)
  } catch (error) {
    if (error instanceof JoplinError) throw error
    throw new JoplinError('Joplin API is not reachable')
  }
  let data: unknown
  try { data = JSON.parse(raw?.toString('utf8') ?? '') } catch { throw new JoplinError('Joplin API returned invalid JSON') }
  return isDict(data) ? data : {}
}

/** Python `_note_snippet`: whitespace collapsed, started near the first match, cut at `limit`. */
function noteSnippet(body: string, query: string, limit = 220): string {
  let text = body.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const q = query.trim().toLowerCase()
  if (q) {
    const idx = text.toLowerCase().indexOf(q)
    if (idx > 40) text = '…' + text.slice(Math.max(0, idx - 60))
  }
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text
}

export interface JoplinDeps { config: Config; env: Record<string, string | undefined>; fetch: typeof fetch; redact: boolean }

/** Python `_joplin_search_notes`: up to `limit` (1-50) notes; an empty query asks Joplin nothing. */
export async function joplinSearch(deps: JoplinDeps, rawQuery: string, limit: number): Promise<Dict[]> {
  const query = rawQuery.trim()
  if (!query) return []
  const data = await joplinGet(deps.config, deps.env, deps.fetch, '/search', { query, type: 'note', fields: 'id,title,body,parent_id,updated_time', limit: Math.max(1, Math.min(limit, 50)) })
  const results: Dict[] = []
  for (const row of Array.isArray(data.items) ? data.items : []) {
    if (!isDict(row)) continue
    const id = safeText(row.id, 64)
    if (!id) continue
    results.push({ id, title: safeText(row.title || 'Untitled', 180), snippet: safeText(noteSnippet(str(row.body), query), 260), parent_id: safeText(row.parent_id, 64), updated_time: row.updated_time ?? null, source: 'joplin' })
  }
  return results
}

/** Python `_joplin_get_note`: the id is checked before it reaches the URL; the body is cut at 50,000 characters, then redacted. */
export async function joplinNote(deps: JoplinDeps, rawId: string): Promise<Dict> {
  const id = rawId.trim()
  if (!/^[A-Za-z0-9]{16,64}$/.test(id)) throw new JoplinError('Invalid Joplin note id')
  const data = await joplinGet(deps.config, deps.env, deps.fetch, `/notes/${id}`, { fields: 'id,title,body,parent_id,updated_time,created_time' })
  if (!data.id) throw new JoplinError('Joplin note not found')
  let body = str(data.body)
  if (body.length > 50_000) body = body.slice(0, 50_000).trimEnd() + '\n\n[Preview truncated at 50,000 characters]'
  return { id: safeText(data.id, 64), title: safeText(data.title || 'Untitled', 180), body: redactString(body, deps.redact), parent_id: safeText(data.parent_id, 64), updated_time: data.updated_time ?? null, created_time: data.created_time ?? null, source: 'joplin' }
}
