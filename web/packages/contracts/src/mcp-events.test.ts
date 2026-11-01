import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpEventsDataSchema, McpEventsSchema, McpEventsStateSchema } from './mcp-events.js'

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/mcp-events.json'), 'utf8')) as { cases: { name: string; data: unknown; expected: unknown }[] }

describe('MCP events fixture (TAL-1510)', () => {
  it.each(fixture.cases)('$name parses as sidecar data and server view', ({ data, expected }) => {
    if (data !== null) expect(McpEventsDataSchema.parse(data)).toEqual(data)
    expect(McpEventsSchema.parse(expected)).toEqual(expected)
  })

  it('covers every server-derived state', () => {
    const seen = new Set(fixture.cases.map((c) => McpEventsSchema.parse(c.expected).state))
    expect([...seen].sort()).toEqual([...McpEventsStateSchema.options].sort())
  })
})
