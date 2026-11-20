/** Usage analytics from the session index plus the Agent's state.db sessions (Python `_handle_insights`). */
import type { InsightsRange } from '@maudecode/talaria-web-contracts'
import type { Dict } from '../config/agent-config.js'
import { promptCacheHitPercent } from '../sessions/session.js'
import { str } from '../util.js'

const num = (v: unknown): number => { const n = Number.parseFloat(str(v)); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }
const cost = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const text = typeof v === 'string' ? v.trim().replaceAll('$', '').replaceAll(',', '') : str(v)
  if (!text) return 0
  const n = Number.parseFloat(text)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const USAGE_FIELDS = ['message_count', 'input_tokens', 'output_tokens', 'cache_read_tokens'] as const
const dayKey = (d: Date): string => `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** A session's activity time: the one timestamp that both admits it to the window and picks its day. */
const activityAt = (e: Dict): number => Math.max(num(e.created_at), num(e.updated_at))
/** TAL-2479: a chart's peak point (the first of equal largest values, null when empty) and scale maximum (0 when none is positive). */
const chartPeak = (values: number[]): { peak_index: number | null; max: number } => ({
  peak_index: values.length ? values.indexOf(Math.max(...values)) : null,
  max: Math.max(0, ...values),
})

/** A calendar day on the server clock's zone: a local Date at midnight. */
const midnight = (y: number, m: number, d: number): Date => { const at = new Date(1970, 0, 1); at.setFullYear(y, m, d); return at }
const dayOf = (seconds: number): Date => { const d = new Date(seconds * 1000); return midnight(d.getFullYear(), d.getMonth(), d.getDate()) }
const addDays = (day: Date, n: number): Date => midnight(day.getFullYear(), day.getMonth(), day.getDate() + n)
const daysBetween = (a: Date, b: Date): number => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000)
/** The latest instant a JS Date holds, in seconds; a larger numeric endpoint is unsafe. */
const MAX_SECONDS = 8.64e12
/** TAL-1117: a custom range spans at most this many calendar years, and buckets by month past `MAX_DAILY_BUCKETS` days. */
const CAP_YEARS = 5
const MAX_DAILY_BUCKETS = 366

/** One supplied range endpoint: a `YYYY-MM-DD` server-calendar day, or exact unix seconds. */
type Endpoint = { kind: 'date'; day: Date } | { kind: 'num'; at: number }
function parseEndpoint(raw: unknown): Endpoint | 'omitted' | 'invalid' {
  if (raw === undefined || raw === null) return 'omitted'
  const text = (typeof raw === 'string' ? raw : str(raw)).trim()
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])]
    const day = midnight(y, m, d)
    // An impossible date (2026-02-30) rolls into another day; a pre-epoch one predates every session.
    return day.getFullYear() === y && day.getMonth() === m && day.getDate() === d && day.getTime() >= 0 ? { kind: 'date', day } : 'invalid'
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return 'invalid'
  const at = Number(text)
  return Number.isFinite(at) && at <= MAX_SECONDS ? { kind: 'num', at } : 'invalid'
}
/** An endpoint as a range start (a date's midnight) or exclusive end (the next midnight). */
const startOf = (e: Endpoint): number => (e.kind === 'num' ? e.at : e.day.getTime() / 1000)
const endOf = (e: Endpoint): number => (e.kind === 'num' ? e.at : addDays(e.day, 1).getTime() / 1000)
/** The last day holding an admitted instant; an empty range `[t, t)` shows `t`'s day. */
const lastDay = (start: number, end: number, throughNow: boolean): Date => (throughNow || end <= start ? dayOf(Math.max(start, end)) : dayOf(end - 0.001))

export interface InsightsRangeQuery { days?: unknown; start?: unknown; end?: unknown }
type InsightsFallback = NonNullable<InsightsRange['fallback_reason']>
type InsightsAdjustment = InsightsRange['adjustments'][number]

/**
 * TAL-1117: resolve a read's `days` preset or `start`/`end` custom range on the server calendar. Omitting both reads the
 * trailing `days` preset (1 to 365, default 30). A date is a whole day: as a start its midnight, as an end the next
 * midnight. Exact seconds bound a half-open interval. An omitted end, or one past the clock, runs through now; an omitted
 * start opens the preset's trailing window ending on the end's last day. Reversed endpoints swap roles; a range longer
 * than five calendar years keeps its last five. A blank, impossible, pre-epoch or out-of-range endpoint, or a start
 * after the clock, falls back to the preset with `fallback_reason` saying why.
 */
export function resolveInsightsRange(query: InsightsRangeQuery, nowSeconds: number): InsightsRange {
  const parsed = Number.parseInt(str(query.days ?? '30'), 10)
  const days = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 365) : 30
  const today = dayOf(nowSeconds)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const range = (mode: InsightsRange['mode'], start: number, end: number, throughNow: boolean, fallback: InsightsFallback | null, adjustments: InsightsAdjustment[]): InsightsRange => {
    const first = dayOf(start)
    const last = lastDay(start, end, throughNow)
    return {
      mode, start, end, through_now: throughNow, start_date: dayKey(first), end_date: dayKey(last), today: dayKey(today), timezone,
      bucket: daysBetween(first, last) + 1 > MAX_DAILY_BUCKETS ? 'month' : 'day', fallback_reason: fallback, adjustments,
    }
  }
  const preset = (fallback: InsightsFallback | null) => range('preset', addDays(today, 1 - days).getTime() / 1000, nowSeconds, true, fallback, [])

  let start = parseEndpoint(query.start)
  let end = parseEndpoint(query.end)
  if (start === 'omitted' && end === 'omitted') return preset(null)
  if (start === 'invalid') return preset('invalid_start')
  if (end === 'invalid') return preset('invalid_end')
  const adjustments: InsightsAdjustment[] = []
  const bounds = (s: Endpoint | 'omitted', e: Endpoint | 'omitted'): [number, number] => {
    const upper = e === 'omitted' ? nowSeconds : endOf(e)
    // The trailing window ends on the requested end's last day, before any clamp to the clock.
    return [s === 'omitted' ? addDays(dayOf(upper - 0.001), 1 - days).getTime() / 1000 : startOf(s), upper]
  }
  let [from, to] = bounds(start, end)
  // A start at a whole-day end's next midnight means that whole day, as a start after it does.
  if (start !== 'omitted' && end !== 'omitted' && (from > to || (from === to && end.kind === 'date'))) {
    [start, end] = [end, start]
    ;[from, to] = bounds(start, end)
    adjustments.push('reversed')
  }
  if (from > nowSeconds) return preset('future')
  // An exact end at the clock stays exclusive; only an omitted or clamped end includes the clock's own second.
  const throughNow = (end === 'omitted' || to > nowSeconds) && from < nowSeconds
  to = Math.min(to, nowSeconds)
  const last = lastDay(from, to, throughNow)
  // Five calendar years back from the last day; Feb 29 lands on Feb 28 in a common year.
  const leap = last.getMonth() === 1 && last.getDate() === 29
  const floor = midnight(last.getFullYear() - CAP_YEARS, last.getMonth(), leap ? 28 : last.getDate())
  if (dayOf(from) < floor) {
    from = floor.getTime() / 1000
    adjustments.push('capped')
  }
  return range('custom', from, to, throughNow, null, adjustments)
}

/**
 * `input_tokens` is the whole prompt (uncached, cache reads, and cache writes) for both sources, so a cache hit rate
 * divides reads by it alone.
 *
 * `stateRows` reads the state.db sessions active since the window's cutoff. An id already in the index counts once with
 * each counter's larger value: a claimed CLI session's index entry starts at zero while its state.db row keeps the
 * usage from before the claim and the Agent's later turns. The later activity time places it in the window, and the
 * snapshot with that activity names its model.
 *
 * The window is `resolveInsightsRange`'s (TAL-1117), never later than the server clock: a session whose activity time is
 * later (clock skew, a bad import) counts nowhere. Totals and every chart admit the same sessions.
 */
export async function buildInsights(entries: Dict[], query: InsightsRangeQuery, nowSeconds: number, stateRows: (cutoff: number) => Dict[] | Promise<Dict[]> = () => []): Promise<Dict> {
  const range = resolveInsightsRange(query, nowSeconds)
  const first = dayOf(range.start)
  const last = lastDay(range.start, range.end, range.through_now)
  const days = daysBetween(first, last) + 1
  // Local calendar days or months, not 86,400-second steps: a DST change makes a day 23 or 25 hours long (TAL-1115).
  const bucketKey = (d: Date): string => (range.bucket === 'day' ? dayKey(d) : dayKey(d).slice(0, 7))
  const buckets = range.bucket === 'day'
    ? Array.from({ length: days }, (_, i) => addDays(first, i))
    : Array.from({ length: (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth() + 1 }, (_, i) => (i ? midnight(first.getFullYear(), first.getMonth() + i, 1) : first))
  const admitted = (t: number): boolean => t >= range.start && (range.through_now ? t <= range.end : t < range.end)
  const state = new Map((await stateRows(range.start)).map((r) => [str(r.session_id), r]))
  const merged = entries.map((e) => {
    const row = state.get(str(e.session_id))
    if (!row) return e
    state.delete(str(e.session_id))
    const model = num(row.updated_at) > num(e.updated_at) ? str(row.model) || str(e.model) : str(e.model) || str(row.model)
    return { ...e, ...Object.fromEntries(USAGE_FIELDS.map((k) => [k, Math.max(num(e[k]), num(row[k]))])), estimated_cost: Math.max(cost(e.estimated_cost), cost(row.estimated_cost)), updated_at: Math.max(num(e.updated_at), num(row.updated_at)), model }
  })
  const sessions = [...merged, ...state.values()].filter((e) => admitted(activityAt(e)))
  let totalMessages = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCache = 0
  let totalCost = 0
  const models = new Map<string, { sessions: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost: number }>()
  const daily = new Map<string, { input_tokens: number; output_tokens: number; cache_read_tokens: number; sessions: number; cost: number }>()
  const dow = new Array<number>(7).fill(0)
  const hod = new Array<number>(24).fill(0)
  for (const s of sessions) {
    const input = num(s.input_tokens)
    const output = num(s.output_tokens)
    const cache = num(s.cache_read_tokens)
    const c = cost(s.estimated_cost)
    totalMessages += num(s.message_count)
    totalInput += input
    totalOutput += output
    totalCache += cache
    totalCost += c
    const model = str(s.model) || 'unknown'
    const bucket = models.get(model) ?? { sessions: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost: 0 }
    bucket.sessions += 1
    bucket.input_tokens += input
    bucket.output_tokens += output
    bucket.cache_read_tokens += cache
    bucket.cost += c
    models.set(model, bucket)
    const ts = activityAt(s)
    if (ts) {
      const d = new Date(ts * 1000)
      const key = bucketKey(d)
      const day = daily.get(key) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, sessions: 0, cost: 0 }
      day.input_tokens += input
      day.output_tokens += output
      day.cache_read_tokens += cache
      day.sessions += 1
      day.cost += c
      daily.set(key, day)
      dow[(d.getDay() + 6) % 7] = (dow[(d.getDay() + 6) % 7] ?? 0) + 1
      hod[d.getHours()] = (hod[d.getHours()] ?? 0) + 1
    }
  }
  const totalSessions = sessions.length
  const totalTokens = totalInput + totalOutput
  const breakdown = [...models.entries()].map(([model, stats]) => {
    const rowTotal = stats.input_tokens + stats.output_tokens
    const rowCost = Math.round(stats.cost * 1e6) / 1e6
    const shares = {
      session_share: totalSessions ? Math.round((stats.sessions / totalSessions) * 100) : 0, token_share: totalTokens ? Math.round((rowTotal / totalTokens) * 100) : 0, cost_share: totalCost ? Math.round((rowCost / totalCost) * 100) : 0,
    }
    return {
      model, sessions: stats.sessions, input_tokens: stats.input_tokens, output_tokens: stats.output_tokens, cache_read_tokens: stats.cache_read_tokens,
      cache_hit_percent: promptCacheHitPercent(stats.cache_read_tokens, stats.input_tokens), total_tokens: rowTotal, cost: rowCost,
      ...shares,
      // TAL-1750: the one share a row displays: cost when there is any, else tokens, else sessions.
      display_share: [shares.cost_share, shares.token_share, shares.session_share].find((share) => share > 0) ?? shares.cost_share,
    }
  // Python: `(-cost, -sessions, model)`.
  }).sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
  const series: Dict[] = buckets.map((d) => {
    const b = daily.get(bucketKey(d)) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, sessions: 0, cost: 0 }
    return { date: dayKey(d), input_tokens: b.input_tokens, output_tokens: b.output_tokens, total_tokens: b.input_tokens + b.output_tokens, cache_read_tokens: b.cache_read_tokens, sessions: b.sessions, cost: Math.round(b.cost * 1e6) / 1e6 }
  })
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const byDay = labels.map((_, i) => dow[i] ?? 0)
  const chartPeaks = {
    daily: { tokens: chartPeak(series.map((d) => Number(d.total_tokens))), cost: chartPeak(series.map((d) => Number(d.cost))), sessions: chartPeak(series.map((d) => Number(d.sessions))) },
    by_day: chartPeak(byDay), by_hour: chartPeak(hod),
  }
  return {
    period_days: days, range, total_sessions: totalSessions, total_messages: totalMessages, total_input_tokens: totalInput, total_output_tokens: totalOutput, total_cache_read_tokens: totalCache,
    total_cache_hit_percent: promptCacheHitPercent(totalCache, totalInput), total_tokens: totalTokens, total_cost: Math.round(totalCost * 1e6) / 1e6, models: breakdown, daily_tokens: series,
    activity_by_day: labels.map((day, i) => ({ day, sessions: byDay[i] ?? 0 })), activity_by_hour: hod.map((sessions, hour) => ({ hour, sessions })), chart_peaks: chartPeaks,
  }
}
