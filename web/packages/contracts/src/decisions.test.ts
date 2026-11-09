import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DecisionAnswerSchema, DecisionItemSchema, DecisionReviewEventSchema, DecisionReviewRefSchema, DecisionReviewSchema, DecisionReviewsSchema } from './decisions.js'

it('pins the shared decision review fixture the App renders (TAL-1965)', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/decision-review.json'), 'utf8')) as Record<string, unknown>
  expect(DecisionReviewSchema.parse(fixture.review)).toEqual(fixture.review)
  expect(DecisionReviewEventSchema.parse(fixture.event)).toEqual(fixture.event)
  expect(DecisionReviewRefSchema.parse(fixture.ref)).toEqual(fixture.ref)
  // TAL-1966: the Decisions list and its empty reason.
  expect(DecisionReviewsSchema.parse(fixture.list)).toEqual(fixture.list)
  expect(DecisionReviewsSchema.parse(fixture.list_empty)).toEqual(fixture.list_empty)
  const conflict = fixture.answer_conflict as { answer: unknown; answer_version: unknown }
  expect(DecisionAnswerSchema.parse(conflict.answer)).toEqual(conflict.answer)
  expect(DecisionItemSchema.shape.answer_version.parse(conflict.answer_version)).toBe(conflict.answer_version)
})
