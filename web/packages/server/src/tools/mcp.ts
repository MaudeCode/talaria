/** MCP server inventory from config.yaml plus the Agent's already-known runtime status and the background health verdicts (Python MCP handlers). */
import type { SidecarLike } from '../sidecar/client.js'
import { dict, isDict, type AgentConfig, type Config, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { redactString } from '../redact.js'
import { str } from '../util.js'
import type { McpHealthProber } from './mcp-health.js'

const MASK = '••••••'
const SENSITIVE = ['auth', 'token', 'key', 'secret', 'password', 'credential']

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

export function parseEnabled(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(n)) return true
    if (['false', '0', 'no', 'off'].includes(n)) return false
  }
  return true
}

/** Python `_server_summary`. */
export function serverSummary(name: string, cfg: unknown, runtime: Dict | null): Dict {
  const rt = runtime ?? {}
  const out: Dict = { name }
  if (!isDict(cfg)) {
    return { ...out, transport: 'invalid', timeout: 120, connect_timeout: 60, enabled: false, active: false, status: 'invalid_config', tool_count: null, health: 'not_checked', health_detail: '', health_checked_at: null, health_pending: false }
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
    const verdicts = this.deps.health?.refreshAndRead(enabledServers) ?? {}
    for (const [name, cfg] of Object.entries(servers)) {
      const entry = { ...(byName.get(name) ?? { name }) }
      const enabled = isDict(cfg) ? parseEnabled(cfg.enabled) : false
      const verdict = verdicts[name]
      Object.assign(entry, enabled ? { health: verdict?.health ?? 'unknown', health_detail: verdict?.detail ?? '', health_checked_at: verdict?.checked_at ?? null, health_pending: verdict?.pending ?? true } : { health: 'not_checked', health_detail: '', health_checked_at: null, health_pending: false })
      byName.set(name, entry)
    }
    return byName
  }

  private async inventory(profileHome: string): Promise<{ servers: Dict; runtime: Map<string, Dict>; summaries: Map<string, Dict> }> {
    const config = await this.deps.config.read(profileHome)
    const servers = dict(config.mcp_servers)
    const runtime = await this.runtime(profileHome, servers)
    const summaries = new Map(Object.entries(servers).map(([name, cfg]) => [name, serverSummary(name, cfg, runtime.get(name) ?? null)]))
    return { servers, runtime, summaries }
  }

  async servers(profileHome: string): Promise<Dict> {
    const { summaries } = await this.inventory(profileHome)
    const rows = [...summaries.values()]
    return { servers: rows, toggle_supported: true, reload_required: true, health_pending: rows.some((r) => Boolean(r.enabled) && Boolean(r.health_pending)) }
  }

  async tools(profileHome: string): Promise<Dict> {
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
    return { tools, total: tools.length, source, inventory_scope: 'already_known_runtime_only', unavailable_servers: [...summaries.values()].filter((s) => Boolean(s.enabled) && !s.active).map((s) => str(s.name)) }
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
      if (!isDict(servers[name])) throw new HttpFailure(400, `MCP server '${name}' has invalid config`)
      servers[name] = { ...servers[name], enabled }
      c.mcp_servers = servers
    })
    return { ok: true, name, enabled }
  }

  async update(profileHome: string, name: string, body: Dict): Promise<{ ok: true; server: Dict }> {
    if (!name) throw new HttpFailure(400, 'name is required')
    let summary: Dict = {}
    await this.deps.config.update(profileHome, (c) => {
      const servers = dict(c.mcp_servers)
      const existing = dict(servers[name])
      const server: Dict = {}
      if (body.url) {
        server.url = str(body.url).trim()
        if (body.headers) server.headers = stripMasked(body.headers, existing.headers ?? {})
      } else if (body.command) {
        server.command = str(body.command).trim()
        if (body.args) server.args = Array.isArray(body.args) ? body.args : [body.args]
        if (body.env) server.env = stripMasked(body.env, existing.env ?? {})
      } else throw new HttpFailure(400, 'url or command is required')
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
