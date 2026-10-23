import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpCostPolicySchema, McpCostPatchSchema } from './mcp-cost-policy.js'

describe('declared MCP cost patches', () => {
  it('pins the shared native-override response', () => {
    const policy = McpCostPolicySchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/mcp-cost-policy.json'), 'utf8')))
    expect(policy).toMatchObject({ spend_limit: 0, reload_required: true, runtime_state: 'unknown', field_sources: { tool_costs: 'package' } })
  })
  it.each([
    { tool_costs: { free: 0, search: [1, 3], paid: { credits: [0, 2], note: 'estimate' } }, spend_limit: 0, cost_unit: 'credits' },
    { tool_costs: null }, { spend_limit: null }, { cost_unit: null }, { tool_costs: {} },
  ])('accepts explicit values and unset: %j', (patch) => { expect(McpCostPatchSchema.parse(patch)).toEqual(patch) })
  it.each([
    {}, { spend_limit: -1 }, { spend_limit: NaN }, { spend_limit: Infinity }, { spend_limit: true }, { spend_limit: '3' },
    { tool_costs: { search: [3, 1] } }, { tool_costs: { search: [-1, 3] } }, { tool_costs: { search: [1] } },
    { tool_costs: { search: { credits: 1, note: 5 } } }, { tool_costs: { search: { credits: 1, trust: 'full' } } },
    { tool_costs: { '': 1 } }, { cost_unit: '' }, { cost_unit: ' ' }, { cost_unit: 'a'.repeat(33) }, { trust: 'full' },
  ])('rejects malformed or unrelated input: %j', (patch) => { expect(McpCostPatchSchema.safeParse(patch).success).toBe(false) })
})
