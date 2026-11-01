import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import type { InsightsTab } from '../../contracts/url'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useLocale } from '../../i18n/useLocale'
import { formatCompact, formatPercent } from '../../i18n/units'
import { useProviderQuotas } from '../../lib/useProviderQuotas'
import { HubPage } from '../../shell/AppShell'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState, formatUsd } from '../../ui/States'
import { BarChart } from './BarChart'
import { ProviderQuotaRows } from './ProviderQuotaRows'
import { cn } from '../../ui/cn'

const PERIODS = [7, 30, 90, 365]
const TABS: { id: InsightsTab; label: () => string }[] = [{ id: 'quotas', label: m.insights_tab_quotas }, { id: 'usage', label: m.insights_tab_usage }]
const METRICS = ['tokens', 'cost', 'sessions'] as const
type Metric = (typeof METRICS)[number]

/** The server's `YYYY-MM-DD` bucket as a local day; a UTC parse would shift it a day west of Greenwich. */
function localDay(date: string): Date | null {
  const [y, mo, d] = date.split('-').map(Number)
  return y && mo && d ? new Date(y, mo - 1, d) : null
}

/** Insights: a Quotas tab of every provider account's windows, and a Usage tab of the period's analytics (TAL-1750). */
export function InsightsPage() {
  const locale = useLocale()
  const search = useSearch({ from: '/_app/insights' })
  const navigate = useNavigate()
  const tab: InsightsTab = search.tab ?? 'quotas'
  const days = search.days ?? 30
  const setTab = (next: InsightsTab) => { void navigate({ to: '/insights', search: { ...search, tab: next }, replace: true }) }
  const setDays = (next: number) => { void navigate({ to: '/insights', search: { ...search, days: next }, replace: true }) }
  const [metric, setMetric] = useState<Metric>('tokens')
  const insights = useQuery({ queryKey: keys.insights(days), queryFn: () => api.fetchInsights(days), staleTime: 60_000, enabled: tab === 'usage' })
  const { quotas, refresh } = useProviderQuotas()
  const d = insights.data

  const integer = new Intl.NumberFormat(locale)
  const compact = (n: number) => formatCompact(locale, n)
  const usd = (n: number) => formatUsd(n, locale)
  const percent = (n: number) => formatPercent(locale, n)
  const dayLabel = (date: string) => localDay(date)?.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) ?? date
  const metricLabel: Record<Metric, string> = { tokens: m.insights_tokens(), cost: m.insights_cost(), sessions: m.insights_sessions() }
  const metricValue: Record<Metric, (r: NonNullable<typeof d>['daily_tokens'] extends (infer R)[] | undefined ? R : never) => number> = {
    tokens: (r) => r.total_tokens ?? (r.input_tokens ?? 0) + (r.output_tokens ?? 0), cost: (r) => r.cost ?? 0, sessions: (r) => r.sessions ?? 0,
  }
  const metricFormat: Record<Metric, (n: number) => string> = { tokens: compact, cost: usd, sessions: (n) => integer.format(n) }

  const stats = d ? [
    { label: m.insights_sessions(), value: integer.format(d.total_sessions ?? 0) },
    { label: m.insights_messages(), value: integer.format(d.total_messages ?? 0) },
    { label: m.insights_input_tokens(), value: compact(d.total_input_tokens ?? 0), title: integer.format(d.total_input_tokens ?? 0) },
    { label: m.insights_output_tokens(), value: compact(d.total_output_tokens ?? 0), title: integer.format(d.total_output_tokens ?? 0) },
    { label: m.insights_tokens(), value: compact(d.total_tokens ?? 0), title: integer.format(d.total_tokens ?? 0) },
    { label: m.insights_cost(), value: usd(d.total_cost ?? 0) },
    { label: m.insights_cache_read(), value: compact(d.total_cache_read_tokens ?? 0), title: integer.format(d.total_cache_read_tokens ?? 0) },
    ...(d.total_cache_hit_percent === null || d.total_cache_hit_percent === undefined ? [] : [{ label: m.insights_cache_hit(), value: percent(d.total_cache_hit_percent) }]),
  ] : []

  return (
    <HubPage
      title={m.tab_insights()}
      toolbar={
        <>
          <div role="tablist" aria-label={m.tab_insights()} className="flex gap-1">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`insights-${t.id}`} onClick={() => setTab(t.id)} className={cn('rounded-md px-3 py-1.5 text-sm', tab === t.id ? 'bg-accent-bg text-accent-text' : 'text-muted hover:bg-hover hover:text-text')}>
                {t.label()}
              </button>
            ))}
          </div>
          {tab === 'usage' && <label className="ml-auto flex items-center gap-2 text-xs text-muted">{m.insights_period()} <Select value={days} onValueChange={(v) => setDays(Number(v))}>{PERIODS.map((p) => <option key={p} value={p}>{m.insights_days({ n: p })}</option>)}</Select></label>}
        </>
      }
    >
      <div className="flex flex-col gap-8" id="insightsContent">
        {tab === 'quotas' && <div role="tabpanel" id="insights-quotas"><ProviderQuotaRows quotas={quotas} onRefresh={() => { void refresh() }} /></div>}

        {tab === 'usage' && <section role="tabpanel" id="insights-usage" className="flex flex-col gap-4" data-section="insights-usage">
          {insights.isPending && <LoadingState />}
          {insights.isError && <ErrorState error={insights.error} onRetry={() => { void insights.refetch() }} />}
          {d && (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" data-testid="insights-stats">
                {stats.map((s) => (
                  <div key={s.label} className="min-w-0">
                    <dt className="text-xs uppercase tracking-wider text-muted">{s.label}</dt>
                    <dd className="truncate text-lg font-semibold text-strong" title={s.title}>{s.value}</dd>
                  </div>
                ))}
              </dl>
              {(d.total_sessions ?? 0) === 0 && <EmptyState>{m.insights_no_data()}</EmptyState>}
              {d.daily_tokens && d.daily_tokens.length > 1 && (
                <BarChart
                  id="daily"
                  title={m.insights_daily()}
                  rows={d.daily_tokens.map((r) => ({ label: dayLabel(r.date), title: r.date, value: metricValue[metric](r) }))}
                  format={metricFormat[metric]}
                  controls={<Select value={metric} onValueChange={(v) => setMetric(v as Metric)} aria-label={m.insights_metric()} className="h-7 text-xs">{METRICS.map((k) => <option key={k} value={k}>{metricLabel[k]}</option>)}</Select>}
                />
              )}
              <div className="grid gap-6 md:grid-cols-2">
                {d.activity_by_day && d.activity_by_day.length > 0 && <BarChart id="weekday" title={m.insights_by_day()} rows={d.activity_by_day.map((r) => ({ label: r.day, value: r.sessions }))} format={(n) => integer.format(n)} />}
                {d.activity_by_hour && d.activity_by_hour.length > 0 && <BarChart id="hour" title={m.insights_by_hour()} rows={d.activity_by_hour.map((r) => ({ label: String(r.hour), title: `${String(r.hour).padStart(2, '0')}:00`, value: r.sessions }))} format={(n) => integer.format(n)} />}
              </div>
              {d.models && d.models.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full whitespace-nowrap text-sm tabular-nums" data-testid="insights-models">
                    <caption className="mb-1 text-left text-sm font-medium text-text">{m.insights_models()}</caption>
                    <thead>
                      <tr className="text-left text-xs text-muted">
                        <th className="py-1 pr-3 font-normal">{m.insights_model_name()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_sessions()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_model_input()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_model_output()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_tokens()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_model_cost()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_model_cache()}</th>
                        <th className="py-1 pl-3 text-right font-normal">{m.insights_model_share()}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.models.map((r, i) => {
                        const share = r.display_share
                        return (
                          <tr key={`${r.model ?? ''}-${String(i)}`} className="border-t border-border-subtle">
                            <td className="py-1 pr-3 font-mono text-xs text-text">{r.model ?? '—'}</td>
                            <td className="py-1 pl-3 text-right">{integer.format(r.sessions ?? 0)}</td>
                            <td className="py-1 pl-3 text-right" title={integer.format(r.input_tokens ?? 0)}>{compact(r.input_tokens ?? 0)}</td>
                            <td className="py-1 pl-3 text-right" title={integer.format(r.output_tokens ?? 0)}>{compact(r.output_tokens ?? 0)}</td>
                            <td className="py-1 pl-3 text-right" title={integer.format(r.total_tokens ?? 0)}>{compact(r.total_tokens ?? 0)}</td>
                            <td className="py-1 pl-3 text-right">{usd(r.cost ?? 0)}</td>
                            <td className="py-1 pl-3 text-right">{r.cache_hit_percent === null || r.cache_hit_percent === undefined ? '—' : percent(r.cache_hit_percent)}</td>
                            <td className="py-1 pl-3 text-right">{share === undefined ? '—' : percent(share)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>}
      </div>
    </HubPage>
  )
}
