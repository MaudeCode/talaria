/** Usage analytics from the session index plus the Agent's state.db sessions (Python `_handle_insights`). */
import type { Dict } from '../config/agent-config.js'
import { str } from '../util.js'

const num = (v: unknown): number => { const n = Number.parseFloat(str(v)); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }
const cost = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const text = typeof v === 'string' ? v.trim().replaceAll('$', '').replaceAll(',', '') : str(v)
  if (!text) return 0
  const n = Number.parseFloat(text)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function cacheHitPercent(cacheRead: number, prompt: number): number | null {
  if (cacheRead <= 0 || prompt <= 0) return null
  return Math.min(100, Math.round((cacheRead / prompt) * 100))
}

const USAGE_FIELDS = ['message_count', 'input_tokens', 'output_tokens', 'cache_read_tokens'] as const

/**
 * `stateRows` reads the state.db sessions active since the window's cutoff. An id already in the index counts once with
 * each counter's larger value: a claimed CLI session's index entry starts at zero while its state.db row keeps the
 * usage from before the claim and the Agent's later turns. The later activity time places it in the window, and the
 * snapshot with that activity names its model.
 */
export function buildInsights(entries: Dict[], daysRaw: unknown, nowSeconds: number, stateRows: (cutoff: number) => Dict[] = () => []): Dict {
  const parsed = Number.parseInt(str(daysRaw ?? '30'), 10)
  const days = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 365) : 30
  const today = new Date(nowSeconds * 1000)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000
  const cutoff = midnight - (days - 1) * 86_400
  const state = new Map(stateRows(cutoff).map((r) => [str(r.session_id), r]))
  const merged = entries.map((e) => {
    const row = state.get(str(e.session_id))
    if (!row) return e
    state.delete(str(e.session_id))
    const model = num(row.updated_at) > num(e.updated_at) ? str(row.model) || str(e.model) : str(e.model) || str(row.model)
    return { ...e, ...Object.fromEntries(USAGE_FIELDS.map((k) => [k, Math.max(num(e[k]), num(row[k]))])), estimated_cost: Math.max(cost(e.estimated_cost), cost(row.estimated_cost)), updated_at: Math.max(num(e.updated_at), num(row.updated_at)), model }
  })
  const sessions = [...merged, ...state.values()].filter((e) => Math.max(num(e.created_at), num(e.updated_at)) >= cutoff)
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
    const ts = num(s.updated_at) || num(s.created_at)
    if (ts) {
      const d = new Date(ts * 1000)
      const key = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
    return {
      model, sessions: stats.sessions, input_tokens: stats.input_tokens, output_tokens: stats.output_tokens, cache_read_tokens: stats.cache_read_tokens,
      cache_hit_percent: cacheHitPercent(stats.cache_read_tokens, stats.input_tokens + stats.cache_read_tokens), total_tokens: rowTotal, cost: rowCost,
      session_share: totalSessions ? Math.round((stats.sessions / totalSessions) * 100) : 0, token_share: totalTokens ? Math.round((rowTotal / totalTokens) * 100) : 0, cost_share: totalCost ? Math.round((rowCost / totalCost) * 100) : 0,
    }
  // Python: `(-cost, -sessions, model)`.
  }).sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
  const series: Dict[] = []
  for (let i = 0; i < days; i += 1) {
    const d = new Date((cutoff + i * 86_400) * 1000)
    const key = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const b = daily.get(key) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, sessions: 0, cost: 0 }
    series.push({ date: key, input_tokens: b.input_tokens, output_tokens: b.output_tokens, cache_read_tokens: b.cache_read_tokens, sessions: b.sessions, cost: Math.round(b.cost * 1e6) / 1e6 })
  }
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return {
    period_days: days, total_sessions: totalSessions, total_messages: totalMessages, total_input_tokens: totalInput, total_output_tokens: totalOutput, total_cache_read_tokens: totalCache,
    total_cache_hit_percent: cacheHitPercent(totalCache, totalInput + totalCache), total_tokens: totalTokens, total_cost: Math.round(totalCost * 1e6) / 1e6, models: breakdown, daily_tokens: series,
    activity_by_day: labels.map((day, i) => ({ day, sessions: dow[i] ?? 0 })), activity_by_hour: hod.map((sessions, hour) => ({ hour, sessions })),
  }
}
