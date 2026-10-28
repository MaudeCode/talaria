import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AgentImportResultSchema } from './agent-imports.js'
import { settingsContract } from './routes/settings.js'

it('shares the profile import preview and unavailable results with native consumers', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/agent-imports.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(AgentImportResultSchema.parse(fixture.preview).can_apply).toBe(true)
  expect(AgentImportResultSchema.parse(fixture.unavailable).can_apply).toBe(false)
  expect(settingsContract.profileImport.preview['~orpc'].inputSchema?.parse(fixture.preview_input)).toEqual({ agent: 'cursor' })
  expect(settingsContract.profileImport.apply['~orpc'].inputSchema?.safeParse({ receipt: 'x', profile_home: '/foreign' }).success).toBe(false)
})
