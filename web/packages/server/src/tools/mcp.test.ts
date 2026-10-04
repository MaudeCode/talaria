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
})
