import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AgentImportResultSchema } from './agent-imports.js'
import { settingsContract } from './routes/settings.js'

it('shares the profile import preview and unavailable results with native consumers', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/agent-imports.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(AgentImportResultSchema.parse(fixture.preview).can_apply).toBe(true)
  expect(AgentImportResultSchema.parse(fixture.unavailable).can_apply).toBe(false)
  expect(AgentImportResultSchema.parse(fixture.config_unavailable).catalog_required).toBe(false)
  expect(settingsContract.profileImport.preview['~orpc'].inputSchema?.parse(fixture.preview_input)).toEqual({ agent: 'cursor' })
  const input = settingsContract.profileImport.preview['~orpc'].inputSchema
  expect(input?.parse(fixture.grok_preview_input)).toEqual(fixture.grok_preview_input)
  expect(input?.safeParse({ agent: 'grok-bot' }).success).toBe(false)
  expect(input?.safeParse({ agent: 'cursor', export_text: '{}' }).success).toBe(false)
  expect(AgentImportResultSchema.parse(fixture.discover).sources.map((row) => [row.agent, row.available, row.input])).toEqual([['cursor', true, 'none'], ['grok-bot', true, 'file'], ['openbot', false, 'none']])
  expect(settingsContract.profileImport.apply['~orpc'].inputSchema?.safeParse({ receipt: 'x', profile_home: '/foreign' }).success).toBe(false)
})
