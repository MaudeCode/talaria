import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { groupFixture } from '../test/group-fixture.js'
import { Groups } from '../sessions/groups.js'
import type { GroupView } from '@maudecode/talaria-web-contracts'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it('advertises unavailable rooms without a sidecar or starting any native gateway', async () => {
  server = await bootTestServer({ sidecar: null })
  const response = await server.get('/api/groups')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ available: false, rooms: [], profiles: [], actions: [] })
  expect(server.deps.registry.activeRuns.size).toBe(0)
})

async function setup(now?: () => number) {
  const sidecar = new FakeSidecar(), fixture = groupFixture(sidecar)
  server = await bootTestServer({ sidecar, ...(now ? { now } : {}), deps: (deps) => { deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true }, { name: 'helper' }]) } })
  const scope = server.deps.groups.scope('default', 'local-owner')
  const catalogIdentity = (await server.deps.groups.catalog(scope)).identity
  return { sidecar, ...fixture, scope, catalogIdentity }
}
const post = (identity: string | null, operation: unknown) => server!.get('/api/groups/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, operation }) })
const read = async () => await (await server!.get('/api/groups/view?room_id=discussion')).json() as GroupView

it('refuses replies outside the room log before writing and accepts threads beyond the display page', async () => {
  const { state, append, members, sidecar } = await setup()
  append('message.user', 'Legacy message')
  const source = append('message.member', 'Earlier thread', members[1])
  Object.assign(source.payload, { thread_id: 'earlier-thread' })
  // Thread validation must reach beyond the display page.
  for (let n = 0; n < 110; n++) append('message.user', `Later ${n}`)
  const identity = (await read()).room!.identity
  const sends = () => sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')
  const before = state.events.length
  expect(await (await post(identity, { action: 'send', room_id: 'discussion', event_id: 'invalid-target', payload: { text: 'Follow-up', thread_id: 'missing-thread' } })).json()).toMatchObject({ outcome: 'refused' })
  expect(sends()).toHaveLength(0)
  expect(state.events).toHaveLength(before)
  expect(await (await post(identity, { action: 'send', room_id: 'discussion', event_id: 'reply', payload: { text: 'Follow-up', thread_id: 'earlier-thread' } })).json()).toMatchObject({ outcome: 'confirmed' })
  expect(sends()).toHaveLength(1)
  expect(sends()[0]?.params).toMatchObject({ operation: { payload: { thread_id: 'earlier-thread' } } })
})

it('projects ordered attributed replies, current member phases and native task fences', async () => {
  const { state, append, members } = await setup()
  append('message.user', 'Review this')
  const reply = append('message.member', 'One', members[0]); append('message.member', 'Two', members[1])
  Object.assign(reply.payload, { thread_id: 'existing-thread' })
  state.driver_status.working = true
  state.driver_status.member_activity = [{ member_id: 'one', status: 'queued' }, { member_id: 'two', status: 'running' }]
  state.driver_status.pending_actions = [{ kind: 'approval', member_id: 'two', task_id: 'task', execution_generation: 3, request_id: 'approval', approval: { command: 'synthetic-command', choices: ['once', 'deny'] } }]
  const view = await read()
  expect(view.rows.map((r) => [r.index, r.author, r.message.content])).toEqual([[1, '', 'Review this'], [2, 'Writer', 'One'], [3, 'Reviewer', 'Two']])
  expect(view.rows).toMatchObject([{ thread_id: null }, { thread_id: 'existing-thread' }, { thread_id: null }])
  expect(view.room?.members.map((m) => m.phase)).toEqual(['queued', 'approval'])
  expect(view.room).toMatchObject({ round: null, members: [{ tool: null, started_at: null, stalled: false }, { tool: null, started_at: null, stalled: false }] })
  const stale = await post(view.room!.identity, { action: 'approve', room_id: 'discussion', member_id: 'two', task_id: 'task', execution_generation: 2, request_id: 'approval', choice: 'once' })
  expect(stale.status).toBe(409)
  const accepted = await post(view.room!.identity, { action: 'approve', room_id: 'discussion', member_id: 'two', task_id: 'task', execution_generation: 3, request_id: 'approval', choice: 'once' })
  expect(await accepted.json()).toMatchObject({ outcome: 'confirmed' })
  expect((await post(view.room!.identity, { action: 'approve', room_id: 'discussion', member_id: 'two', task_id: 'task', execution_generation: 3, request_id: 'approval', choice: 'once' })).status).toBe(409)
  Reflect.deleteProperty(state.driver_status, 'member_activity')
  expect((await read()).room?.members.map((m) => m.phase)).toEqual(['unknown', 'unknown'])
})

it('projects live member tools and elapsed origins, with stall detection on the server clock', async () => {
  const { state } = await setup(() => 1000)
  const secret = `sk-${'a'.repeat(40)}`
  state.driver_status.member_activity = [{ member_id: 'one', status: 'running', started_at: 800, progress_at: 881, tool: `terminal ${secret}` }, { member_id: 'two', status: 'queued', started_at: 800 }]
  expect((await read()).room).toMatchObject({ members: [{ started_at: 800, stalled: false }, { tool: null, started_at: null, stalled: false }] })
  expect((await read()).room?.members[0]?.tool).toContain('terminal')
  expect(JSON.stringify((await read()).room)).not.toContain(secret)
  state.driver_status.member_activity[0]!.progress_at = 879
  expect((await read()).room).toMatchObject({ members: [{ stalled: true }, { stalled: false }] })
  // A fresh retry has no previous attempt's progress; use its new start, then mark a quiet start stalled.
  state.driver_status.member_activity[0] = { member_id: 'one', status: 'running', started_at: 990 }
  expect((await read()).room?.members[0]).toMatchObject({ tool: null, started_at: 990, stalled: false })
  state.driver_status.member_activity[0].started_at = 879
  expect((await read()).room?.members[0]).toMatchObject({ stalled: true })
  state.driver_status.member_activity[0] = { member_id: 'one', status: 'running', tool: null, started_at: null, progress_at: null }
  expect((await read()).room?.members[0]).toMatchObject({ tool: null, started_at: null, stalled: false })
})

it('projects the running task round in its owning thread, with no guess for older Agents', async () => {
  const { state, append } = await setup()
  const older = append('message.user', 'Earlier thread'), newest = append('message.user', 'Newest thread')
  Object.assign(older.payload, { thread_id: 'older' }); Object.assign(newest.payload, { thread_id: 'newest' })
  state.driver_status.max_rounds = 3
  state.driver_status.member_activity = [{ member_id: 'one', status: 'running', thread_id: 'older', round_index: 2 }, { member_id: 'two', status: 'running', thread_id: 'newest', round_index: 1 }]
  expect((await read()).room).toMatchObject({ round: { current: 2, max: 3 } })
  state.driver_status.member_activity[1]!.status = 'queued'
  expect((await read()).room).toMatchObject({ round: { current: 3, max: 3 } })
  delete state.driver_status.member_activity[0]!.round_index
  expect((await read()).room).toMatchObject({ round: null })
  state.driver_status.member_activity[0]!.round_index = 0
  state.driver_status.max_rounds = null
  expect((await read()).room).toMatchObject({ round: null })
  state.driver_status.max_rounds = 3
  state.driver_status.member_activity[0]!.status = 'queued'
  expect((await read()).room).toMatchObject({ round: null })
})

it('keeps a stalled room usable: shows the wake failure and offers the room-level Retry (Agent v0.22.6)', async () => {
  const { state, append, stall, sidecar } = await setup()
  append('message.user', 'Review this')
  stall('Members could not be woken: profile helper not found')
  state.driver_status.pending_actions.push({ kind: 'mystery' }, { kind: 'retry', member_id: 'not a member id', task_id: 'task', execution_generation: 1 })
  const opened = await server!.get('/api/groups/view?room_id=discussion')
  expect(opened.status).toBe(200)
  const view = await opened.json() as GroupView
  expect(view.rows.map((r) => [r.message.role, r.message._notice_kind, r.message.content])).toEqual([['user', undefined, 'Review this'], ['assistant', 'wake_failed', 'Members could not be woken: profile helper not found']])
  expect(view.room?.retry_task).toEqual({ member_id: 'discussion', task_id: 'prepare:discussion', execution_generation: 1 })
  expect(view.room?.members.map((m) => m.actions)).toEqual([[], []])
  sidecar.calls.length = 0
  const retried = await post(view.room!.identity, { action: 'retry', room_id: 'discussion', ...view.room!.retry_task })
  expect(await retried.json()).toMatchObject({ outcome: 'confirmed' })
  expect(sidecar.calls.map((c) => (c.params as { operation: { action: string } }).operation).filter((o) => o.action === 'retry')).toEqual([{ action: 'retry', room_id: 'discussion', member_id: 'discussion', task_id: 'prepare:discussion', execution_generation: 1 }])
  expect((await read()).room?.retry_task).toBeNull()
  expect((await post(view.room!.identity, { action: 'retry', room_id: 'discussion', ...view.room!.retry_task })).status).toBe(409)
  expect(await (await post(view.room!.identity, { action: 'stop', room_id: 'discussion', cancel_id: 'stop' })).json()).toMatchObject({ outcome: 'refused' })
})

it('attributes a scheduled job\'s post and failure notice to the job, never to the user (Agent v0.22.7)', async () => {
  const { append, scheduled } = await setup()
  const secret = `sk-${'a'.repeat(40)}`
  scheduled({ kind: 'user', id: 'cron:job42', display_name: 'Nightly' }, 'Report ready')
  scheduled({ kind: 'user', id: 'cron-notice:job42', display_name: 'Nightly' }, 'Job failed')
  scheduled({ kind: 'user', id: 'cron:job43' }, 'Unnamed')
  scheduled({ kind: 'user', id: 'cron:job44', display_name: `Nightly ${secret}` }, 'Redacted')
  scheduled({ kind: 'user', id: 'desktop', display_name: 'Nightly' }, 'Typed by a person')
  append('message.user', 'Typed by me')
  const rows = (await read()).rows
  expect(rows.slice(0, 3).map((r) => [r.message.role, r.author, r.scheduled, r.message.content])).toEqual([
    ['assistant', 'Nightly', true, 'Report ready'],
    ['assistant', 'Nightly', true, 'Job failed'],
    ['assistant', 'job43', true, 'Unnamed'],
  ])
  expect(rows[3]!.author).toContain('Nightly')
  expect(rows[3]!.author).not.toContain(secret)
  expect(rows.slice(4).map((r) => [r.message.role, r.author, r.scheduled])).toEqual([['user', '', false], ['user', '', false]])
})

it('projects a lead room\'s settings and who its lead assigned (Agent v0.22.7)', async () => {
  const { state, assignment, append } = await setup()
  state.context = { purpose: 'Ship it', notes: 'Shared notes', routing: 'lead', lead_member_id: 'one' }
  // An everyone-routed settings event carries an empty lead: it stays hidden and leaves the log readable.
  state.events.push({ room_id: 'discussion', seq: 1, event_id: 'settings', kind: 'room.context_set', authority_epoch: 1, actor: { kind: 'system', id: 'room-control' }, payload: { purpose: '', notes: '', routing: 'everyone', lead_member_id: '' }, created_at: 1001 })
  state.room.latest_seq = 1
  assignment('one', ['two'])
  assignment('one', ['one', 'two'])
  assignment('one', ['one'], true)
  assignment('one', ['one'])
  assignment('one', ['foreign'])
  append('message.member', 'Taken')
  const view = await read()
  expect(view.room).toMatchObject({ context: { purpose: 'Ship it', notes: 'Shared notes', routing: 'lead', lead_member_id: 'one' }, purpose_limit: 500, notes_limit_bytes: 4096 })
  expect(view.room?.actions).toContain('context')
  expect(view.room?.members.map((m) => m.lead)).toEqual([true, false])
  expect(view.rows.map((r) => [r.author, r.message._notice_kind, r.message._lead_assignment])).toEqual([
    ['', 'lead_assigned', { lead: 'Writer', assignees: ['Reviewer'] }],
    ['', 'lead_assigned', { lead: 'Writer', assignees: ['Writer', 'Reviewer'] }],
    ['', 'lead_assigned', { lead: 'Writer', assignees: [] }],
    ['', 'lead_assigned', { lead: 'Writer', assignees: [] }],
    ['Writer', undefined, undefined],
  ])
})

it('offers no settings on a gateway without groups.context, or for a routing this contract does not know', async () => {
  const { state } = await setup()
  state.context = { purpose: 'Kept', notes: '', routing: 'lead', lead_member_id: 'one' }
  state.contextOffered = false
  const without = await read()
  expect(without.room?.context).toBeNull()
  expect(without.room?.actions).not.toContain('context')
  expect(without.room?.members.map((m) => m.lead)).toEqual([false, false])
  expect(await (await post(without.room!.identity, { action: 'context', room_id: 'discussion', event_id: 'save', purpose: '', notes: '', routing: 'everyone' })).json()).toMatchObject({ outcome: 'refused', reason: 'unsupported' })
  state.contextOffered = true
  state.context = { purpose: 'Kept', notes: '', routing: 'future-routing', lead_member_id: '' }
  const unknown = await read()
  expect(unknown.available).toBe(true)
  expect(unknown.room?.context).toBeNull()
  expect(unknown.room?.actions).toEqual(['send', 'rename', 'disband'])
})

it.each([
  [undefined, ['everyone', 'lead']],
  [['everyone', 'lead', 'auto'], ['everyone', 'lead', 'auto']],
  [['auto', 'future-routing', 'everyone'], ['auto', 'everyone']],
  [[], []],
])('offers the driver routing modes %j, with the legacy default only when absent', async (native, offered) => {
  const { state } = await setup()
  state.driver_status.routing_modes = native
  const view = await read()
  expect(view.room?.routing_modes).toEqual(offered)
  const response = await post(view.room!.identity, { action: 'context', room_id: 'discussion', event_id: 'automatic', purpose: '', notes: '', routing: 'auto' })
  expect(await response.json()).toMatchObject({ outcome: offered?.includes('auto') ? 'confirmed' : 'refused' })
})

it('keeps Desktop auto settings readable without an advertised routing mode', async () => {
  const { state } = await setup()
  state.context = { purpose: 'Desktop purpose', notes: 'Kept', routing: 'auto', lead_member_id: '' }
  const view = await read()
  expect(view.room?.context).toEqual(state.context)
  expect(view.room?.actions).toContain('context')
  expect(view.room?.members.map((m) => m.lead)).toEqual([false, false])
  expect(await (await post(view.room!.identity, { action: 'context', room_id: 'discussion', event_id: 'preserve-auto', purpose: 'Edited', notes: 'Kept', routing: 'auto' })).json()).toMatchObject({ outcome: 'confirmed' })
})

it('projects automatic picks as resolved notices, hiding everyone, fallback and invalid picks', async () => {
  const { gateway, append, members } = await setup()
  gateway('room.routed', { member_ids: ['two', 'one'], everyone: false, fallback: false })
  gateway('room.routed', { member_ids: ['one', 'two'], everyone: true, fallback: false })
  gateway('room.routed', { member_ids: ['one', 'two'], everyone: false, fallback: true })
  gateway('room.routed', { member_ids: ['foreign'], everyone: false, fallback: false })
  gateway('room.routed', { member_ids: [], everyone: false, fallback: false })
  const forged = gateway('room.routed', { member_ids: ['one'], everyone: false, fallback: false })
  forged.actor.kind = 'member'
  append('message.member', 'Answer', members[1])
  expect((await read()).rows.map((r) => [r.author, r.message._notice_kind, r.message._lead_assignment])).toEqual([
    ['', 'auto_routed', { lead: null, assignees: ['Reviewer', 'Writer'] }],
    ['Reviewer', undefined, undefined],
  ])
})

it('reconciles a lost settings save, retries one event_id and never writes twice', async () => {
  const { state, sidecar } = await setup()
  const view = await read()
  const save = (event_id: string, fields = {}) => post(view.room!.identity, { action: 'context', room_id: 'discussion', event_id, purpose: 'Ship it', notes: 'Shared', routing: 'lead', lead_member_id: 'two', ...fields })
  const contextEvents = () => state.events.filter((e) => e.kind === 'room.context_set').length
  const forwarded = () => sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'context').map((c) => (c.params as { operation: unknown }).operation)

  state.lostContext = 'after'
  expect(await (await save('committed')).json()).toMatchObject({ outcome: 'confirmed', event_id: 'committed' })
  expect(contextEvents()).toBe(1)
  expect(forwarded()).toEqual([{ action: 'context', room_id: 'discussion', event_id: 'committed', purpose: 'Ship it', notes: 'Shared', routing: 'lead', lead_member_id: 'two' }])

  state.lostContext = 'before'
  expect(await (await save('lost', { purpose: 'Second' })).json()).toMatchObject({ outcome: 'unknown' })
  expect(contextEvents()).toBe(1)
  state.lostContext = null
  for (let attempt = 0; attempt < 2; attempt++) expect(await (await save('lost', { purpose: 'Second' })).json()).toMatchObject({ outcome: 'confirmed' })
  expect(contextEvents()).toBe(2)
  expect((await read()).room?.context?.purpose).toBe('Second')

  state.refuseContext = true
  expect(await (await save('refused', { purpose: 'Third' })).json()).toMatchObject({ outcome: 'refused' })
  expect((await read()).room?.context?.purpose).toBe('Second')
  state.refuseContext = false
  sidecar.calls.length = 0
  for (const fields of [{ lead_member_id: 'foreign' }, { lead_member_id: undefined }, { purpose: 'x'.repeat(501) }, { notes: 'é'.repeat(2049) }]) expect((await save('invalid', fields)).status).toBe(400)
  expect(forwarded()).toEqual([])
})

