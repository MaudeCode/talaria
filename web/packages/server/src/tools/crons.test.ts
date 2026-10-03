import { describe, expect, it } from 'vitest'
import { CronService, jobForApi, type CronDeps } from './crons.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { Dict } from '../config/agent-config.js'

// Persisted shape from cron.jobs.create_job; synthetic ids only.
const recurring: Dict = {
  id: 'ab12cd34ef56', name: 'Digest', prompt: 'Summarise the inbox', schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
  repeat: { times: null, completed: 12 }, enabled: true, state: 'scheduled', next_run_at: '2026-09-18T09:00:00+02:00', last_status: 'ok',
}
const derived = (job: Dict) => {
  const { derived_state, needs_attention, resumable } = jobForApi(job)
  return { derived_state, needs_attention, resumable }
}
const state = (job: Dict) => jobForApi(job).derived_state

describe('cron derived state (TAL-296)', () => {
  it('keeps a paused recurring job with a stale error paused and resumable', () => {
    expect(derived({ ...recurring, enabled: false, state: 'paused', next_run_at: null, last_status: 'error', last_error: 'boom' })).toEqual({ derived_state: 'paused', needs_attention: false, resumable: true })
  })
  it('flags a completed unlimited recurring job with no next run, but only with a repeat record', () => {
    const stalled = { ...recurring, enabled: false, state: 'completed', next_run_at: null }
    expect(derived(stalled)).toEqual({ derived_state: 'needs_attention', needs_attention: true, resumable: true })
    expect(derived({ ...stalled, repeat: undefined })).toEqual({ derived_state: 'off', needs_attention: false, resumable: true })
  })
  it('classifies a recurring job the scheduler could not compute as a resumable schedule error', () => {
    expect(derived({ ...recurring, state: 'error', next_run_at: null, last_error: 'croniter missing' })).toEqual({ derived_state: 'schedule_error', needs_attention: true, resumable: true })
    expect(state({ ...recurring, last_status: 'error', next_run_at: null })).toBe('schedule_error')
    expect(state({ ...recurring, last_status: 'failed', next_run_at: null })).toBe('schedule_error')
  })
  it('does not misclassify one-shot or plain disabled jobs', () => {
    expect(state({ ...recurring, schedule: { kind: 'once', run_at: '2026-09-01T00:00:00Z' }, repeat: { times: 1, completed: 1 }, enabled: false, state: 'completed', next_run_at: null })).toBe('off')
    expect(state({ ...recurring, repeat: { times: 3, completed: 3 }, enabled: false, state: 'completed', next_run_at: null })).toBe('off')
    expect(state({ ...recurring, enabled: false, state: 'scheduled', next_run_at: null })).toBe('off')
  })
  it('reports errors and active jobs, and only stopped jobs are resumable', () => {
    expect(derived({ ...recurring, last_status: 'error', last_error: 'boom' })).toEqual({ derived_state: 'error', needs_attention: false, resumable: false })
    expect(derived({ ...recurring, last_status: 'failed' })).toMatchObject({ derived_state: 'error' })
    expect(derived(recurring)).toEqual({ derived_state: 'active', needs_attention: false, resumable: false })
  })
  it('honours the legacy paused/status/next_run fields and string schedules', () => {
    const legacy = { ...recurring, state: undefined, last_status: undefined }
    expect(state({ ...legacy, paused: true })).toBe('paused')
    expect(state({ ...legacy, status: 'error' })).toBe('error')
    expect(state({ ...legacy, status: 'error', next_run_at: null })).toBe('schedule_error')
    expect(state({ ...legacy, status: 'error', next_run_at: null, next_run: 1_789_600_000 })).toBe('error')
    expect(state({ ...recurring, schedule: '0 9 * * *', enabled: false, state: 'completed', next_run_at: null })).toBe('needs_attention')
    expect(state({ ...recurring, schedule: '2026-12-24T09:00:00', repeat: { times: 1, completed: 1 }, enabled: false, state: 'completed', next_run_at: null })).toBe('off')
  })
})

describe('cron job payloads carry the derived fields', () => {
  function setup() {
    const sidecar = new FakeSidecar()
    const home = '/synthetic/talaria-home'
    const jobs: Dict[] = [{ ...recurring, profile: null, toast_notifications: true, monitor: '', continuity: false }]
    const runningJobs = new Map<string, number>()
    const deps: CronDeps = {
      sidecar: () => sidecar,
      profileHome: () => home,
      profileNames: () => Promise.resolve([{ name: 'default', visible: true }]),
      profilesMatch: (a, b) => a === b,
      isolatedProfileMode: () => false,
      log: () => undefined,
      runningJobs,
    }
    sidecar.respond('cron.list', () => ({ jobs: jobs as never[] }))
    sidecar.respond('cron.pause', () => { Object.assign(jobs[0]!, { enabled: false, state: 'paused', next_run_at: null, last_status: 'error' }); return { job: jobs[0] as never } })
    sidecar.respond('cron.resume', () => { Object.assign(jobs[0]!, { enabled: true, state: 'scheduled', next_run_at: '2026-09-19T09:00:00+02:00' }); return { job: jobs[0] as never } })
    return { service: new CronService(deps), home, runningJobs }
  }

  it('lists running from the manual-run map and returns pause/resume rows through the same shaping', async () => {
    const { service, home, runningJobs } = setup()
    expect((await service.list('default', false)).jobs).toMatchObject([{ id: recurring.id, derived_state: 'active', resumable: false, running: false }])
    runningJobs.set(String(recurring.id), 1)
    expect((await service.list('default', false)).jobs).toMatchObject([{ running: true }])
    expect((await service.pause(home, String(recurring.id), null)).job).toMatchObject({ derived_state: 'paused', needs_attention: false, resumable: true, running: true })
    runningJobs.clear()
    expect((await service.resume(home, String(recurring.id))).job).toMatchObject({ derived_state: 'error', needs_attention: false, resumable: false, running: false })
  })
})
