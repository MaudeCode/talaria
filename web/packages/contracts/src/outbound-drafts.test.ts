import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { OutboundDraftActionSchema, OutboundDraftResultSchema } from './outbound-drafts.js'

it('pins available, unavailable, approved, superseded and masked shared draft fixtures', () => {
  const cases = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/outbound-drafts.json'), 'utf8')) as Record<string, unknown>
  for (const value of Object.values(cases)) expect(OutboundDraftResultSchema.safeParse(value).success).toBe(true)
  expect(OutboundDraftActionSchema.safeParse({ session_id: 'synthetic', tool_call_id: 'call', draft_id: 'd_1234abcd', card: 1, action: 'approve' }).success).toBe(false)
})