it('keeps stored settings text the display masks when a save leaves that text unchanged', async () => {
  const { state } = await setup()
  const secret = `sk-${'a'.repeat(40)}`, purpose = `Rotate ${secret}`, notes = `Key: ${secret}`
  state.context = { purpose, notes, routing: 'everyone', lead_member_id: '' }
  const view = await read()
  const masked = view.room!.context!
  expect(masked.purpose + masked.notes).not.toContain(secret)
  const save = (event_id: string, fields: object) => post(view.room!.identity, { action: 'context', room_id: 'discussion', event_id, purpose: masked.purpose, notes: masked.notes, routing: 'lead', lead_member_id: 'one', ...fields })
  expect(await (await save('lead-only', {})).json()).toMatchObject({ outcome: 'confirmed' })
  expect(state.context).toEqual({ purpose, notes, routing: 'lead', lead_member_id: 'one' })
  expect(await (await save('edited', { notes: 'Rotated' })).json()).toMatchObject({ outcome: 'confirmed' })
  expect(state.context).toEqual({ purpose, notes: 'Rotated', routing: 'lead', lead_member_id: 'one' })
})

const continues = (sidecar: FakeSidecar) => sidecar.calls.flatMap((c) => c.method === 'gateway.groups' ? [(c.params as { operation: { action: string } }).operation] : []).filter((o) => o.action === 'continue')
const pausedRows = (view: GroupView) => view.rows.filter((r) => r.message._notice_kind?.startsWith('paused_')).map((r) => [r.message.message_id, r.message._notice_kind])

