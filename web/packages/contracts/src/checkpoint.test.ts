import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { CheckpointDiffSchema } from './checkpoint.js'

describe('checkpoint provenance', () => {
  it('preserves the shared native project-baseline fixture', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/native-checkpoint-diff.json', import.meta.url), 'utf8')) as unknown
    expect(CheckpointDiffSchema.parse(fixture)).toEqual(fixture)
  })
})
