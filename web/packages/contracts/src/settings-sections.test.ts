import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTION_GROUPS, SettingsSectionSchema } from './settings-sections.js'

describe('SettingsSectionSchema', () => {
  it('matches the shared fixture: the sections in menu order and each one\'s group (TAL-2100)', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/settings-sections.json', import.meta.url), 'utf8')) as { sections: unknown; groups: unknown }
    expect(SettingsSectionSchema.array().parse(fixture.sections)).toEqual(SettingsSectionSchema.options)
    expect(fixture.groups).toEqual(SETTINGS_SECTION_GROUPS)
  })
})
