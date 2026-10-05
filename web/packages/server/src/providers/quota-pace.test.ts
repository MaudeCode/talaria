/** TAL-409: the App's pace and forecast cases (`ProviderQuotaWidgetTests`), ported to the server normaliser. */
import { describe, expect, it } from 'vitest'
import { classifyQuotaSource, isoUtc, normalizeQuotaWindows, quotaForecast } from './catalog.js'
import { QUOTA_THRESHOLD_DEFAULTS } from '../settings.js'

const NOW = 1_900_000_000
const resetIn = (seconds: number): string => new Date((NOW + seconds) * 1000).toISOString()
const one = (window: Record<string, unknown>) => normalizeQuotaWindows([window], NOW).windows[0]!

describe('quota window pace', () => {
  it('weekly pace matches the App calculator at 10%, 30%, 32% and 90% used', () => {
    const pace = (used: number) => one({ label: 'Weekly', used_percent: used, reset_at: resetIn(5 * 86_400) }).pace
    expect(pace(10)).toEqual({ expected_remaining_percent: 71.4, pace_delta_percent: 18.6, burn_rate: 0.35, minutes_to_reset: 7200, projected_minutes_to_empty: 25_920, elapsed_minutes: 2880, valid_until: isoUtc(resetIn(5 * 86_400)) })
    expect(pace(30)).toMatchObject({ pace_delta_percent: -1.4, burn_rate: 1.05, projected_minutes_to_empty: 6720 })
    expect(pace(32)).toMatchObject({ pace_delta_percent: -3.4, burn_rate: 1.12, projected_minutes_to_empty: 6120 })
    expect(pace(90)).toMatchObject({ pace_delta_percent: -61.4, burn_rate: 3.15, projected_minutes_to_empty: 320 })
  })

  it('a session window is 5h, or weekly when its reset is more than 5h away', () => {
    const session = one({ label: 'Session', used_percent: 10, reset_at: resetIn(4 * 3600) })
    expect(session.window_seconds).toBe(18_000)
    expect(session.pace).toMatchObject({ expected_remaining_percent: 80, pace_delta_percent: 10 })
    const collapsed = one({ label: 'Session', used_percent: 12, reset_at: resetIn((6 * 24 + 6) * 3600) })
    expect(collapsed.window_seconds).toBe(604_800)
    expect(collapsed.pace).toMatchObject({ expected_remaining_percent: 89.3, pace_delta_percent: -1.3 })
  })

  it('pace is null without a future reset, a usage value, or a known window length', () => {
    expect(one({ label: 'Weekly', used_percent: 10, reset_at: resetIn(-60) }).pace).toBeNull()
    expect(one({ label: 'Weekly', used_percent: 10 }).pace).toBeNull()
    expect(one({ label: 'Weekly', reset_at: resetIn(3600) }).pace).toBeNull()
    expect(one({ label: 'Monthly', used_percent: 10, reset_at: resetIn(3600) })).toMatchObject({ window_seconds: null, pace: null, forecast: null })
    // A provider-reported length wins over the label, and only 5h and weekly windows have a pace.
    expect(one({ label: 'Weekly', window_seconds: 3600, used_percent: 10, reset_at: resetIn(1800) })).toMatchObject({ window_seconds: 3600, pace: null })
    // `remaining_percent` stands in for a missing `used_percent`.
    expect(one({ label: '5h', remaining_percent: 70, reset_at: resetIn(3 * 3600) })).toMatchObject({ used_percent: null, remaining_percent: 70, pace: { expected_remaining_percent: 60, pace_delta_percent: 10 } })
  })

  it('the forecast budgets per day or hour and warns when the projection empties before reset', () => {
    const pace = { expected_remaining_percent: 50, pace_delta_percent: -3.8, burn_rate: 1.18, minutes_to_reset: 3 * 24 * 60, projected_minutes_to_empty: 1.5 * 24 * 60, elapsed_minutes: 0, valid_until: resetIn(3 * 86_400) }
    expect(quotaForecast(pace, 75)).toEqual({ outcome: 'warning', budget_unit: 'day', budget_percent: 25, depletion_margin_minutes: -2160 })
    expect(quotaForecast({ ...pace, minutes_to_reset: 120, projected_minutes_to_empty: 600 }, 40)).toEqual({ outcome: 'safe', budget_unit: 'hour', budget_percent: 20, depletion_margin_minutes: 480 })
    expect(quotaForecast({ ...pace, projected_minutes_to_empty: null }, 75)).toMatchObject({ outcome: 'safe', depletion_margin_minutes: null })
  })

  it('selects the pace, session and weekly windows the App shows', () => {
    const indexes = (labels: string[]) => {
      const { pace_window_index, session_window_index, weekly_window_index } = normalizeQuotaWindows(labels.map((label) => ({ label, used_percent: 10 })), NOW)
      return { pace_window_index, session_window_index, weekly_window_index }
    }
    expect(indexes(['Session', 'Weekly'])).toEqual({ pace_window_index: 1, session_window_index: 0, weekly_window_index: 1 })
    expect(indexes(['Monthly', '5h limit'])).toEqual({ pace_window_index: 1, session_window_index: 1, weekly_window_index: null })
    expect(indexes(['Monthly'])).toEqual({ pace_window_index: null, session_window_index: null, weekly_window_index: null })
  })

  it('normalises reset stamps to ISO UTC and drops blank labels', () => {
    expect(isoUtc('2026-09-28 12:00:00+00:00')).toBe('2026-09-28T12:00:00Z')
    expect(isoUtc('2026-09-28T14:00:00.250+02:00')).toBe('2026-09-28T12:00:00.250Z')
    expect(isoUtc('2026-09-28T12:00:00')).toBe('2026-09-28T12:00:00Z')
    expect(isoUtc('soon')).toBeNull()
    expect(isoUtc(1_900_000_000)).toBeNull()
    expect(normalizeQuotaWindows([{ label: ' ' }, { label: ' 5h ' }, 'junk'], NOW).windows.map((w) => w.label)).toEqual(['5h'])
  })
})

