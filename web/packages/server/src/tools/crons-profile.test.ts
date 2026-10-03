import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService, type CronDeps } from './crons.js'
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

describe('cross-profile cron ownership', () => {
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
    const { service, stores, homes } = setup()
    const job = { id: 'duplicate', profile: 'default', toast_notifications: true, monitor: '', continuity: false }
    stores.get(homes.default)?.push(job)
    stores.get(homes.research)?.push({ ...job, profile: 'research', owner_profile: 'default' })
    await expect(service.delete(homes.default, 'duplicate')).rejects.toMatchObject({ status: 409 })
    stores.get(homes.default)?.push({ ...job, id: 'legacy', profile: 'research' })
    await expect(service.runNow(homes.default, 'legacy')).rejects.toMatchObject({ status: 409 })
    await expect(service.resume(homes.default, 'legacy')).rejects.toMatchObject({ status: 409 })
    const jobs = (await service.list('default', false)).jobs as Dict[]
    expect(jobs.some((row) => row.id === 'legacy')).toBe(true)
    await service.pause(homes.default, 'legacy', null)
    await service.delete(homes.default, 'legacy')
  })
})
