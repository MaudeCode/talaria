import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService, jobForApi, type CronDeps } from './crons.js'
import { bootTestServer, freshCronListingsPerTest, type TestServer } from '../test/harness.js'
import { useJsonStorage } from '../test/storage.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import type { Dict } from '../config/agent-config.js'

const states: string[] = []
afterEach(() => { for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true }) })

function setup() {
  const sidecar = new FakeSidecar()
  const state = mkdtempSync(join(tmpdir(), 'talaria-cron-test-'))
  states.push(state)
  const homes = { default: state, research: join(state, 'profiles/research'), hidden: join(state, 'profiles/hidden') }
  const stores = new Map<string, Dict[]>(Object.values(homes).map((home) => [home, []]))
  const deps: CronDeps = {
    sidecar: () => sidecar,
    profileHome: (name) => homes[name as keyof typeof homes],
    profileNames: () => Promise.resolve(Object.keys(homes).map((name) => ({ name, visible: name !== 'hidden' }))),
    profilesMatch: (a, b) => a === b,
    isolatedProfileMode: () => false,
    log: () => undefined,
  }
  sidecar.respond('cron.list', ({ profile_home }) => ({ jobs: stores.get(profile_home) as never[] }))
  sidecar.respond('cron.create', ({ profile_home, job }) => {
    const created = { id: 'new-job', profile: null, toast_notifications: true, monitor: '', continuity: false, ...job }
    stores.get(profile_home)?.push(created)
    return { job: created }
  })
  sidecar.respond('cron.update', ({ profile_home, job_id, updates }) => {
    const job = stores.get(profile_home)?.find((row) => row.id === job_id)
    if (!job) throw new SidecarError('Job not found', { condition: 'not_found' })
    Object.assign(job, updates)
    return { job: job as never }
  })
  sidecar.respond('cron.get', ({ profile_home, job_id }) => ({ job: (stores.get(profile_home)?.find((row) => row.id === job_id) ?? null) as never }))
  sidecar.respond('cron.run', ({ job_id }, emit) => { emit({ event: 'started', data: { job_id } }); return { job_id, status: 'completed', success: true } })
  sidecar.respond('cron.pause', ({ profile_home, job_id }) => ({ job: stores.get(profile_home)?.find((row) => row.id === job_id) as { id: string } }))
  sidecar.respond('cron.resume', ({ profile_home, job_id }) => ({ job: stores.get(profile_home)?.find((row) => row.id === job_id) as { id: string } }))
  sidecar.respond('cron.delete', ({ job_id }) => ({ ok: true, job_id }))
  return { service: new CronService(deps), sidecar, homes, stores, deps }
}

