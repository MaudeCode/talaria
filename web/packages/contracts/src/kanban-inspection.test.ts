import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { KanbanInspectionSchema, KanbanInspectionSnapshotSchema } from './index.js'

it('preserves the shared Kanban inspection producer and consumer fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/kanban-inspection.json', import.meta.url), 'utf8')) as { snapshot: unknown; view: unknown }
  expect(KanbanInspectionSnapshotSchema.parse(fixture.snapshot)).toEqual(fixture.snapshot)
  expect(KanbanInspectionSchema.parse(fixture.view)).toEqual(fixture.view)
})