it('projects a capped discussion as a notice and a paused entry until Continue, Stop or a newer message in its thread clears it (Agent v0.23.0)', async () => {
  const { discussion, activity, continued, gateway } = await setup()
  const first = discussion('First', 'thread-1')
  const cap = activity(first, 'thread-1').event_id
  let view = await read()
  expect(pausedRows(view)).toEqual([[cap, 'paused_max_rounds']])
  expect(view.paused).toEqual([{ discussion_event_id: first, event_id: cap, cap: 'max_rounds', continues_left: 5, continue_state: 'offered', excerpt: null }])

  // Web opens a new thread per send, so a later message elsewhere leaves the older discussion paused.
  discussion('Other', 'thread-2')
  expect((await read()).paused.map((p) => p.discussion_event_id)).toEqual([first])

  continued(first, 'thread-1')
  view = await read()
  expect(view.paused).toEqual([])
  expect(pausedRows(view)).toEqual([])

  // Capped again: the Continue is spent and the budget shows it.
  const second = activity(first, 'thread-1', 'max_messages').event_id
  view = await read()
  expect(view.paused).toEqual([{ discussion_event_id: first, event_id: second, cap: 'max_messages', continues_left: 4, continue_state: 'offered', excerpt: null }])
  expect(pausedRows(view)).toEqual([[second, 'paused_max_messages']])

  discussion('Follow up', 'thread-1')
  expect((await read()).paused).toEqual([])

  // A newer message already superseded this discussion, so its late cap is no pause: the Agent is working on the newer one.
  const superseded = discussion('Superseded', 'thread-2')
  discussion('Newer', 'thread-2')
  activity(superseded, 'thread-2')
  expect((await read()).paused).toEqual([])

  const fenced = discussion('Fenced', 'thread-3')
  gateway('room.stop_requested', { cancel_id: 'stop' })
  // A cap noted from a snapshot older than the Stop stays fenced; a discussion after the Stop is unaffected.
  activity(fenced, 'thread-3')
  const after = discussion('After stop', 'thread-4')
  const afterCap = activity(after, 'thread-4').event_id
  view = await read()
  expect(view.paused.map((p) => p.discussion_event_id)).toEqual([after])
  expect(pausedRows(view)).toEqual([[afterCap, 'paused_max_rounds']])

  gateway('room.stop_requested', { cancel_id: 'stop-2' })
  expect((await read()).paused).toEqual([])
})

