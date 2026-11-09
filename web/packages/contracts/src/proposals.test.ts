import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ProposalEventSchema, ProposalRefSchema, ProposalSchema } from './proposals.js'

it('pins the shared proposal fixture the App renders (TAL-1967)', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/proposal.json'), 'utf8')) as Record<string, unknown>
  expect(ProposalSchema.parse(fixture.proposal)).toEqual(fixture.proposal)
  expect(ProposalSchema.parse(fixture.applied)).toEqual(fixture.applied)
  expect(ProposalRefSchema.parse(fixture.ref)).toEqual(fixture.ref)
  expect(ProposalEventSchema.parse(fixture.event)).toEqual(fixture.event)
})
