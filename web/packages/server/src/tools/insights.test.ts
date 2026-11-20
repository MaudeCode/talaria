import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InsightsRangeSchema } from '@maudecode/talaria-web-contracts'
import { buildInsights, resolveInsightsRange, type InsightsRangeQuery } from './insights.js'

const at = (iso: string): number => Date.parse(iso) / 1000
/** Thursday 2026-03-20 noon in New York, twelve days after the spring-forward change. */
const NOW = at('2026-03-20T12:00:00-04:00')

describe('resolveInsightsRange (TAL-1117)', () => {
  let tz: string | undefined
  beforeEach(() => { tz = process.env.TZ; process.env.TZ = 'America/New_York' })
  afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz })

  // Each row is a request and the range the server serves for it on the New York calendar at NOW.
  it.each<[string, InsightsRangeQuery, Record<string, unknown>]>([
    ['no endpoints read the days preset', { days: '7' }, { mode: 'preset', start: at('2026-03-14T00:00:00-04:00'), end: NOW, through_now: true, start_date: '2026-03-14', end_date: '2026-03-20', fallback_reason: null }],
    ['two dates cover both whole days', { start: '2026-03-01', end: '2026-03-10' }, { mode: 'custom', start: at('2026-03-01T00:00:00-05:00'), end: at('2026-03-11T00:00:00-04:00'), through_now: false, start_date: '2026-03-01', end_date: '2026-03-10', adjustments: [] }],
    ['a date across spring-forward is 23 hours', { start: '2026-03-08', end: '2026-03-08' }, { start: at('2026-03-08T00:00:00-05:00'), end: at('2026-03-09T00:00:00-04:00'), end_date: '2026-03-08' }],
    ['an omitted end runs through now', { start: '2026-03-15' }, { mode: 'custom', end: NOW, through_now: true, end_date: '2026-03-20' }],
    ['an omitted start opens the trailing preset before the end', { end: '2026-03-10', days: '30' }, { mode: 'custom', start_date: '2026-02-09', end_date: '2026-03-10' }],
    ['a blank start falls back', { start: '', end: '2026-03-10' }, { mode: 'preset', start_date: '2026-02-19', end_date: '2026-03-20', fallback_reason: 'invalid_start' }],
    ['a blank end falls back', { start: '2026-03-01', end: '  ' }, { mode: 'preset', fallback_reason: 'invalid_end' }],
    ['an impossible date falls back', { start: '2026-02-30' }, { mode: 'preset', fallback_reason: 'invalid_start' }],
    ['a pre-epoch date falls back', { start: '1969-12-31', end: '2026-03-10' }, { mode: 'preset', fallback_reason: 'invalid_start' }],
    ['seconds past what a date holds fall back', { start: '2026-03-01', end: '99999999999999' }, { mode: 'preset', fallback_reason: 'invalid_end' }],
    ['signed or exponent seconds fall back', { start: '-5', end: '1e9' }, { mode: 'preset', fallback_reason: 'invalid_start' }],
    ['exact seconds keep their precision', { start: String(at('2026-03-05T09:30:00-05:00') + 0.25), end: String(at('2026-03-06T17:45:00-05:00')) }, { mode: 'custom', start: at('2026-03-05T09:30:00-05:00') + 0.25, end: at('2026-03-06T17:45:00-05:00'), through_now: false, start_date: '2026-03-05', end_date: '2026-03-06' }],
    ['an exact end at midnight ends the day before', { start: '2026-03-05', end: String(at('2026-03-07T00:00:00-05:00')) }, { end_date: '2026-03-06' }],
    ['a date start after an exact end swaps roles', { start: '2026-03-10', end: String(at('2026-03-05T12:00:00-05:00')) }, { mode: 'custom', start: at('2026-03-05T12:00:00-05:00'), end: at('2026-03-11T00:00:00-04:00'), start_date: '2026-03-05', end_date: '2026-03-10', adjustments: ['reversed'] }],
    ['an exact start at a whole-day end\'s close means that day', { start: String(at('2026-03-11T00:00:00-04:00')), end: '2026-03-10' }, { start: at('2026-03-10T00:00:00-04:00'), end: at('2026-03-11T00:00:00-04:00'), adjustments: ['reversed'] }],
    ['a future end runs through now', { start: '2026-03-15', end: '2026-04-30' }, { mode: 'custom', end: NOW, through_now: true, end_date: '2026-03-20' }],
    ['today\'s date end runs through now', { start: '2026-03-15', end: '2026-03-20' }, { end: NOW, through_now: true }],
    ['an exact end at the clock stays exclusive', { start: '2026-03-15', end: String(NOW) }, { end: NOW, through_now: false, end_date: '2026-03-20' }],
    ['an exact start at the clock is empty', { start: String(NOW) }, { mode: 'custom', start: NOW, end: NOW, through_now: false, start_date: '2026-03-20', end_date: '2026-03-20' }],
    ['a start after the clock falls back', { start: '2026-03-21' }, { mode: 'preset', fallback_reason: 'future' }],
    ['a range past five calendar years keeps its last five', { start: '2015-01-01', end: '2026-03-10' }, { start: at('2021-03-10T00:00:00-05:00'), start_date: '2021-03-10', end_date: '2026-03-10', adjustments: ['capped'], bucket: 'month' }],
    ['five calendar years over a leap day are not capped', { start: '2021-03-10', end: '2026-03-10' }, { start_date: '2021-03-10', adjustments: [] }],
    ['a capped Feb 29 end starts on Feb 28', { start: '2010-01-01', end: '2024-02-29' }, { start_date: '2019-02-28', end_date: '2024-02-29', adjustments: ['capped'] }],
    ['366 days stay daily', { start: '2025-03-20', end: '2026-03-20' }, { bucket: 'day' }],
    ['367 days bucket by month', { start: '2025-03-19', end: '2026-03-20' }, { bucket: 'month' }],
  ])('%s', (_name, query, expected) => {
    const range = resolveInsightsRange(query, NOW)
    expect(InsightsRangeSchema.parse(range)).toMatchObject({ timezone: 'America/New_York', today: '2026-03-20', ...expected })
  })

  it('totals and every series admit the same custom interval, a month per bucket past 366 days', async () => {
    const row = (id: string, iso: string, input: number) => ({ session_id: id, created_at: at(iso), updated_at: at(iso), input_tokens: input, model: 'm' })
    const insights = await buildInsights([
      row('before', '2024-12-31T23:59:59-05:00', 1),
      row('first', '2025-01-01T00:00:00-05:00', 10),
      row('feb', '2025-02-14T12:00:00-05:00', 20),
      row('last', '2026-02-28T23:59:59-05:00', 40),
      row('after', '2026-03-01T00:00:00-05:00', 80),
    ], { start: '2025-01-01', end: '2026-02-28' }, NOW)
    expect(insights).toMatchObject({ total_sessions: 3, total_input_tokens: 70, period_days: 424, range: { bucket: 'month' } })
    const series = insights.daily_tokens as { date: string; input_tokens: number }[]
    expect(series).toHaveLength(14)
    expect(series.filter((b) => b.input_tokens).map((b) => [b.date, b.input_tokens])).toEqual([['2025-01-01', 10], ['2025-02-01', 20], ['2026-02-01', 40]])
  })
})