it('keeps a settled discussion quiet and counts a pause and its Continues beyond the display window', async () => {
  const { discussion, activity, continued, append } = await setup()
  const settled = discussion('Settled', 'thread-0')
  activity(settled, 'thread-0', 'all_replied', 'settled')
  const ask = discussion('Long ago', 'thread-1')
  activity(ask, 'thread-1'); continued(ask, 'thread-1')
  const cap = activity(ask, 'thread-1').event_id
  for (let i = 0; i < 300; i++) append('message.member', `Reply ${i}`)
  const view = await read()
  expect(pausedRows(view)).toEqual([])
  expect(view.paused).toEqual([{ discussion_event_id: ask, event_id: cap, cap: 'max_rounds', continues_left: 4, continue_state: 'offered', excerpt: null }])

  // Several paused discussions are told apart by their own redacted, shortened opening message.
  const secret = `sk-${'a'.repeat(40)}`
  const another = discussion(`Token ${secret} and a good deal more text after it`, 'thread-2')
  activity(another, 'thread-2')
  const excerpts = (await read()).paused.map((p) => p.excerpt)
  expect(excerpts[0]).toBe('Long ago')
  expect(excerpts[1]).toMatch(/^Token .{1,40}…$/u)
  expect(excerpts[1]).not.toContain(secret)
})

