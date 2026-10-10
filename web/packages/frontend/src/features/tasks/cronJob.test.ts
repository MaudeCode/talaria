import { describe, expect, it } from 'vitest'
import { CronJobSchema, type CronJob } from '../../contracts'
import { cronDiagnostics, cronState, usageStrip } from './cronJob'

// Persisted shape from cron.jobs.create_job with the WebUI projections applied.
const recurring: CronJob = {
  id: 'ab12cd34ef56', name: 'Digest', prompt: 'Summarise the inbox', schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', attention_hint: null,
  repeat: { times: null, completed: 12 }, enabled: true, state: 'scheduled', next_run_at: '2026-09-18T09:00:00+02:00', last_run_at: '2026-09-17T09:00:00+02:00',
  last_status: 'ok', last_error: null, last_delivery_error: null, deliver: 'local', origin: { secret: 'never-copied' },
}

describe('cronState', () => {
  it('renders the server state, overlaid by a live run, and stays neutral without it', () => {
    expect(cronState({ ...recurring, derived_state: 'schedule_error' })).toBe('schedule_error')
    expect(cronState({ ...recurring, derived_state: 'paused' }, true)).toBe('running')
    expect(cronState({ ...recurring, derived_state: 'paused', running: true })).toBe('running')
    expect(cronState(recurring)).toBe('unknown')
    expect(CronJobSchema.parse({ ...recurring, last_run_at: 1_789_600_000, next_run_at: 1_789_686_400 }).next_run_at).toBe(1_789_686_400)
  })
})

describe('cronDiagnostics', () => {
  it('includes schedule, status and error fields and nothing else', () => {
    const job = { ...recurring, enabled: false, state: 'completed', next_run_at: null, last_error: 'croniter missing', last_delivery_error: 'telegram 401' }
    const out = JSON.parse(cronDiagnostics(job)) as Record<string, unknown>
    expect(out).toMatchObject({ id: 'ab12cd34ef56', state: 'completed', enabled: false, last_error: 'croniter missing', last_delivery_error: 'telegram 401', schedule_display: '0 9 * * *', repeat: { times: null, completed: 12 } })
    expect(cronDiagnostics(job)).not.toContain('never-copied')
    expect(out).not.toHaveProperty('prompt')
    expect(out).not.toHaveProperty('origin')
  })
})

describe('usageStrip', () => {
  it('formats tokens, cost and model compactly', () => {
    expect(usageStrip({ input_tokens: 1_240, output_tokens: 830, estimated_cost_usd: 0.0042, model: 'gpt-5.4' })).toBe('1.2k in · 830 out · $0.0042 · gpt-5.4')
    expect(usageStrip({ total_tokens: 2_000_000 })).toBe('2M tokens')
    expect(usageStrip(undefined)).toBe('')
  })
})
