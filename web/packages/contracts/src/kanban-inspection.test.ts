import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { KanbanInspectionSchema, KanbanInspectionSnapshotSchema, KanbanTaskSchema, KanbanTaskViewSchema } from './index.js'

it('preserves the shared Kanban inspection producer and consumer fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/kanban-inspection.json', import.meta.url), 'utf8')) as { snapshot: unknown; view: unknown }
  expect(KanbanInspectionSnapshotSchema.parse(fixture.snapshot)).toEqual(fixture.snapshot)
  expect(KanbanInspectionSchema.parse(fixture.view)).toEqual(fixture.view)
})

it('accepts the Agent age object on a sidecar task and the selected age on its board row (TAL-2648)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/kanban-task-age.json', import.meta.url), 'utf8')) as { sidecar_task: unknown; board_task: unknown }
  expect(KanbanTaskSchema.parse(fixture.sidecar_task)).toEqual(fixture.sidecar_task)
  expect(KanbanTaskViewSchema.parse(fixture.board_task)).toEqual(fixture.board_task)
})
