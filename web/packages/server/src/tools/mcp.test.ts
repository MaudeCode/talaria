import { describe, expect, it } from 'vitest'
import { JoplinError, joplinSearch, McpService } from './mcp.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { McpHealthProber } from './mcp-health.js'
import type { AgentConfig, Dict } from '../config/agent-config.js'

describe('MCP config updates', () => {
  const http = { url: 'https://old.example/mcp', headers: { Authorization: 'Bearer synthetic-secret' } }
  const stdio = { command: 'old-mcp', args: ['--old'], env: { API_KEY: 'synthetic-secret' } }
  const httpOptions = {
    auth: 'oauth', oauth: { client_id: 'test-client', client_secret: 'synthetic-secret' },
    ssl_verify: false, client_cert: '/test/cert.pem', client_key: '/test/key.pem',
    skip_preflight: true, transport: 'sse', identity_header: { name: 'X-Identity' }, strict_redirect_headers: true,
  }
  const stdioOptions = { cwd: '/test/workspace', idle_timeout_seconds: 60, max_lifetime_seconds: 120, lifecycle: { idle_timeout_seconds: 30, max_lifetime_seconds: 90 } }

  it.each<{ name: string; existing: Dict; body: Dict; expected: Dict }>([
    { name: 'URL-only edit', existing: http, body: { url: 'https://new.example/mcp' }, expected: { ...http, url: 'https://new.example/mcp' } },
    { name: 'command-only edit', existing: stdio, body: { command: 'new-mcp' }, expected: { ...stdio, command: 'new-mcp' } },
    { name: 'HTTP to stdio switch', existing: http, body: { command: 'new-mcp', args: ['--new'], env: { MODE: 'test' } }, expected: { command: 'new-mcp', args: ['--new'], env: { MODE: 'test' } } },
    { name: 'stdio to HTTP switch', existing: stdio, body: { url: 'https://new.example/mcp', headers: {} }, expected: { url: 'https://new.example/mcp', headers: {} } },
    { name: 'masked HTTP secret', existing: http, body: { url: http.url, headers: { Authorization: '••••••' }, timeout: '45' }, expected: { ...http, timeout: 45 } },
    { name: 'masked stdio secret', existing: stdio, body: { command: stdio.command, args: [], env: { API_KEY: '••••••' } }, expected: { ...stdio, args: [] } },
    { name: 'HTTP edit with transport options', existing: { ...http, ...httpOptions }, body: { url: 'https://new.example/mcp' }, expected: { ...http, ...httpOptions, url: 'https://new.example/mcp' } },
    { name: 'stdio edit with lifecycle options', existing: { ...stdio, ...stdioOptions }, body: { command: 'new-mcp' }, expected: { ...stdio, ...stdioOptions, command: 'new-mcp' } },
    { name: 'HTTP to stdio switch with authentication and TLS', existing: { ...http, ...httpOptions }, body: { command: 'new-mcp' }, expected: { command: 'new-mcp' } },
    { name: 'stdio to HTTP switch with lifecycle options', existing: { ...stdio, ...stdioOptions }, body: { url: 'https://new.example/mcp' }, expected: { url: 'https://new.example/mcp' } },
    { name: 'stdio to HTTP switch with unknown lifecycle options', existing: { ...stdio, ...stdioOptions, lifecycle: { ...stdioOptions.lifecycle, future_option: 'keep' } }, body: { url: 'https://new.example/mcp' }, expected: { url: 'https://new.example/mcp', lifecycle: { future_option: 'keep' } } },
  ])('preserves unrelated config after $name', async ({ existing, body, expected }) => {
    const retained = {
      spend_limit: 5, tool_costs: { search: 0.2 }, cost_unit: 'USD', trust: false,
      enabled: false, tools: { include: ['search'], exclude: ['delete'] },
      timeout: 30, connect_timeout: 10, future_option: { nested: ['keep'] },
    }
    const cfg = { mcp_servers: { paid: { ...existing, ...retained }, sibling: { command: 'untouched' } } }
    const config = { update: (_home: string, fn: (c: typeof cfg) => void) => { fn(cfg); return Promise.resolve() } } as unknown as AgentConfig
    const result = await new McpService({ sidecar: () => null, config }).update('/profiles/test', 'paid', body)
    expect(cfg.mcp_servers).toEqual({ paid: { ...retained, ...expected }, sibling: { command: 'untouched' } })
    expect(result.server).toMatchObject({ enabled: false, status: 'disabled', timeout: expected.timeout ?? retained.timeout })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  it.each<{ field: string; existing: Dict; body: Dict; expected: Dict }>([
    { field: 'headers', existing: http, body: { url: http.url, headers: null }, expected: { url: http.url } },
    { field: 'args', existing: stdio, body: { command: stdio.command, args: null }, expected: { command: stdio.command, env: stdio.env } },
    { field: 'env', existing: stdio, body: { command: stdio.command, env: null }, expected: { command: stdio.command, args: stdio.args } },
    { field: 'timeout', existing: { ...http, timeout: 30 }, body: { url: http.url, timeout: null }, expected: http },
  ])('clears explicitly null $field without clearing omitted fields', async ({ field, existing, body, expected }) => {
    const cfg = { mcp_servers: { paid: { ...existing, enabled: false, spend_limit: 5 } } }
    const config = { update: (_home: string, fn: (c: typeof cfg) => void) => { fn(cfg); return Promise.resolve() } } as unknown as AgentConfig
    await new McpService({ sidecar: () => null, config }).update('/profiles/test', 'paid', body)
    expect(cfg.mcp_servers.paid).toEqual({ ...expected, enabled: false, spend_limit: 5 })
    expect(cfg.mcp_servers.paid).not.toHaveProperty(field)
  })
})

describe('MCP declared cost policy', () => {
  it('publishes declared estimates and revision-fenced edits without changing transport or trust', async () => {
    const cfg: Dict = { mcp_servers: { paid: { command: 'paid-mcp', trust: 'full', enabled: false, tool_costs: { search: { credits: [1, 3], note: 'estimate' } }, spend_limit: 5, future: 'keep' } } }
    const config = { read: () => Promise.resolve(structuredClone(cfg)), update: async (_home: string, fn: (c: Dict) => unknown) => { const next = structuredClone(cfg); await fn(next); Object.assign(cfg, next); return next } } as unknown as AgentConfig
    let packageRevision = 'none'
    let editable = true
    let valid = true
    let changePackageDuringEdit = false
    let policyReads = 0
    const sidecar = { call: (method: string, params: { servers: Dict }) => {
      if (method === 'mcp.status') return Promise.resolve({ servers: [] })
      if (method !== 'mcp.cost_policies') throw new Error(method)
      if (changePackageDuringEdit && ++policyReads === 2) packageRevision = 'changed-during-edit'
      return Promise.resolve({ supported: true, policies: Object.entries(params.servers).map(([name, raw]) => {
        const c = raw as Dict
        return { name, source: 'native', valid, can_edit: editable, error: null, package_revision: packageRevision, overrides: { tool_costs: c.tool_costs ?? null, spend_limit: c.spend_limit ?? null, cost_unit: c.cost_unit ?? null }, tool_costs: [{ name: 'search', low: 1, high: 3, note: 'estimate' }], spend_limit: c.spend_limit ?? 0, cost_unit: c.cost_unit ?? 'credits', budget_enabled: true, field_sources: { tool_costs: 'native', spend_limit: 'native', cost_unit: 'default' } }
      }) })
    } } as unknown as FakeSidecar
    const service = new McpService({ config, sidecar: () => sidecar })
    const row = ((await service.servers('/profiles/a')).servers as Dict[])[0]!
    expect(row.cost_policy).toMatchObject({ source: 'native', can_edit: true, valid: true, spend_limit: 5, reload_required: true, runtime_state: 'unknown', provenance: 'declared_estimate' })
    const policy = row.cost_policy as { revision: string }
    await service.update('/profiles/a', 'paid', { config_revision: policy.revision, cost_policy: { spend_limit: 0, cost_unit: 'USD' } })
    expect((cfg.mcp_servers as Dict).paid).toEqual({ command: 'paid-mcp', trust: 'full', enabled: false, tool_costs: { search: { credits: [1, 3], note: 'estimate' } }, spend_limit: 0, cost_unit: 'USD', future: 'keep' })
    await expect(service.update('/profiles/a', 'paid', { config_revision: policy.revision, cost_policy: { spend_limit: 10 } })).rejects.toMatchObject({ status: 409 })
    const refreshed = ((await service.servers('/profiles/a')).servers as Dict[])[0]!.cost_policy as { revision: string }
    await service.update('/profiles/a', 'paid', { config_revision: refreshed.revision, cost_policy: { spend_limit: null } })
    expect((cfg.mcp_servers as Dict).paid).not.toHaveProperty('spend_limit')
    await expect(service.update('/profiles/a', 'paid', { config_revision: refreshed.revision, cost_policy: { spend_limit: -1 } })).rejects.toMatchObject({ status: 400 })
    await expect(service.update('/profiles/a', 'paid', { config_revision: refreshed.revision, cost_policy: { spend_limit: 1 }, trust: 'full' })).rejects.toMatchObject({ status: 400 })
    await expect(new McpService({ config, sidecar: () => null }).update('/profiles/a', 'paid', { config_revision: refreshed.revision, cost_policy: { spend_limit: 1 } })).rejects.toMatchObject({ status: 503 })
    await expect(service.update('/profiles/b', 'paid', { config_revision: refreshed.revision, cost_policy: { spend_limit: 2 } })).rejects.toMatchObject({ status: 409 })
    const latest = ((await service.servers('/profiles/a')).servers as Dict[])[0]!.cost_policy as { revision: string }
    const unchanged = structuredClone(cfg)
    packageRevision = 'package-changed'
    await expect(service.update('/profiles/a', 'paid', { config_revision: latest.revision, cost_policy: { spend_limit: 2 } })).rejects.toMatchObject({ status: 409 })
    packageRevision = 'none'
    editable = false
    await expect(service.update('/profiles/a', 'paid', { config_revision: latest.revision, cost_policy: { spend_limit: 2 } })).rejects.toMatchObject({ status: 409 })
    editable = true
    valid = false
    await expect(service.update('/profiles/a', 'paid', { config_revision: latest.revision, cost_policy: { spend_limit: 2 } })).rejects.toMatchObject({ status: 400 })
    expect(cfg).toEqual(unchanged)
    valid = true
    changePackageDuringEdit = true
    await expect(service.update('/profiles/a', 'paid', { config_revision: latest.revision, cost_policy: { spend_limit: 2 } })).rejects.toMatchObject({ status: 409 })
    expect(cfg).toEqual(unchanged)
  })
})

describe('MCP tool inventory', () => {
  it('lists registry tools only for servers in the profile\'s effective MCP config', async () => {
    const sidecar = new FakeSidecar()
    // A portable plugin's server is in the Agent's effective config (so in runtime status) but not in config.yaml.
    sidecar.respond('mcp.status', () => ({ servers: [{ name: 'plugin_srv', status: 'configured', tools: 0 }] }))
    // The launch profile's unscoped registrations stay in every profile's registry view.
    sidecar.respond('mcp.registry_tools', () => ({ tools: [
      { name: 'mcp__stub_a__ping', server: 'stub_a', schema: { description: 'launch profile tool' } },
      { name: 'mcp__stub_b__ping', server: 'stub_b', schema: { description: 'own tool' } },
      { name: 'mcp__plugin_srv__ping', server: 'plugin_srv', schema: { description: 'portable plugin tool' } },
    ] }))
    const config = { read: () => Promise.resolve({ mcp_servers: { stub_b: { command: 'stub' } } }) } as unknown as AgentConfig
    const result = await new McpService({ sidecar: () => sidecar, config }).tools('/profiles/b')
    expect((result.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['mcp__plugin_srv__ping', 'mcp__stub_b__ping'])
    expect(result.source).toBe('tool_registry')
  })

  it('search keeps tools matching name, server, or description and still counts the whole inventory', async () => {
    const sidecar = new FakeSidecar()
    sidecar.respond('mcp.status', () => ({ servers: [
      { name: 'github', connected: true, tools: [{ name: 'create_issue', description: 'Open an issue' }, { name: 'list_pulls', description: 'List pull requests' }] },
      { name: 'notes', connected: true, tools: [{ name: 'search', description: 'Find NOTES by text' }] },
    ] }))
    const config = { read: () => Promise.resolve({ mcp_servers: { github: { command: 'gh-mcp' }, notes: { url: 'https://notes.example/mcp' } } }) } as unknown as AgentConfig
    const service = new McpService({ sidecar: () => sidecar, config })
    const names = async (q: string) => { const r = await service.tools('/profiles/a', q); return { names: (r.tools as { name: string }[]).map((t) => t.name), total: r.total } }
    expect(await names('')).toEqual({ names: ['create_issue', 'list_pulls', 'search'], total: 3 })
    expect(await names('PULL')).toEqual({ names: ['list_pulls'], total: 3 })
    expect(await names(' github ')).toEqual({ names: ['create_issue', 'list_pulls'], total: 3 })
    expect(await names('notes by')).toEqual({ names: ['search'], total: 3 })
    expect(await names('nothing')).toEqual({ names: [], total: 3 })
  })

  it('a server with invalid config cannot be toggled: the row says so and the PATCH is rejected without writing', async () => {
    const cfg: Record<string, unknown> = { mcp_servers: { incomplete: { timeout: 5 }, broken: 'oops', ok: { command: 'ok-mcp' } } }
    const config = { read: () => Promise.resolve(cfg), update: (_home: string, fn: (c: Record<string, unknown>) => void) => { fn(cfg); return Promise.resolve() } } as unknown as AgentConfig
    const service = new McpService({ sidecar: () => null, config })
    const rows = (await service.servers('/profiles/a')).servers as { name: string; can_toggle: boolean }[]
    expect(Object.fromEntries(rows.map((r) => [r.name, r.can_toggle]))).toEqual({ incomplete: false, broken: false, ok: true })
    await expect(service.toggle('/profiles/a', 'incomplete', true)).rejects.toMatchObject({ status: 400 })
    expect(cfg.mcp_servers).toEqual({ incomplete: { timeout: 5 }, broken: 'oops', ok: { command: 'ok-mcp' } })
    await expect(service.toggle('/profiles/a', 'ok', false)).resolves.toEqual({ ok: true, name: 'ok', enabled: false })
  })
})

describe('Joplin client', () => {
  it('turns a timeout into a fixed "not reachable" failure [py:test_joplin_api_get_converts_bare_timeout_to_valueerror]', async () => {
    let signal: AbortSignal | null | undefined
    const timedOut: typeof fetch = (_input, init) => { signal = init?.signal; return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) }
    const deps = { config: { mcp_servers: { joplin: { env: { JOPLIN_TOKEN: 'secret-token' } } } }, env: {}, fetch: timedOut, redact: true }
    const error = await joplinSearch(deps, 'hello world', 20).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JoplinError)
    expect((error as Error).message).toBe('Joplin API is not reachable')
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

describe('MCP health probe credentials (TAL-1565)', () => {
  const INIT_OK = JSON.stringify({ jsonrpc: '2.0', id: 'hermes-webui-health', result: { protocolVersion: '2025-06-18' } })
  /** An MCP endpoint that answers initialize only for an accepted Authorization header, recording each one it saw. */
  const endpoint = (accepted: Set<string>) => {
    const seen: string[] = []
    const f = ((_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization') ?? ''
      if (init.method === 'POST') seen.push(auth)
      return Promise.resolve(accepted.has(auth) ? new Response(INIT_OK, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('', { status: 401 }))
    }) as typeof fetch
    return { f, seen }
  }
  const raw = { url: 'https://mcp.invalid/mcp', headers: { Authorization: 'Bearer ${SYNTHETIC_MCP_KEY}' } }
  const setup = (fetchImpl: typeof fetch, env: Record<string, Record<string, string>>, servers: Dict = { kanvil: raw }) => {
    const sidecar = new FakeSidecar()
    sidecar.respond('mcp.status', () => ({ servers: [] }))
    sidecar.respond('mcp.cost_policies', () => ({ supported: false, policies: [] }))
    // The Agent's rendering: `${VAR}` from the requested profile's own environment, an unset one kept as its placeholder.
    sidecar.respond('mcp.probe_targets', (params) => ({ targets: Object.entries(params.servers).map(([name, c]) => {
      const render = (v: string) => v.replace(/\$\{([^}]+)\}/g, (ref, key: string) => env[params.profile_home]?.[key] ?? ref)
      const cfg = c as { url: string; headers?: Record<string, string> }
      return { name, url: render(cfg.url), headers: Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, render(v)])) }
    }) }))
    const config = { read: () => Promise.resolve({ mcp_servers: servers }) } as unknown as AgentConfig
    let now = 1000
    const health = new McpHealthProber({ fetch: () => fetchImpl, now: () => now, log: () => undefined })
    const service = new McpService({ sidecar: () => sidecar, config, health })
    const rows = async (profile: string) => {
      await service.servers(profile)
      await health.settle()
      return Object.fromEntries(((await service.servers(profile)).servers as Dict[]).map((r) => [String(r.name), r])) as Record<string, Dict>
    }
    return { rows, tick: () => { now += 1 } }
  }

  it('probes with the profile\'s resolved Authorization reference, so a working key reads healthy, not Needs sign-in', async () => {
    const api = endpoint(new Set(['Bearer synthetic-a']))
    const { rows } = setup(api.f, { '/profiles/a': { SYNTHETIC_MCP_KEY: 'synthetic-a' } })
    expect((await rows('/profiles/a')).kanvil).toMatchObject({ health: 'healthy', health_detail: 'HTTP 200' })
    expect(api.seen).toEqual(['Bearer synthetic-a'])
  })

  it('keeps each profile\'s credential and verdict apart for the same server and reference, and re-probes a rotated key', async () => {
    const accepted = new Set(['Bearer synthetic-a'])
    const api = endpoint(accepted)
    const env = { '/profiles/a': { SYNTHETIC_MCP_KEY: 'synthetic-a' }, '/profiles/b': { SYNTHETIC_MCP_KEY: 'synthetic-b' } }
    const { rows, tick } = setup(api.f, env)
    expect((await rows('/profiles/a')).kanvil).toMatchObject({ health: 'healthy' })
    // A genuine authentication failure still reads as needs_auth.
    expect((await rows('/profiles/b')).kanvil).toMatchObject({ health: 'needs_auth', health_detail: 'HTTP 401' })
    expect(api.seen).toEqual(['Bearer synthetic-a', 'Bearer synthetic-b'])
    // Rotating profile B's key probes again at once rather than reusing its stale verdict within the interval.
    env['/profiles/b'].SYNTHETIC_MCP_KEY = 'synthetic-b2'
    accepted.add('Bearer synthetic-b2')
    tick()
    expect((await rows('/profiles/b')).kanvil).toMatchObject({ health: 'healthy' })
    expect((await rows('/profiles/a')).kanvil).toMatchObject({ health: 'healthy' })
    expect(api.seen).toEqual(['Bearer synthetic-a', 'Bearer synthetic-b', 'Bearer synthetic-b2'])
  })

  it('keeps literal headers working and never reports an unresolved reference as healthy', async () => {
    const api = endpoint(new Set(['Bearer literal-token']))
    const servers = { literal: { url: 'https://mcp.invalid/literal', headers: { Authorization: 'Bearer literal-token' } }, unset: raw }
    const { rows } = setup(api.f, {}, servers)
    const result = await rows('/profiles/a')
    expect(result.literal).toMatchObject({ health: 'healthy' })
    expect(result.unset).toMatchObject({ health: 'unhealthy', health_detail: 'unresolved in url/headers: ${SYNTHETIC_MCP_KEY}' })
    // The unresolved placeholder is never sent as a credential.
    expect(api.seen).toEqual(['Bearer literal-token'])
  })

  it('fails closed without the sidecar instead of sending the raw reference', async () => {
    const api = endpoint(new Set())
    const config = { read: () => Promise.resolve({ mcp_servers: { kanvil: raw } }) } as unknown as AgentConfig
    const health = new McpHealthProber({ fetch: () => api.f, now: () => 1000, log: () => undefined })
    const service = new McpService({ sidecar: () => null, config, health })
    await service.servers('/profiles/a')
    await health.settle()
    expect(((await service.servers('/profiles/a')).servers as Dict[])[0]).toMatchObject({ health: 'unhealthy', health_detail: 'unresolved in url/headers: ${SYNTHETIC_MCP_KEY}' })
    expect(api.seen).toEqual([])
  })

  it('never returns a resolved credential in the server rows, even when the transport error quotes it', async () => {
    const failing = (() => Promise.reject(new TypeError('Headers.append: "Bearer synthetic-secret-c" is an invalid header value.'))) as typeof fetch
    const { rows } = setup(failing, { '/profiles/a': { SYNTHETIC_MCP_KEY: 'synthetic-secret-c' } })
    const result = await rows('/profiles/a')
    expect(result.kanvil).toMatchObject({ health: 'unhealthy', headers: { Authorization: '••••••' } })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-c')
  })
})
