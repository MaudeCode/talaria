import { describe, expect, it } from 'vitest'
import { CronJobSchema, type CronJob } from '../../contracts'
import { cronDiagnostics, cronState, modelOptionFor, runResponse, splitModelOption, usageStrip } from './cronJob'

// Persisted shape from cron.jobs.create_job with the WebUI projections applied.
const recurring: CronJob = {
  id: 'ab12cd34ef56', name: 'Digest', prompt: 'Summarise the inbox', schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, schedule_display: '0 9 * * *',
  repeat: { times: null, completed: 12 }, enabled: true, state: 'scheduled', next_run_at: '2026-09-18T09:00:00+02:00', last_run_at: '2026-09-17T09:00:00+02:00',
  last_status: 'ok', last_error: null, last_delivery_error: null, deliver: 'local', origin: { secret: 'never-copied' },
}

describe('cronState', () => {
  it('flags a completed unlimited recurring job with no next run as needs attention', () => {
    expect(cronState({ ...recurring, enabled: false, state: 'completed', next_run_at: null })).toBe('needs_attention')
  })
  it('flags a recurring job the scheduler could not compute as a schedule error', () => {
    expect(cronState({ ...recurring, state: 'error', next_run_at: null, last_error: 'croniter missing' })).toBe('schedule_error')
    expect(cronState({ ...recurring, last_status: 'error', next_run_at: null })).toBe('schedule_error')
  })
  it('does not misclassify paused, one-shot, or plain disabled jobs', () => {
    expect(cronState({ ...recurring, enabled: false, state: 'paused', next_run_at: null })).toBe('paused')
    expect(cronState({ ...recurring, enabled: false, state: 'paused', next_run_at: null, last_status: 'error', last_error: 'boom' })).toBe('paused')
    expect(cronState({ ...recurring, schedule: { kind: 'once', run_at: '2026-09-01T00:00:00Z' }, repeat: { times: 1, completed: 1 }, enabled: false, state: 'completed', next_run_at: null })).toBe('off')
    expect(cronState({ ...recurring, repeat: { times: 3, completed: 3 }, enabled: false, state: 'completed', next_run_at: null })).toBe('off')
    expect(cronState({ ...recurring, enabled: false, state: 'scheduled', next_run_at: null })).toBe('off')
  })
  it('reports errors, running, and active', () => {
    expect(cronState({ ...recurring, last_status: 'error', last_error: 'boom' })).toBe('error')
  })
  it('honours the legacy paused/status fields from older agents', () => {
    const legacy = { ...recurring, state: undefined, last_status: undefined }
    expect(cronState({ ...legacy, paused: true })).toBe('paused')
    expect(cronState({ ...legacy, status: 'error' })).toBe('error')
    expect(cronState({ ...legacy, status: 'error', next_run_at: null })).toBe('schedule_error')
    expect(cronState({ ...legacy, running: true })).toBe('running')
    // String schedule + unlimited repeat is recurring, so the stalled case still surfaces.
    expect(cronState({ ...recurring, schedule: '0 9 * * *', enabled: false, state: 'completed', next_run_at: null })).toBe('needs_attention')
    expect(cronState({ ...recurring, schedule: '2026-12-24T09:00:00', repeat: { times: 1, completed: 1 }, enabled: false, state: 'completed', next_run_at: null })).toBe('off')
    expect(CronJobSchema.parse({ ...recurring, last_run_at: 1_789_600_000, next_run_at: 1_789_686_400 }).next_run_at).toBe(1_789_686_400)
    // Legacy next_run keeps a recurring job out of the attention states.
    expect(cronState({ ...legacy, status: 'error', next_run_at: null, next_run: 1_789_600_000 })).toBe('error')
    expect(cronState(recurring, true)).toBe('running')
    expect(cronState(recurring)).toBe('active')
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

describe('model option mapping', () => {
  const known = new Set(['gpt-oss:20b', '@openai-codex:gpt-5.6-sol'])
  const providerOf = (id: string) => (id === 'gpt-oss:20b' ? 'custom' : id === '@openai-codex:gpt-5.6-sol' ? 'openai-codex' : null)
  it('resolves a stored pair to the picker entry in either id form', () => {
    expect(modelOptionFor('@openai-codex:gpt-5.6-sol', known)).toBe('@openai-codex:gpt-5.6-sol')
    expect(modelOptionFor('@custom:gpt-oss:20b', known)).toBe('gpt-oss:20b')
    expect(modelOptionFor('@gone:model', known)).toBe('@gone:model')
  })
  it('splits a picker value back into the stored bare model and provider', () => {
    expect(splitModelOption('@openai-codex:gpt-5.6-sol', providerOf)).toEqual({ model: 'gpt-5.6-sol', provider: 'openai-codex' })
    expect(splitModelOption('gpt-oss:20b', providerOf)).toEqual({ model: 'gpt-oss:20b', provider: 'custom' })
    expect(splitModelOption('@gone:model', providerOf)).toEqual({ model: 'model', provider: 'gone' })
    expect(splitModelOption('', providerOf)).toEqual({ model: null, provider: null })
  })
})

describe('runResponse', () => {
  it('drops the run file front-matter and keeps the reply verbatim', () => {
    expect(runResponse('# Cron run: x\n\n**Model:** m\n\n## Response\n\n# Title\n\n| a |\n')).toBe('# Title\n\n| a |')
    expect(runResponse('plain stdout\n')).toBe('plain stdout')
  })
})