it('offers Continue only with a gateway that declares it, budget left and no Stop pending, and refuses anything else unsent', async () => {
  const { state, discussion, activity, continued, sidecar } = await setup()
  const ask = discussion('Ask', 'thread')
  activity(ask, 'thread')
  const operation = { action: 'continue', room_id: 'discussion', discussion_event_id: ask }
  const refused = async (continueState: string) => {
    const view = await read()
    expect(view.paused[0]?.continue_state).toBe(continueState)
    expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'refused' })
    expect(continues(sidecar)).toEqual([])
  }
  state.driver_status.member_activity = [{ member_id: 'one', status: 'stopping' }]
  await refused('stop_pending')
  state.driver_status.member_activity = []
  state.continueMethod = false
  await refused('none')
  state.continueMethod = true
  state.driver_status.max_continues = undefined
  await refused('none')
  state.driver_status.max_continues = 1
  continued(ask, 'thread'); activity(ask, 'thread')
  await refused('none')
  expect((await read()).paused[0]?.continues_left).toBe(0)
  state.driver_status.running = false
  state.driver_status.max_continues = 5
  await refused('none')
})

it('continues a paused discussion once, with only its declared fields and a matching receipt', async () => {
  const { state, discussion, activity, sidecar } = await setup()
  const ask = discussion('Ask', 'thread')
  const cap = activity(ask, 'thread')
  const operation = { action: 'continue', room_id: 'discussion', discussion_event_id: ask }
  const view = await read()
  const native = sidecar.responderFor('gateway.groups')!
  sidecar.respond('gateway.groups', (params, emit, options) => params.operation.action === 'continue' ? { state: 'available', reason: null, value: { continued: true, event: { ...cap, kind: 'room.continued', payload: { discussion_event_id: 'another' } } } } : native(params, emit, options))
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'unknown' })
  sidecar.respond('gateway.groups', native)
  state.refuseContinue = true
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'refused' })
  expect((await read()).paused).toHaveLength(1)
  state.refuseContinue = false
  sidecar.calls.length = 0
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'confirmed' })
  expect(continues(sidecar)).toEqual([operation])
  expect((await read()).paused).toEqual([])
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'refused' })
  expect(continues(sidecar)).toEqual([operation])
})