describe('quota urgency (TAL-411)', () => {
  // The App calculator's cases (`ProviderQuotaWidgetTests`): 10%, 30%, 32% and 90% used five days before a weekly reset.
  const weekly = (used: number) => ({ label: 'Weekly', used_percent: used, reset_at: resetIn(5 * 86_400) })
  const classify = (raw: Record<string, unknown>[], status = 'available', thresholds = QUOTA_THRESHOLD_DEFAULTS) => {
    const { windows, pace_window_index } = normalizeQuotaWindows(raw, NOW)
    return classifyQuotaSource({ status, windows, pace_window_index }, thresholds)
  }

  it('matches the App calculator at default thresholds on both bases', () => {
    expect(classify([weekly(10)]).urgency).toEqual({ remaining: 'healthy', pace: 'healthy' })
    expect(classify([weekly(30)]).urgency).toEqual({ remaining: 'healthy', pace: 'healthy' })
    expect(classify([weekly(32)]).urgency).toEqual({ remaining: 'healthy', pace: 'warning' })
    expect(classify([weekly(90)]).urgency).toEqual({ remaining: 'critical', pace: 'critical' })
    expect(classify([weekly(80)]).urgency.remaining).toBe('warning')
  })

  it('applies each threshold at its edge', () => {
    // 32% used: 3.4 points over pace at a 1.12x burn, projected empty before reset after 48h elapsed.
    expect(classify([weekly(32)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, pace_tolerance_percent: 4 }).urgency.pace).toBe('healthy')
    expect(classify([weekly(32)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, pace_tolerance_percent: 4, pace_warning_burn_rate_percent: 112 }).urgency.pace).toBe('warning')
    expect(classify([weekly(32)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, pace_warning_burn_rate_percent: 100, pace_critical_burn_rate_percent: 112 }).urgency.pace).toBe('critical')
    // The burn-rate breakpoints wait for the minimum elapsed time; tolerance still applies.
    const late = classify([weekly(32)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, pace_tolerance_percent: 4, pace_warning_burn_rate_percent: 100, pace_minimum_elapsed_hours: 49 })
    expect(late.windows[0]).toMatchObject({ projection_eligible: false, urgency: { pace: 'healthy' } })
    expect(classify([weekly(75)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, warning_remaining_percent: 25 }).urgency.remaining).toBe('warning')
    expect(classify([weekly(74)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, warning_remaining_percent: 25 }).urgency.remaining).toBe('healthy')
    expect(classify([weekly(90)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, critical_remaining_percent: 9 }).urgency.remaining).toBe('warning')
  })

  it('names pace over, on, or under the tolerance', () => {
    const status = (used: number, tolerance = 3) => classify([weekly(used)], 'available', { ...QUOTA_THRESHOLD_DEFAULTS, pace_tolerance_percent: tolerance }).windows[0]!.pace?.status
    expect(status(32)).toBe('over')
    expect(status(32, 4)).toBe('on')
    expect(status(10)).toBe('under')
  })

  it('a source without windows, an unavailable status, and a stale refresh classify without thresholds', () => {
    expect(classify([]).urgency).toEqual({ remaining: 'healthy', pace: 'healthy' })
    expect(classify([weekly(90)], 'exhausted').urgency).toEqual({ remaining: 'unavailable', pace: 'unavailable' })
    expect(classify([weekly(90)], 'stale').urgency).toEqual({ remaining: 'stale', pace: 'stale' })
    // Without a pace the pace basis falls back to remaining.
    expect(classify([{ label: 'Monthly', used_percent: 95 }]).urgency).toEqual({ remaining: 'critical', pace: 'critical' })
  })

  it('the source urgency reads the first window for remaining and the pace window for pace', () => {
    const source = classify([{ label: 'Session', used_percent: 95, reset_at: resetIn(3600) }, weekly(10)])
    expect(source.urgency).toEqual({ remaining: 'critical', pace: 'healthy' })
    expect(source.windows.map((w) => w.urgency.remaining)).toEqual(['critical', 'healthy'])
  })
})