describe('cron store read cost (TAL-1716)', () => {
  afterEach(() => { vi.useRealTimers() })
  const listCalls = (sidecar: FakeSidecar) => sidecar.calls.filter((call) => call.method === 'cron.list').map((call) => call.params as { profile_home: string; probe_store?: boolean })

  it('lists four visible stores concurrently and probes each at most once per five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { service, sidecar, deps, homes } = setup()
    const four = { default: homes.default, research: homes.research, ops: `${homes.default}/profiles/ops`, media: `${homes.default}/profiles/media` }
    deps.profileNames = () => Promise.resolve(Object.keys(four).map((name) => ({ name, visible: true })))
    deps.profileHome = (name) => four[name as keyof typeof four]
    const health = { store: `${homes.default}/cron`, error: 'EROFS', since: 'unknown', fix: 'remount' }
    const held: (() => void)[] = []
    sidecar.respond('cron.list', ({ profile_home, probe_store }) => new Promise((resolve) => {
      held.push(() => { resolve({ jobs: [], ...(probe_store ? { schedule_policy: true, store_health: profile_home === homes.default ? health : null } : {}) }) })
    }))
    const release = async (count: number) => { await new Promise(setImmediate); expect(held).toHaveLength(count); for (const run of held.splice(0)) run() }
    const first = service.list('default', false)
    await release(4)
    await expect(first).resolves.toMatchObject({ schedule_policy_available: true, unwritable_stores: [{ profile: 'default', store: health.store }] })
    expect(listCalls(sidecar).filter((call) => call.probe_store)).toHaveLength(4)

    vi.advanceTimersByTime(5 * 60_000 - 1)
    const memoized = service.list('default', false)
    await release(4)
    await expect(memoized).resolves.toMatchObject({ schedule_policy_available: true, unwritable_stores: [{ profile: 'default', store: health.store }] })
    expect(listCalls(sidecar).filter((call) => call.probe_store)).toHaveLength(4)

    vi.advanceTimersByTime(1)
    const expired = service.list('default', false)
    await release(4)
    await expired
    expect(listCalls(sidecar).filter((call) => call.probe_store)).toHaveLength(8)
  })

  it('shares one probe between concurrent lists of a store', async () => {
    const { service, sidecar } = setup()
    await Promise.all([service.list('default', false), service.list('default', true)])
    const probes = listCalls(sidecar).filter((call) => call.probe_store).map((call) => call.profile_home)
    expect(probes).toEqual([...new Set(probes)])
  })

  it('remembers neither a failed listing nor its probe', async () => {
    const { service, sidecar, homes } = setup()
    const working = sidecar.responderFor('cron.list')!
    sidecar.respond('cron.list', () => { throw new SidecarError('store unreadable', { condition: 'internal' }) })
    await expect(service.list('default', false)).rejects.toThrow('store unreadable')
    sidecar.respond('cron.list', working)
    sidecar.calls.length = 0
    await service.list('default', false)
    expect(listCalls(sidecar)).toContainEqual({ profile_home: homes.default, probe_store: true })
  })

  it.each([
    ['history', (service: CronService, home: string) => service.history(home, 'local-job', undefined, undefined)],
    ['pause', (service: CronService, home: string) => service.pause(home, 'local-job', null)],
  ])('%s of a job in the active store lists only that store', async (_, act) => {
    const { service, sidecar, homes, stores } = setup()
    stores.get(homes.default)?.push({ id: 'local-job', profile: null, toast_notifications: true, monitor: '', continuity: false })
    await act(service, homes.default)
    expect(listCalls(sidecar)).toEqual([{ profile_home: homes.default }])
  })

  it('answers a repeat read within two seconds from the last listing, then lists again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { service, sidecar, homes, stores } = setup()
    await service.list('default', false)
    const initial = listCalls(sidecar).length
    stores.get(homes.default)?.push({ id: 'external', profile: null, toast_notifications: true, monitor: '', continuity: false })
    vi.advanceTimersByTime(1_999)
    expect((await service.list('default', false)).jobs).toEqual([])
    expect(listCalls(sidecar)).toHaveLength(initial)
    vi.advanceTimersByTime(1)
    expect((await service.list('default', false)).jobs).toMatchObject([{ id: 'external' }])
  })

  it('shows a write made here on the very next read', async () => {
    const { service, homes } = setup()
    await service.list('default', false)
    await service.create(homes.default, { schedule: 'every 1h', prompt: 'x' })
    expect((await service.list('default', false)).jobs).toMatchObject([{ id: 'new-job' }])
    await service.update(homes.default, { job_id: 'new-job', name: 'renamed' })
    expect((await service.list('default', false)).jobs).toMatchObject([{ name: 'renamed' }])
  })

  it('offers Stop to the refetch that follows a manual run starting', async () => {
    const { service, sidecar, homes, stores } = setup()
    const job: Dict = { id: 'manual', profile: null, toast_notifications: true, monitor: '', continuity: false }
    stores.get(homes.default)?.push(job)
    sidecar.respond('cron.status', ({ job_id }) => ({ job_id: job_id!, running: false, elapsed: 0 }))
    sidecar.respond('cron.run', ({ job_id }, emit) => new Promise(() => {
      job.live_execution = { id: 'exec-1', stopping: false }
      emit({ event: 'started', data: { job_id } })
    }))
    await service.list('default', false)
    await service.runNow(homes.default, 'manual')
    expect((await service.list('default', false)).jobs).toMatchObject([{ id: 'manual', can_stop: true }])
  })

  it('shows a manual run\'s result to the refetch its completion event triggers', async () => {
    const { service, sidecar, homes, stores, deps } = setup()
    const job: Dict = { id: 'manual', profile: null, toast_notifications: true, monitor: '', continuity: false }
    stores.get(homes.default)?.push(job)
    sidecar.respond('cron.status', ({ job_id }) => ({ job_id: job_id!, running: false, elapsed: 0 }))
    let finish = (): void => undefined
    sidecar.respond('cron.run', ({ job_id }, emit) => new Promise((resolve) => {
      emit({ event: 'started', data: { job_id } })
      finish = () => { job.last_status = 'ok'; resolve({ job_id, status: 'completed', success: true }) }
    }))
    const completed = new Promise<void>((resolve) => { deps.publishSessionsChanged = () => { resolve() } })
    await service.runNow(homes.default, 'manual')
    await service.list('default', false)
    finish()
    await completed
    expect((await service.list('default', false)).jobs).toMatchObject([{ id: 'manual', last_outcome: 'succeeded' }])
  })
})