describe('exact bounds (TAL-1117)', () => {
  it('admit a session by its fractional activity time, from the index or merged with state.db', async () => {
    const t = at('2026-03-05T12:00:00Z')
    const entries = [{ session_id: 'web', created_at: t - 60, updated_at: t + 0.5, input_tokens: 10, model: 'm' }, { session_id: 'both', created_at: t - 60, updated_at: t - 1, input_tokens: 20, model: 'm' }]
    const stateRows = () => [{ session_id: 'both', created_at: t - 60, updated_at: t + 0.75, input_tokens: 20, model: 'm' }]
    const read = (start: number, end: number) => buildInsights(entries, { start: String(start), end: String(end) }, NOW, stateRows)
    expect(await read(t + 0.25, t + 0.9)).toMatchObject({ total_sessions: 2, total_input_tokens: 30 })
    expect(await read(t, t + 0.25)).toMatchObject({ total_sessions: 0 })
  })
})

describe('the shared insights-range fixture (TAL-1117)', () => {
  it('is what the server serves for its custom and fallback queries', async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/insights-range.json'), 'utf8')) as { now: string; timezone: string; entries: Record<string, unknown>[]; custom: { query: InsightsRangeQuery; body: unknown }; fallback: { query: InsightsRangeQuery; body: unknown } }
    const tz = process.env.TZ
    process.env.TZ = fixture.timezone
    try {
      for (const example of [fixture.custom, fixture.fallback]) expect(await buildInsights(fixture.entries, example.query, at(fixture.now))).toEqual(example.body)
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})
