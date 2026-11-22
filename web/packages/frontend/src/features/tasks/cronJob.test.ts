import { describe, expect, it } from 'vitest'
import { CronJobSchema, type CronJob } from '../../contracts'
import { usageStrip } from './cronJob'

// Persisted shape from cron.jobs.create_job with the WebUI projections applied.
const recurring: CronJob = {
  id: 'ab12cd34ef56', name: 'Digest', prompt: 'Summarise the inbox', schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', attention_hint: null, last_failure: null, delivery_unconfirmed_platforms: [], can_stop: false, stopping: false, last_outcome: 'succeeded',
  repeat: { times: null, completed: 12 }, enabled: true, state: 'scheduled', next_run_at: '2026-09-18T09:00:00+02:00', last_run_at: '2026-09-17T09:00:00+02:00',
  last_status: 'ok', last_error: null, last_delivery_error: null, deliver: 'local', timezone: null, catch_up: null, grace_minutes: null, shown_state: 'active', diagnostics: '{}', wrap_response_supported: false, wrap_response: null, can_run_now: true, run_now_refusal: null,
}

describe('CronJobSchema', () => {
  it('accepts run times sent as epoch numbers', () => {
    expect(CronJobSchema.parse({ ...recurring, last_run_at: 1_789_600_000, next_run_at: 1_789_686_400 }).next_run_at).toBe(1_789_686_400)
  })
})

describe('usageStrip', () => {
  it('formats tokens, cost and model compactly', () => {
    expect(usageStrip({ input_tokens: 1_240, output_tokens: 830, estimated_cost_usd: 0.0042, model: 'gpt-5.4' })).toBe('1.2k in · 830 out · $0.0042 · gpt-5.4')
    expect(usageStrip({ total_tokens: 2_000_000 })).toBe('2M tokens')
    expect(usageStrip(undefined)).toBe('')
  })
})