describe('cross-profile cron ownership', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps recovery-only rows visible but excludes them from new task context', async () => {
    const { service, homes, stores } = setup()
    stores.get(homes.default)?.push({ id: 'retained', name: 'Retained task', profile: null, toast_notifications: true, monitor: '', continuity: false, recovery_only: true })
    expect(await service.list('default', false)).toMatchObject({ jobs: [{ id: 'retained' }] })
    expect(((await service.list('default', false)).jobs as Dict[])[0]).not.toHaveProperty('recovery_only')
    expect(await service.contextSources(homes.default, {})).toEqual({ profile: 'default', sources: [] })
    expect(await service.contextSources(homes.default, { selected_refs: ['retained'] })).toEqual({ profile: 'default', sources: [{ job_id: 'retained', label: 'Retained task', selectable: false }] })
  })

  it('refuses a recovery-only context before creating another job', async () => {
    const { service, homes, stores } = setup()
    stores.get(homes.default)?.push({ id: 'retained', profile: null, toast_notifications: true, monitor: '', continuity: false, recovery_only: true })
    await expect(service.create(homes.default, { schedule: 'every 1h', prompt: 'x', context_from: ['retained'] })).rejects.toMatchObject({ status: 400 })
    expect(stores.get(homes.default)).toHaveLength(1)
  })

  it('computes context choices in the execution store and keeps invalid selections remove-only', async () => {
    const { service, homes, stores } = setup()
    const base = { toast_notifications: true, monitor: '', continuity: false }
    stores.get(homes.default)?.push({ ...base, id: 'local-source', name: 'Local source', profile: null })
    stores.get(homes.research)?.push({ ...base, id: 'editor', profile: 'research', owner_profile: 'default' }, { ...base, id: 'research-source', name: 'Research source', profile: 'research', owner_profile: 'default' })
    expect(await service.contextSources(homes.default, { editing_job_id: 'editor', selected_refs: ['local-source'] })).toEqual({ profile: 'research', sources: [
      { job_id: 'research-source', label: 'Research source', selectable: true },
      { job_id: 'local-source', label: 'Local source', selectable: false },
    ] })
    expect(await service.contextSources(homes.default, { profile: 'research', exclude_job_id: 'editor' })).toEqual({ profile: 'research', sources: [{ job_id: 'research-source', label: 'Research source', selectable: true }] })
    expect(await service.contextSources(homes.default, {})).toEqual({ profile: 'default', sources: [{ job_id: 'local-source', label: 'Local source', selectable: true }] })
    await expect(service.contextSources(homes.default, { profile: 'hidden' })).rejects.toMatchObject({ status: 403 })
  })

  it('stores a new job in the execution profile and routes creator lifecycle calls there', async () => {
    const { service, sidecar, homes, stores } = setup()
    const created = await service.create(homes.default, { schedule: 'every 1h', prompt: 'x', profile: 'research', owner_profile: 'hidden' })
    expect(stores.get(homes.research)).toHaveLength(1)
    expect(stores.get(homes.default)).toHaveLength(0)
    expect(stores.get(homes.research)?.[0]?.owner_profile).toBe('default')
    expect(created.job).toMatchObject({ owner_profile: 'research', read_only: false })
    expect(await service.list('default', false)).toMatchObject({ jobs: [{ id: 'new-job', owner_profile: 'research', read_only: false }] })
    await service.update(homes.default, { job_id: 'new-job', name: 'renamed', profile: 'research', owner_profile: 'hidden' })
    await service.pause(homes.default, 'new-job', null)
    await service.resume(homes.default, 'new-job')
    await service.runNow(homes.default, 'new-job')
    await service.history(homes.default, 'new-job', undefined, undefined)
    await service.output(homes.default, 'new-job', undefined)
    await service.runDetail(homes.default, 'new-job', 'run.md')
    await service.delete(homes.default, 'new-job')
    for (const call of sidecar.calls.filter((call) => !['cron.list', 'cron.status', 'cron.create'].includes(call.method))) {
      expect(call.params).toMatchObject({ profile_home: homes.research, job_id: 'new-job' })
    }
    expect(stores.get(homes.research)?.[0]?.owner_profile).toBe('default')
  })

  it('sends a pin to the execution store so the sidecar resolves that profile’s main model', async () => {
    const { service, sidecar, homes } = setup()
    await service.create(homes.default, { schedule: 'every 1h', prompt: 'x', profile: 'research', model: 'seed', provider: 'seed' })
    for (const pinned of [true, false]) {
      await service.update(homes.default, { job_id: 'new-job', pinned })
      const call = sidecar.calls.filter((entry) => entry.method === 'cron.update').at(-1)
      expect(call?.params).toEqual({ profile_home: homes.research, job_id: 'new-job', updates: { pinned } })
    }
  })

  it('refuses inaccessible profiles and cannot route an id into an unrelated or hidden store', async () => {
    const { service, stores, homes, sidecar, deps } = setup()
    stores.get(homes.research)?.push({ id: 'foreign', profile: 'research', toast_notifications: true, monitor: '', continuity: false })
    stores.get(homes.hidden)?.push({ id: 'hidden', owner_profile: 'default', profile: 'hidden', toast_notifications: true, monitor: '', continuity: false })
    await expect(service.create(homes.default, { schedule: 'every 1h', prompt: 'x', profile: 'hidden' })).rejects.toMatchObject({ status: 403 })
    await expect(service.delete(homes.default, 'foreign')).rejects.toMatchObject({ status: 404 })
    await expect(service.delete(homes.default, 'hidden')).rejects.toMatchObject({ status: 404 })
    expect(sidecar.calls.some((call) => (call.params as Dict).profile_home === homes.hidden)).toBe(false)
    deps.isolatedProfileMode = () => true
    await expect(service.create(homes.default, { schedule: 'every 1h', prompt: 'x', profile: 'research' })).rejects.toMatchObject({ status: 403 })
  })

  it('rejects profile-changing edits rather than making scheduled and manual execution disagree', async () => {
    const { service, homes, stores } = setup()
    await service.create(homes.default, { schedule: 'every 1h', prompt: 'x', profile: 'research' })
    await expect(service.update(homes.default, { job_id: 'new-job', profile: 'default' })).rejects.toMatchObject({ status: 400 })
    expect(stores.get(homes.research)?.[0]?.profile).toBe('research')
  })

  it('includes creator-managed completions from the execution store', async () => {
    const { service, stores, homes } = setup()
    stores.get(homes.research)?.push({ id: 'completed', owner_profile: 'default', profile: 'research', toast_notifications: true, monitor: '', continuity: false, last_run_at: 10, last_status: 'ok' })
    expect(await service.recent(homes.default, '0')).toMatchObject({ completions: [{ job_id: 'completed', outcome: 'succeeded', completed_at: 10 }] })
  })

  it('uses the actual isolated profile identity rather than the default alias for its pinned home', async () => {
    const { service, deps, homes } = setup()
    deps.isolatedProfileMode = () => true
    deps.profileNames = () => Promise.resolve([{ name: 'research', visible: true }])
    deps.profileHome = () => homes.research
    const response = await service.create(homes.research, { schedule: 'every 1h', prompt: 'x', profile: 'research' })
    expect(response.job).toMatchObject({ profile: 'research', owner_profile: 'research', read_only: false })
  })

  it('rejects context references to another execution store', async () => {
    const { service, homes, stores } = setup()
    stores.get(homes.default)?.push({ id: 'source', profile: null, toast_notifications: true, monitor: '', continuity: false })
    await expect(service.create(homes.default, { schedule: 'every 1h', prompt: 'x', profile: 'research', context_from: ['source'] })).rejects.toMatchObject({ status: 400 })
    expect(stores.get(homes.research)).toHaveLength(0)
  })

  it('uses the resolved id for named updates and cannot change ownership or mutate an unmanaged collision', async () => {
    const { service, homes, stores, sidecar } = setup()
    const base = { profile: 'research', toast_notifications: true, monitor: '', continuity: false }
    stores.get(homes.research)?.push({ ...base, id: 'foreign', name: 'unrelated' }, { ...base, id: 'managed', name: 'foreign', owner_profile: 'default' })
    await service.update(homes.default, { job_id: 'foreign', name: 'renamed', id: 'foreign', owner_profile: 'hidden' })
    expect(sidecar.calls.find((call) => call.method === 'cron.update')?.params).toMatchObject({ job_id: 'managed', updates: { name: 'renamed' } })
    expect(stores.get(homes.research)?.[1]).toMatchObject({ id: 'managed', owner_profile: 'default' })
    stores.get(homes.research)?.push({ ...base, id: 'managed' })
    await expect(service.pause(homes.default, 'managed', null)).rejects.toMatchObject({ status: 409 })
  })

  it('fails closed for duplicate managed ids and legacy execution/store mismatches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { service, stores, homes } = setup()
    const job = { id: 'duplicate', profile: 'default', toast_notifications: true, monitor: '', continuity: false }
    stores.get(homes.default)?.push(job)
    stores.get(homes.research)?.push({ ...job, profile: 'research', owner_profile: 'default' })
    await expect(service.delete(homes.default, 'duplicate')).rejects.toMatchObject({ status: 409 })
    stores.get(homes.default)?.push({ ...job, id: 'legacy', profile: 'research' })
    vi.advanceTimersByTime(2_000)
    await expect(service.runNow(homes.default, 'legacy')).rejects.toMatchObject({ status: 409 })
    await expect(service.resume(homes.default, 'legacy')).rejects.toMatchObject({ status: 409 })
    const jobs = (await service.list('default', false)).jobs as Dict[]
    expect(jobs.some((row) => row.id === 'legacy')).toBe(true)
    await service.pause(homes.default, 'legacy', null)
    await service.delete(homes.default, 'legacy')
  })
})

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const row = (name: string, extra: Json = {}): Json => ({ name, path: '', is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0, ...extra })