it('reads the log for the grant after a lost Continue response and never grants again', async () => {
  const { state, discussion, activity, sidecar } = await setup()
  const ask = discussion('Ask', 'thread')
  activity(ask, 'thread')
  const operation = { action: 'continue', room_id: 'discussion', discussion_event_id: ask }
  const view = await read()
  state.lostContinue = 'dropped'
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'unknown' })
  expect((await read()).paused).toHaveLength(1)
  state.lostContinue = 'applied'
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'confirmed' })
  expect(continues(sidecar)).toHaveLength(2)
  expect(await (await post(view.room!.identity, operation)).json()).toMatchObject({ outcome: 'refused' })
  expect(continues(sidecar)).toHaveLength(2)
})

it('refuses foreign members, source attribution and stale room identities', async () => {
  const { append, state, catalogIdentity } = await setup()
  append('message.member', 'Forged', { member_id: 'one', profile: 'foreign', handle: 'one', display_name: 'Bad' })
  expect((await read()).rows).toEqual([])
  const creation = await post(catalogIdentity, { action: 'create', room_id: 'other', name: 'Other', members: [{ member_id: 'one', handle: 'one', profile: 'default' }, { member_id: 'two', handle: 'two', profile: 'foreign' }] })
  expect(creation.status).toBe(400)
  const view = await read()
  state.room.authority_epoch++
  expect((await post(view.room!.identity, { action: 'stop', room_id: 'discussion', cancel_id: 'stop' })).status).toBe(409)
})

