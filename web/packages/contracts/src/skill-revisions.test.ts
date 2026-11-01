import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SkillRevisionsInputSchema, SkillRevisionsSchema } from './sidecar/namespaces.js'

it('shares immutable, bounded read-only revision fixtures with consumers', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/skill-revisions.json'), 'utf8')) as Record<string, unknown>
  const value = SkillRevisionsSchema.parse(fixture)
  expect(value.selected?.revision).toBe(value.revisions[0]!.id)
  expect(value.comparison?.from_revision).toBe(value.revisions[1]!.id)
  expect(value.replay_available).toBe(true)
  expect(SkillRevisionsSchema.safeParse({ ...fixture, replay_available: 'yes' }).success).toBe(false)
  expect(SkillRevisionsSchema.safeParse({ ...fixture, revisions: Array(65).fill(value.revisions[0]) }).success).toBe(false)
  expect(SkillRevisionsInputSchema.safeParse({ name: 'demo', revision: '../foreign' }).success).toBe(false)
})
