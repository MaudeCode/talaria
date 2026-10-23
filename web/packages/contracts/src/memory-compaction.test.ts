import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MemoryCompactionRefusalSchema, MemoryCompactionApplySchema, MemoryCompactionPreviewSchema, toolsContract } from './routes/tools.js'

it('shares compaction preview and apply fixtures with native consumers', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/memory-compaction.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(MemoryCompactionPreviewSchema.parse(fixture.preview).proposed).toBe('Prefers concise answers.')
  expect(MemoryCompactionRefusalSchema.parse(fixture.conflict).code).toBe('memory_compaction_conflict')
  expect(MemoryCompactionRefusalSchema.parse(fixture.unavailable).code).toBe('memory_compaction_unavailable')
  expect(MemoryCompactionApplySchema.parse(fixture.applied).ok).toBe(true)
  expect(toolsContract.memory.compactionApply['~orpc'].inputSchema?.parse(fixture.apply)).toEqual(fixture.apply)
})
