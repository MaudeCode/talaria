import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { GroupCatalogSchema, GroupOperationSchema, GroupViewSchema } from './groups.js'

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/native-groups.json'), 'utf8')) as { catalog: unknown; view: unknown; inactive: unknown }
it('pins the shared discussion projection for independently delivered clients', () => {
  expect(GroupCatalogSchema.parse(fixture.catalog).profiles.map((p) => p.profile)).toEqual(['default', 'helper'])
  const view = GroupViewSchema.parse(fixture.view)
  expect(view.rows.map((r) => [r.author, r.scheduled])).toEqual([['', false], ['Writer', false], ['Reviewer', false], ['Nightly', true], ['', false], ['', false], ['', false]])
  expect(view.rows.at(-3)?.message).toMatchObject({ _notice_kind: 'lead_assigned', _lead_assignment: { lead: 'Writer', assignees: ['Reviewer'] } })
  expect(view.room?.routing_modes).toEqual(['everyone', 'lead', 'auto'])
  expect(view.rows.at(-2)?.message).toMatchObject({ _notice_kind: 'auto_routed', _lead_assignment: { lead: null, assignees: ['Reviewer'] } })
  expect(view.room?.context).toMatchObject({ routing: 'lead', lead_member_id: 'one' })
  expect(view.room?.members.map((m) => m.lead)).toEqual([true, false])
  expect(view.rows.at(-1)?.message._notice_kind).toBe('paused_max_rounds')
  expect(view.paused).toEqual([{ discussion_event_id: 'event-1', event_id: view.rows.at(-1)?.message.message_id, cap: 'max_rounds', continues_left: 5, continue_state: 'offered', excerpt: null }])
  expect(view.room?.members.map((m) => m.phase)).toEqual(['queued', 'running'])
  expect(view.room).toMatchObject({ round: { current: 2, max: 3 }, members: [{ tool: null, started_at: null, stalled: false }, { tool: 'terminal', started_at: 1000, stalled: false }] })
  expect(GroupCatalogSchema.parse(fixture.inactive)).toMatchObject({ available: false, profiles: [], actions: [] })
  expect(JSON.stringify(fixture)).not.toMatch(/profile_home|authority_gateway_id|data_base64/)
})
it('keeps gateway methods closed and recovery bound to a complete native task fence', () => {
  expect(GroupOperationSchema.safeParse({ action: 'session.submit', room_id: 'discussion' }).success).toBe(false)
  expect(GroupOperationSchema.safeParse({ action: 'retry', room_id: 'discussion', task_id: 'task', member_id: 'one' }).success).toBe(false)
  expect(GroupOperationSchema.safeParse({ action: 'approve', room_id: 'discussion', task_id: 'task', member_id: 'one', execution_generation: 1, request_id: 'approval', choice: 'always' }).success).toBe(false)
})
