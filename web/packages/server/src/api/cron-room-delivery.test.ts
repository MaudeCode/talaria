import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { groupFixture } from '../test/group-fixture.js'
import { CronsSchema, CronMutationSchema } from '@maudecode/talaria-web-contracts'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

async function setup(authenticated = false) {
  const sidecar = new FakeSidecar(), fixture = groupFixture(sidecar)
  let supported = true
  sidecar.respond('cron.delivery_options', () => ({ platforms: [{ value: 'local', label: 'Local' }], room_delivery_supported: supported }))
  server = await bootTestServer({ sidecar, ...(authenticated ? { env: {
    HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_GROUP_PROFILE_MAP: '{}',
    HERMES_WEBUI_OIDC_ISSUER: 'https://identity.invalid', HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
  } } : {}), deps: (deps) => {
    deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true }, { name: 'helper' }])
    deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true)
  } })
  return { sidecar, ...fixture, support: (value: boolean) => { supported = value } }
}
const options = async () => (await (await server!.get('/api/crons/delivery-options')).json() as { platforms: { value: string; label: string }[] }).platforms
const read = async () => CronsSchema.parse(await (await server!.get('/api/crons')).json())

it('offers manageable rooms by name in the requesting profile, only with Agent and room support', async () => {
  const { state, support } = await setup()
  expect(await options()).toEqual([{ value: 'local', label: 'Local' }, { value: 'room:discussion', label: 'Design review' }])
  const named = await server!.deps.requestScope.run({ requestProfile: 'helper', notificationOwner: 'named-owner' }, () => server!.deps.crons.deliveryOptions(server!.deps.profileHome('helper')))
  expect(named.platforms).toContainEqual({ value: 'room:discussion@helper', label: 'Design review' })
  state.available = false
  expect(await options()).toEqual([{ value: 'local', label: 'Local' }])
  state.available = true
  support(false)
  expect(await options()).toEqual([{ value: 'local', label: 'Local' }])
  support(true)
  state.room.members[1]!.profile = 'unmanaged'
  expect(await options()).toEqual([{ value: 'local', label: 'Local' }])
})

