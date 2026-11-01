import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { SessionSkillsSchema } from './views.js'

it('TAL-1649: publishes server-ordered session skill counts with explicit detail availability', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/session-skills.json', import.meta.url), 'utf8')) as { used: unknown; empty: unknown }
  expect(SessionSkillsSchema.parse(fixture.used).skills.map((s) => [s.name, s.count, s.detail_available])).toEqual([['review', 3, true], ['deploy', 1, true], ['retired', 1, false]])
  expect(SessionSkillsSchema.parse(fixture.empty).skills).toEqual([])
  // A count is a recorded load: zero or fractional uses are not part of the contract.
  expect(SessionSkillsSchema.safeParse({ session_id: 'x', skills: [{ name: 'a', description: null, count: 0, detail_available: false }] }).success).toBe(false)
})