it('refuses creation against a different profile catalog identity', async () => {
  await setup()
  const response = await post('another-profile', { action: 'create', room_id: 'other', name: 'Other', members: [{ member_id: 'one', handle: 'one', profile: 'default' }, { member_id: 'two', handle: 'two', profile: 'helper' }] })
  expect(response.status).toBe(409)
  expect((await read()).room?.id).toBe('discussion')
})

it('reconciles response-lost sends without sending again', async () => {
  const { state, sidecar } = await setup()
  state.lostSend = true
  const view = await read()
  const result = await post(view.room!.identity, { action: 'send', room_id: 'discussion', event_id: 'request', payload: { text: 'Send once' } })
  expect(await result.json()).toMatchObject({ outcome: 'confirmed' })
  const receipt = await server!.get('/api/groups/receipt?room_id=discussion&request_id=request')
  expect(await receipt.json()).toMatchObject({ outcome: 'confirmed' })
  expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')).toHaveLength(1)
})

it('pages server-ordered history and advertises no actions for an inactive driver', async () => {
  const { state, append } = await setup()
  for (let i = 0; i < 130; i++) append('message.member', `Reply ${i}`)
  const latest = await read()
  expect(latest.rows).toHaveLength(100)
  expect(latest.rows[0]?.index).toBe(31)
  expect(latest.has_more).toBe(true)
  const earlier = await (await server!.get('/api/groups/view?room_id=discussion&before_seq=31')).json() as GroupView
  expect(earlier.rows.map((r) => r.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
  state.driver = false
  expect(await (await server!.get('/api/groups')).json()).toMatchObject({ available: false, actions: [], profiles: [] })
})

it('provides an older-page cursor when the newest window contains only room metadata', async () => {
  const { append } = await setup()
  append('message.member', 'Retained earlier reply')
  for (let i = 0; i < 100; i++) append('room.activity', '')
  const latest = await read() as GroupView & { next_before_seq?: number }
  expect(latest.rows).toEqual([])
  expect(latest.has_more).toBe(true)
  expect(latest.next_before_seq).toBe(2)
  const earlier = await (await server!.get(`/api/groups/view?room_id=discussion&before_seq=${latest.next_before_seq}`)).json() as GroupView
  expect(earlier.rows.map((r) => r.message.content)).toEqual(['Retained earlier reply'])
})

it('checks attachment digest and room identity before authenticated byte delivery', async () => {
  await setup()
  const view = await read()
  const upload = await server!.get('/api/groups/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room_id: 'discussion', identity: view.room!.identity, upload_id: 'upload', name: 'note.txt', mime: 'text/plain', data_base64: Buffer.from('note').toString('base64') }) })
  expect(await upload.json()).toMatchObject({ outcome: 'confirmed', attachment: { size: 4, kind: 'file', name: 'note.txt' } })
  const file = `/api/groups/file?room_id=discussion&event_id=committed&attachment_id=att_fixture&identity=${view.room!.identity}`
  const response = await server!.get(file)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('note')
  expect(response.headers.get('content-disposition')).toContain('attachment')
  expect((await server!.get(file.replace(view.room!.identity, 'foreign'))).status).toBe(409)
})

it('reuses one observation while viewers exist and releases it after the last detaches', async () => {
  const { scope, sidecar } = await setup()
  const first = server!.deps.groups.watch(scope, 'discussion'), second = server!.deps.groups.watch(scope, 'discussion')
  expect(first.subscriber).not.toBe(second.subscriber)
  await new Promise<void>((resolve) => { first.subscriber.wake = resolve })
  first.release(); second.release()
  await server!.deps.groups.close()
  const count = sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'log').length
  expect(count).toBe(1)
})

it('bounds room observation catch-up and replaces stalled snapshots', async () => {
  const { scope, sidecar, append } = await setup()
  const groups = new Groups(() => server!.deps, 1)
  const viewer = groups.watch(scope, 'discussion')
  try {
    await new Promise<void>((resolve) => { viewer.subscriber.wake = resolve })
    for (let i = 0; i < 1000; i++) append('message.member', `Reply ${i}`)
    await new Promise<void>((resolve) => { viewer.subscriber.wake = resolve })
    expect(viewer.subscriber.queue).toHaveLength(1)
    const latest = viewer.subscriber.queue[0]![1] as GroupView
    expect(latest.rows).toHaveLength(100)
    expect(latest.rows.at(-1)?.message.content).toBe('Reply 999')
    // One tail page per snapshot, plus the first pass over the log for pauses older than the tail.
    expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'log')).toHaveLength(12)
  } finally { viewer.release(); await groups.close() }
})

