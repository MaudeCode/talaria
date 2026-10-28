import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { DelegationSettingsSchema } from './delegation.js'

it('pins default, unavailable and older-Agent delegation settings for every consumer', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/delegation-settings.json', import.meta.url), 'utf8')) as Record<string, unknown>
  for (const value of Object.values(fixtures)) expect(DelegationSettingsSchema.parse(value)).toEqual(value)
})

it('strips private write-only fields from public route settings', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/delegation-settings.json', import.meta.url), 'utf8')) as { default: Record<string, unknown> }
  const publicState = DelegationSettingsSchema.parse({ ...fixtures.default, model_map: { default: 'one', options: [{ name: 'one', api_key: 'private', original_name: 'old', request_overrides: { Authorization: 'private' } }] } })
  expect(publicState.model_map.options).toEqual([{ name: 'one' }])
})
