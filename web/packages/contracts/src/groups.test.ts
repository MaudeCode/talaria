import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { GroupCatalogSchema, GroupOperationSchema, GroupViewSchema } from './groups.js'

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/native-groups.json'), 'utf8')) as { catalog: unknown; view: unknown; inactive: unknown }
it('pins the shared discussion projection for independently delivered clients', () => {
  expect(GroupCatalogSchema.parse(fixture.catalog).profiles.map((p) => p.profile)).toEqual(['default', 'helper'])
  const view = GroupViewSchema.parse(fixture.view)
  expect(view.rows.map((r) => r.author)).toEqual(['', 'Writer', 'Reviewer'])
  expect(view.room?.members.map((m) => m.phase)).toEqual(['queued', 'running'])
  expect(GroupCatalogSchema.parse(fixture.inactive)).toMatchObject({ available: false, profiles: [], actions: [] })
  expect(JSON.stringify(fixture)).not.toMatch(/profile_home|authority_gateway_id|data_base64/)
})
it('keeps gateway methods closed and recovery bound to a complete native task fence', () => {
  expect(GroupOperationSchema.safeParse({ action: 'session.submit', room_id: 'discussion' }).success).toBe(false)
  expect(GroupOperationSchema.safeParse({ action: 'retry', room_id: 'discussion', task_id: 'task', member_id: 'one' }).success).toBe(false)
  expect(GroupOperationSchema.safeParse({ action: 'approve', room_id: 'discussion', task_id: 'task', member_id: 'one', execution_generation: 1, request_id: 'approval', choice: 'always' }).success).toBe(false)
})
