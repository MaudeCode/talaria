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

async function setup() {
  const sidecar = new FakeSidecar(), fixture = groupFixture(sidecar)
  server = await bootTestServer({ sidecar, deps: (deps) => { deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true }, { name: 'helper' }]) } })
  const scope = server.deps.groups.scope('default', 'local-owner')
  const catalogIdentity = (await server.deps.groups.catalog(scope)).identity
  return { sidecar, ...fixture, scope, catalogIdentity }
}
const post = (identity: string | null, operation: unknown) => server!.get('/api/groups/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, operation }) })
const read = async () => await (await server!.get('/api/groups/view?room_id=discussion')).json() as GroupView

it('projects ordered attributed replies, current member phases and native task fences', async () => {
  const { state, append, members } = await setup()
  append('message.user', 'Review this')
  append('message.member', 'One', members[0]); append('message.member', 'Two', members[1])
  state.driver_status.working = true
  state.driver_status.member_activity = [{ member_id: 'one', status: 'queued' }, { member_id: 'two', status: 'running' }]
  state.driver_status.pending_actions = [{ kind: 'approval', member_id: 'two', task_id: 'task', execution_generation: 3, request_id: 'approval', approval: { command: 'synthetic-command', choices: ['once', 'deny'] } }]
  const view = await read()
  expect(view.rows.map((r) => [r.index, r.author, r.message.content])).toEqual([[1, '', 'Review this'], [2, 'Writer', 'One'], [3, 'Reviewer', 'Two']])
  expect(view.room?.members.map((m) => m.phase)).toEqual(['queued', 'approval'])
  const stale = await post(view.room!.identity, { action: 'approve', room_id: 'discussion', member_id: 'two', task_id: 'task', execution_generation: 2, request_id: 'approval', choice: 'once' })
  expect(stale.status).toBe(409)
  const accepted = await post(view.room!.identity, { action: 'approve', room_id: 'discussion', member_id: 'two', task_id: 'task', execution_generation: 3, request_id: 'approval', choice: 'once' })
  expect(await accepted.json()).toMatchObject({ outcome: 'confirmed' })
  expect((await post(view.room!.identity, { action: 'approve', room_id: 'discussion', member_id: 'two', task_id: 'task', execution_generation: 3, request_id: 'approval', choice: 'once' })).status).toBe(409)
  Reflect.deleteProperty(state.driver_status, 'member_activity')
  expect((await read()).room?.members.map((m) => m.phase)).toEqual(['unknown', 'unknown'])
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
    expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'log')).toHaveLength(2)
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
