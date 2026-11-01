import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SkillReplayJobSchema, SkillReplayPlanSchema, SkillReplayStartSchema } from './skill-replay.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../../contracts/fixtures/${name}.json`), 'utf8'))

it('shares bounded replay plan and job fixtures with consumers', () => {
  const plan = SkillReplayPlanSchema.parse(fixture('skill-replay-plan'))
  const job = SkillReplayJobSchema.parse(fixture('skill-replay-job'))
  expect(job.revisions.map((row) => row.id)).toEqual(plan.revisions.map((row) => row.id))
  expect(job.cases.map((row) => row.id)).toEqual(plan.cases.map((row) => row.id))
  expect(SkillReplayPlanSchema.safeParse({ ...plan, budget: { ...plan.budget, max_cost_usd: 6 } }).success).toBe(false)
  expect(SkillReplayJobSchema.safeParse({ ...job, revisions: [job.revisions[0]] }).success).toBe(false)
})

it('binds a start request to a stable id, exact identities, a route and a finite budget', () => {
  const plan = SkillReplayPlanSchema.parse(fixture('skill-replay-plan'))
  const start = { request_id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', name: 'demo', baseline: plan.revisions[0]!.id, candidate: plan.revisions[1]!.id, case_ids: plan.cases.map((row) => row.id), route: plan.route, max_cost_usd: 0.5 }
  expect(SkillReplayStartSchema.safeParse(start).success).toBe(true)
  for (const change of [{ request_id: 'retry' }, { baseline: '../foreign' }, { case_ids: [] }, { max_cost_usd: 0 }, { max_cost_usd: 50 }]) expect(SkillReplayStartSchema.safeParse({ ...start, ...change }).success).toBe(false)
})