it.each(['trusted', 'oidc'] as const)('keeps room catalogs and delivery writes behind owner authority for %s sessions', async (authType) => {
  const { sidecar } = await setup(true)
  const base = { profile: null, toast_notifications: true, monitor: '', continuity: false }
  const jobs = [{ ...base, id: 'room-job', deliver: 'room:discussion' }, { ...base, id: 'local-job', deliver: 'local' }]
  sidecar.respond('cron.list', ({ profile_home }) => ({ jobs: profile_home === server!.deps.profileHome('default') ? jobs : [] }))
  sidecar.respond('cron.get', ({ job_id }) => ({ job: jobs.find((job) => job.id === job_id) ?? null }))
  sidecar.respond('cron.create', ({ job }) => ({ job: { ...base, ...job, id: 'created' } }))
  sidecar.respond('cron.update', ({ job_id, updates }) => ({ job: { ...jobs.find((job) => job.id === job_id)!, ...updates } }))
  sidecar.respond('cron.resume', () => ({ job: jobs[0]! }))
  sidecar.respond('cron.run', ({ job_id }, emit) => { emit({ event: 'started', data: { job_id } }); return { job_id, status: 'completed', success: true } })
  const cookie = server!.deps.auth.createSession({ authType, username: 'scoped-user', boundProfile: 'default' })
  const headers = { cookie: `${server!.deps.auth.cookieName()}=${cookie}`, 'X-Remote-User': 'scoped-user', origin: server!.base,
    'X-Hermes-CSRF-Token': server!.deps.auth.csrfTokenForSession(cookie)!, 'content-type': 'application/json' }
  sidecar.calls.length = 0
  const choices = await server!.get('/api/crons/delivery-options', { headers })
  expect.soft(await choices.json()).toEqual({ platforms: [{ value: 'local', label: 'Local' }] })
  const listed = CronsSchema.parse(await (await server!.get('/api/crons', { headers })).json())
  expect.soft(listed.jobs.find((job) => job.id === 'room-job')?.deliver_label).toBe('room:discussion')
  for (const [path, body] of [
    ['create', { schedule: 'every 1h', prompt: 'Digest', deliver: 'room:discussion' }],
    ['create', { schedule: 'every 1h', prompt: 'Digest', deliver: ['local', 'room:discussion'] }],
    ['update', { job_id: 'local-job', deliver: 'telegram, RoOm:discussion@helper' }],
    ['update', { job_id: 'local-job', deliver: 'telegram,\u001croom:discussion' }],
    ['update', { job_id: 'local-job', failure_deliver: ['local', 'room:discussion'] }],
    ['update', { job_id: 'local-job', deliver: 'origin', origin: { platform: 'room', chat_id: 'discussion' } }],
    ['update', { job_id: 'room-job', prompt: 'Replaced content' }],
    ['resume', { job_id: 'room-job' }], ['run', { job_id: 'room-job' }],
  ] as const) {
    const response = await server!.get(`/api/crons/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    expect.soft(response.status, `${path} ${JSON.stringify(body)}`).toBe(403)
  }
  expect.soft(sidecar.calls.filter((call) => ['gateway.groups', 'cron.create', 'cron.update', 'cron.resume', 'cron.run'].includes(call.method))).toEqual([])
  const local = await server!.get('/api/crons/create', { method: 'POST', headers, body: JSON.stringify({ schedule: 'every 1h', prompt: 'Digest', deliver: 'local' }) })
  expect(local.status).toBe(200)
  const owner = server!.deps.auth.createSession({ authType: 'password' })
  const ownerHeaders = { cookie: `${server!.deps.auth.cookieName()}=${owner}`, origin: server!.base,
    'X-Hermes-CSRF-Token': server!.deps.auth.csrfTokenForSession(owner)!, 'content-type': 'application/json' }
  const allowed = await server!.get('/api/crons/create', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ schedule: 'every 1h', prompt: 'Digest', deliver: 'room:discussion' }) })
  expect(allowed.status).toBe(200)
  expect(CronMutationSchema.parse(await allowed.json()).job?.deliver_label).toBe('Design review')
})

it('projects room names on job reads and writes, preserves unknown targets, and uses the caller grant', async () => {
  const { sidecar, state } = await setup()
  state.room.name = 'Review API_KEY=synthetic-room-secret'
  const base = { profile: null, toast_notifications: true, monitor: '', continuity: false }
  const jobs = ['room:discussion', 'room:missing', 'room:discussion@helper', 'telegram', ''].map((deliver, i) => ({ ...base, id: `job-${i}`, deliver }))
  sidecar.respond('cron.list', ({ profile_home }) => ({ jobs: profile_home === server!.deps.profileHome('default') ? jobs : [] }))
  sidecar.respond('cron.create', () => ({ job: jobs[0]! }))
  const listed = (await read()).jobs
  const labels = new Map(listed.map((job) => [job.id, job.deliver_label]))
  expect(labels.get('job-0')).toMatch(/^Review /)
  expect(labels.get('job-0')).not.toContain('synthetic-room-secret')
  expect(labels.get('job-1')).toBe('room:missing')
  expect(labels.get('job-2')).toBe(labels.get('job-0'))
  expect(labels.get('job-3')).toBe('telegram')
  expect(labels.get('job-4')).toBe('local')
  const created = await server!.get('/api/crons/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schedule: 'every 1h', prompt: 'Digest', deliver: 'room:discussion' }) })
  expect(CronMutationSchema.parse(await created.json()).job?.deliver_label).toBe(labels.get('job-0'))
  sidecar.calls.length = 0
  await server!.deps.requestScope.run({ requestProfile: 'default', notificationOwner: 'named-owner' }, () => server!.deps.crons.deliveryOptions(server!.deps.profileHome('default')))
  const expectedSubject = server!.deps.groups.scope('default', 'named-owner').subject
  expect(sidecar.calls.filter((call) => call.method === 'gateway.groups').map((call) => call.params)).toEqual([
    expect.objectContaining({ subject: expectedSubject }), expect.objectContaining({ subject: expectedSubject }),
  ])
})

it('includes later catalog pages and keeps a foreign or inaccessible target raw', async () => {
  const { sidecar, state } = await setup()
  const original = sidecar.responderFor('gateway.groups')!
  sidecar.respond('gateway.groups', (params, emit, opts) => params.operation.action === 'list'
    ? { state: 'available', reason: null, value: { rooms: [{ ...state.room, room_id: params.operation.offset ? 'later' : 'discussion' }], next_offset: params.operation.offset ? null : 50 } }
    : original(params, emit, opts))
  expect(await options()).toContainEqual({ value: 'room:later', label: 'Design review' })
  const base = { profile: null, toast_notifications: true, monitor: '', continuity: false }
  sidecar.respond('cron.list', ({ profile_home }) => ({ jobs: profile_home === server!.deps.profileHome('default') ? [
    { ...base, id: 'later', deliver: 'room:later' }, { ...base, id: 'foreign', deliver: 'room:discussion@unmanaged' },
  ] : [] }))
  const jobs = (await read()).jobs
  expect(jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'later', deliver_label: 'Design review' }),
    expect.objectContaining({ id: 'foreign', deliver_label: 'room:discussion@unmanaged' }),
  ]))
  state.available = false
  expect((await read()).jobs).toContainEqual(expect.objectContaining({ id: 'later', deliver_label: 'room:later' }))
})
