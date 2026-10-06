import { describe, expect, it } from 'vitest'
import { McpService } from './mcp.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { AgentConfig } from '../config/agent-config.js'

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
