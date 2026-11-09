/**
 * TAL-1973: the `harness` toolset's `usage_read`. The calling session's tokens, cost, turns and context as the session
 * payloads report them, and its provider's quota windows from the last `/api/provider/quotas` read, each figure with the
 * text the agent quotes. It never reads a provider.
 */
import { QuotaSourceSchema, type SidecarServerResultInput } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import { contextUsage, type Session } from './session.js'

type UsageRead = SidecarServerResultInput<'server.usage_read'>

const COUNT = new Intl.NumberFormat('en-US')
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

const tokens = (n: number) => ({ tokens: n, text: COUNT.format(n) })
const percent = (n: number) => ({ percent: n, text: `${String(Math.round(n))}%` })
const usd = (n: number | null) => ({ usd: n, text: n === null ? 'unknown' : USD.format(n) })
const nonnegative = (v: unknown): number => { const n = Math.trunc(Number(v ?? 0)); return Number.isFinite(n) && n > 0 ? n : 0 }
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `in 2h 5m` or `3m ago`, the largest two units, against `now` in Unix seconds. */
function relative(iso: unknown, now: number): { at: string; text: string } | null {
  const at = typeof iso === 'string' ? Date.parse(iso) / 1000 : NaN
  if (!Number.isFinite(at)) return null
  const minutes = Math.round(Math.abs(at - now) / 60)
  const parts = [[Math.floor(minutes / 1440), 'd'], [Math.floor(minutes / 60) % 24, 'h'], [minutes % 60, 'm']] as const
  const first = parts.findIndex(([n]) => n > 0)
  const span = first < 0 ? 'under 1m' : parts.slice(first, first + 2).filter(([n]) => n > 0).map(([n, unit]) => `${String(n)}${unit}`).join(' ')
  return { at: new Date(at * 1000).toISOString(), text: at >= now ? `in ${span}` : `${span} ago` }
}

export async function usageRead(deps: Pick<AppDeps, 'sessions' | 'sessionStore' | 'catalog' | 'profileHome'>, caller: Session): Promise<UsageRead> {
  const sid = caller.session_id
  const { now, contextLengthFor, contextWindowSourceFor } = deps.sessions.deps
  // `/api/session/usage`'s figures, so the agent and the composer agree.
  const usage = await deps.sessions.usage(sid)
  const session = await deps.sessionStore.get(sid)
  const context = contextUsage(session, () => contextLengthFor(session.model, session.model_provider), () => contextWindowSourceFor(session.model, session.model_provider))
  const threshold = nonnegative(session.threshold_tokens)
  const profile = session.profile ?? 'default'
  const rows = (await deps.catalog.cachedQuotaSources(deps.profileHome(profile), profile))?.map((row) => QuotaSourceSchema.parse(row)) ?? null
  const provider = session.model_provider || rows?.find((row) => row.is_active_provider)?.provider_id || null
  const turns = session.userMessageCount()
  const base = {
    session_id: sid, model: typeof usage.model === 'string' ? usage.model : null, provider,
    input_tokens: tokens(nonnegative(usage.input_tokens)), output_tokens: tokens(nonnegative(usage.output_tokens)), cache_read_tokens: tokens(nonnegative(session.cache_read_tokens)),
    cost: usd(finite(usage.estimated_cost)), turns: { count: turns, text: COUNT.format(turns) },
    context: {
      used_tokens: context.context_used_tokens ? tokens(context.context_used_tokens) : null,
      context_length: context.context_window_tokens ? tokens(context.context_window_tokens) : null,
      threshold_tokens: threshold ? tokens(threshold) : null,
      percent_used: context.context_usage_percent === null || context.context_usage_percent === undefined ? null : percent(context.context_usage_percent),
    },
  }
  const unavailable = (reason: string): UsageRead => ({ ...base, quota: null, quota_reason: reason })
  if (!rows) return unavailable('Talaria has no quota reading cached; it reads quotas when the sidebar or Insights shows them.')
  if (!provider) return unavailable('This session has no provider to read quotas for.')
  const own = rows.filter((row) => row.provider_id === provider)
  const t = now()
  const sources = own.flatMap((row) => {
    const credits = finite((row.quota as { limit_remaining?: unknown } | null | undefined)?.limit_remaining)
    const windows = (row.windows ?? []).map((w) => ({
      label: w.label, used_percent: finite(w.used_percent) === null ? null : percent(w.used_percent!), remaining_percent: finite(w.remaining_percent) === null ? null : percent(w.remaining_percent!),
      resets_at: relative(w.reset_at, t), level: w.display_level ?? row.display_level ?? 'unavailable',
    }))
    if (!windows.length && credits === null) return []
    return [{ name: row.display_name ?? row.provider_label ?? provider, status: row.status ?? 'unavailable', level: row.display_level ?? 'unavailable', message: row.status_message ?? null, fetched_at: relative(row.fetched_at, t), credits: credits === null ? null : usd(credits), windows }]
  })
  if (sources.length) return { ...base, quota: { provider, sources }, quota_reason: null }
  // An available row's message only says it loaded; a refusal's names why there is no quota.
  if (!own.length) return unavailable(`Talaria has no quota source for ${provider}.`)
  return unavailable(own.find((row) => row.status !== 'available' && row.status_message)?.status_message ?? `${own[0]!.display_name ?? provider} reports no quota windows or credits.`)
}
