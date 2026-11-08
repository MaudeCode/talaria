import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SettingsSectionSchema } from './settings-sections.js'

describe('SettingsSectionSchema', () => {
  it('matches the shared fixture, in menu order', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/settings-sections.json', import.meta.url), 'utf8')) as { sections: unknown }
    expect(SettingsSectionSchema.array().parse(fixture.sections)).toEqual(SettingsSectionSchema.options)
  })
})