describe('cross-profile cron routes', () => {
  useJsonStorage()
  const cronClock = freshCronListingsPerTest()
  let s: TestServer
  let sidecar: FakeSidecar
  let configs: Map<string, Json>
  let cronJobs: Map<string, Json[]>
  let workHome = ''
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    configs = new Map()
    cronJobs = new Map()
    sidecar.respond('profiles.list', () => ({ profiles: [row('default', { is_default: true, path: s.state }), row('work', { path: join(s.state, 'profiles', 'work') }), row('research', { path: join(s.state, 'profiles', 'research') }), row('hidden', { visible: false, path: join(s.state, 'profiles', 'hidden') })] as never[] }))
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('config.set', (params) => { configs.set(params.profile_home, params.config); mkdirSync(params.profile_home, { recursive: true }); writeFileSync(join(params.profile_home, 'config.yaml'), `# ${String(Math.random())}\n`); return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    sidecar.respond('cron.list', (params) => ({ jobs: (cronJobs.get(params.profile_home) ?? []) as never[] }))
    sidecar.respond('cron.create', (params) => { const job = { id: `job-${String(cronJobs.size + 1)}`, name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json) }; cronJobs.set(params.profile_home, [...(cronJobs.get(params.profile_home) ?? []), job]); return { job: job } })
    sidecar.respond('cron.update', (params) => { for (const jobs of cronJobs.values()) { const job = jobs.find((j) => j.id === params.job_id); if (job) { Object.assign(job, params.updates); return { job: job as never } } } throw new Error('missing') })
    s = await bootTestServer({ sidecar, now: cronClock.now })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    workHome = join(s.state, 'profiles', 'work')
    for (const p of ['work', 'research', 'hidden']) { mkdirSync(join(s.state, 'profiles', p), { recursive: true }); writeFileSync(join(s.state, 'profiles', p, 'config.yaml'), '# seed\n') }
  })
  afterAll(() => s.close())

  it('foreign cron jobs are hidden by default and counted; all_profiles shows them read-only', async () => {
    cronJobs.clear()
    cronJobs.set(s.state, [{ id: 'd1', name: 'mine', profile: null, toast_notifications: true, monitor: '', continuity: false }])
    cronJobs.set(join(s.state, 'profiles', 'research'), [{ id: 'r1', name: 'theirs', profile: 'research', toast_notifications: true, monitor: '', continuity: false }])
    let body = await json(await s.get('/api/crons'))
    expect(body).toMatchObject({ all_profiles: false, active_profile: 'default', other_profile_count: 1 })
    expect((body.jobs as Json[]).map((j) => j.id)).toEqual(['d1'])
    expect((body.jobs as Json[])[0]).toMatchObject({ owner_profile: 'default', read_only: false })
    body = await json(await s.get('/api/crons?all_profiles=1'))
    expect(body).toMatchObject({ all_profiles: true, other_profile_count: 0 })
    expect((body.jobs as Json[]).find((j) => j.id === 'r1')).toMatchObject({ owner_profile: 'research', read_only: true })
  })

  it('root aliases resolving to one home are read once', async () => {
    sidecar.respond('profiles.list', () => ({ profiles: [row('rootalias', { is_default: true, path: s.state }), row('default', { is_default: true, path: s.state }), row('research', { path: join(s.state, 'profiles', 'research') })] as never[] }))
    s.deps.profiles.invalidate()
    await s.deps.profiles.warmRootAliases()
    const start = sidecar.calls.length
    const body = await json(await s.get('/api/crons?all_profiles=1'))
    const listed = sidecar.calls.slice(start).filter((c) => c.method === 'cron.list').map((c) => (c.params as Json).profile_home)
    expect(listed.filter((h) => h === s.state)).toHaveLength(1)
    expect((body.jobs as Json[]).filter((j) => j.id === 'd1')).toHaveLength(1)
    sidecar.respond('profiles.list', () => ({ profiles: [row('default', { is_default: true, path: s.state }), row('work', { path: workHome }), row('research', { path: join(s.state, 'profiles', 'research') }), row('hidden', { visible: false, path: join(s.state, 'profiles', 'hidden') })] as never[] }))
    s.deps.profiles.invalidate()
  })

  it('a hidden inactive profile is skipped even under all_profiles', async () => {
    cronJobs.clear()
    cronJobs.set(s.state, [{ id: 'd2', name: 'mine', profile: null, toast_notifications: true, monitor: '', continuity: false }])
    cronJobs.set(join(s.state, 'profiles', 'hidden'), [{ id: 'h1', name: 'hidden job', profile: 'hidden', toast_notifications: true, monitor: '', continuity: false }])
    const body = await json(await s.get('/api/crons?all_profiles=1'))
    expect((body.jobs as Json[]).map((j) => j.id)).toEqual(['d2'])
    expect(body.other_profile_count).toBe(0)
  })

  it('a legacy job without a profile serialises profile: null', () => {
    const legacy = { id: 'legacy1', name: 'old', toast_notifications: true, monitor: '', continuity: false }
    expect(jobForApi(legacy)).toMatchObject({ id: 'legacy1', profile: null })
    expect('profile' in legacy).toBe(false)
  })

  it('creating a job with a known profile persists and returns it', async () => {
    cronJobs.clear()
    const res = await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', profile: 'research' })
    expect(res.status).toBe(200)
    expect(((await json(res)).job as Json).profile).toBe('research')
  })

  it('an unknown profile is refused before anything is created', async () => {
    cronJobs.clear()
    const before = sidecar.calls.filter((c) => c.method === 'cron.create').length
    const res = await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', profile: 'missing' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toBe('Unknown profile: missing')
    expect(sidecar.calls.filter((c) => c.method === 'cron.create').length).toBe(before)
  })

  it('update clears the stored profile override, reports the execution store profile, and refuses an unknown one', async () => {
    cronJobs.clear()
    const created = (await json(await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', profile: 'research' }))).job as Json
    let res = await post(s, '/api/crons/update', { job_id: created.id, profile: '' })
    expect(res.status).toBe(200)
    expect(((await json(res)).job as Json).profile).toBe('research')
    expect(cronJobs.get(join(s.state, 'profiles', 'research'))?.[0]?.profile).toBeNull()
    const before = sidecar.calls.filter((c) => c.method === 'cron.update').length
    res = await post(s, '/api/crons/update', { job_id: created.id, profile: 'ghost' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toBe('Unknown profile: ghost')
    expect(sidecar.calls.filter((c) => c.method === 'cron.update').length).toBe(before)
  })
})