it('issues the native occurrence identity before dispatch without querying or mutating the owner', async () => {
  const { sidecar } = await setup()
  sidecar.calls.length = 0
  const response = await server!.get('/api/groups/send-identity?request_id=stable-send')
  expect(response.status).toBe(200)
  const identity = await response.json() as { event_id: string }
  expect(sidecar.calls).toHaveLength(0)
  const view = await read()
  await post(view.room!.identity, { action: 'send', room_id: 'discussion', event_id: 'stable-send', payload: { text: 'Occurrence' } })
  expect((await read()).rows[0]!.message.message_id).toBe(identity.event_id)
})

for (const authType of ['trusted', 'oidc'] as const) it(`requires owner authority for multi-profile discussions: ${authType}`, async () => {
  const sidecar = new FakeSidecar()
  groupFixture(sidecar)
  server = await bootTestServer({ sidecar, env: {
    HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_GROUP_PROFILE_MAP: '{}',
    HERMES_WEBUI_OIDC_ISSUER: 'https://identity.invalid', HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
  }, deps: (deps) => {
    deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true }, { name: 'helper' }])
    // External identity proof is the boundary; the request gate and owner policy remain real.
    deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true)
  } })
  const cookie = server.deps.auth.createSession({ authType, username: 'scoped-user', boundProfile: 'default' })
  const headers = { cookie: `${server.deps.auth.cookieName()}=${cookie}`, 'X-Remote-User': 'scoped-user', origin: server.base,
    'X-Hermes-CSRF-Token': server.deps.auth.csrfTokenForSession(cookie)!, 'content-type': 'application/json' }
  sidecar.calls.length = 0
  for (const path of ['/api/groups', '/api/groups/view?room_id=discussion', '/api/groups/receipt?room_id=discussion&request_id=send', '/api/groups/stream?room_id=discussion', '/api/groups/send-identity?request_id=send', '/api/groups/file?room_id=discussion&event_id=event&attachment_id=file']) {
    const response = await server.get(path, { headers })
    expect(response.status, path).toBe(403)
    expect(await response.json()).toEqual({ error: 'Owner session required' })
  }
  for (const path of ['/api/groups/action', '/api/groups/upload']) expect((await server.get(path, { method: 'POST', headers, body: '{}' })).status, path).toBe(403)
  expect(sidecar.calls).toHaveLength(0)
  const owner = server.deps.auth.createSession({ authType: 'password' })
  const response = await server.get('/api/groups', { headers: { cookie: `${server.deps.auth.cookieName()}=${owner}` } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ available: true, profiles: [{ profile: 'default' }, { profile: 'helper' }] })
})
