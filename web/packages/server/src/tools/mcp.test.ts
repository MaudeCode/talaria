import { describe, expect, it } from 'vitest'
import { JoplinError, joplinSearch, McpService } from './mcp.js'
import { FakeSidecar } from '../sidecar/fake.js'
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
