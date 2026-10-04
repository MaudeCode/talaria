import { describe, expect, it } from 'vitest'
import { McpService } from './mcp.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { AgentConfig } from '../config/agent-config.js'

describe('MCP tool inventory', () => {
  it('lists registry tools only for servers the profile configures', async () => {
    const sidecar = new FakeSidecar()
    sidecar.respond('mcp.status', () => ({ servers: [] }))
    // The launch profile's unscoped registrations stay in every profile's registry view.
    sidecar.respond('mcp.registry_tools', () => ({ tools: [
      { name: 'mcp__stub_a__ping', server: 'stub_a', schema: { description: 'launch profile tool' } },
      { name: 'mcp__stub_b__ping', server: 'stub_b', schema: { description: 'own tool' } },
    ] }))
    const config = { read: () => Promise.resolve({ mcp_servers: { stub_b: { command: 'stub' } } }) } as unknown as AgentConfig
    const result = await new McpService({ sidecar: () => sidecar, config }).tools('/profiles/b')
    expect((result.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['mcp__stub_b__ping'])
    expect(result.source).toBe('tool_registry')
  })
})
