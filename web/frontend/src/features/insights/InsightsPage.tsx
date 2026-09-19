import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'

const PERIODS = [7, 30, 90, 365]

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-strong">{value}</div>
    </div>
  )
}

/** Bars are inline SVG on tokens; the table beneath is the accessible source of truth. */
function Bars({ title, rows }: { title: string; rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <section className="rounded-lg border border-border bg-surface p-3">
      <h2 className="mb-2 text-sm font-medium text-text">{title}</h2>
      <svg viewBox={`0 0 ${rows.length * 12} 60`} className="h-20 w-full" role="img" aria-label={title} preserveAspectRatio="none">
        {rows.map((r, i) => (
          <rect key={r.label} x={i * 12 + 1} y={60 - (r.value / max) * 56} width={10} height={(r.value / max) * 56} fill="var(--accent)" opacity={0.85}><title>{`${r.label}: ${r.value}`}</title></rect>
        ))}
      </svg>
      <table className="sr-only"><caption>{title}</caption><tbody>{rows.map((r) => <tr key={r.label}><th scope="row">{r.label}</th><td>{r.value}</td></tr>)}</tbody></table>
    </section>
  )
}

export function InsightsPage() {
  const [days, setDays] = useState(30)
  const insights = useQuery({ queryKey: keys.insights(days), queryFn: () => api.fetchInsights(days), staleTime: 60_000 })
  const d = insights.data
  return (
    <HubPage
      title={m.tab_insights()}
      toolbar={<label className="flex items-center gap-2 text-xs text-muted">{m.insights_period()} <Select value={days} onValueChange={(v) => setDays(Number(v))}>{PERIODS.map((p) => <option key={p} value={p}>{m.insights_days({ n: p })}</option>)}</Select></label>}
    >
      {insights.isPending && <LoadingState />}
      {insights.isError && <ErrorState error={insights.error} onRetry={() => { void insights.refetch() }} />}
      {d && (
        <div className="flex flex-col gap-4" id="insightsContent">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label={m.insights_sessions()} value={d.total_sessions ?? 0} />
            <Stat label={m.insights_messages()} value={d.total_messages ?? 0} />
            <Stat label={m.insights_tokens()} value={(d.total_tokens ?? 0).toLocaleString()} />
            <Stat label={m.insights_cost()} value={`$${(d.total_cost ?? 0).toFixed(2)}`} />
            <Stat label={m.insights_input_tokens()} value={(d.total_input_tokens ?? 0).toLocaleString()} />
            <Stat label={m.insights_output_tokens()} value={(d.total_output_tokens ?? 0).toLocaleString()} />
            <Stat label={m.insights_cache_read()} value={(d.total_cache_read_tokens ?? 0).toLocaleString()} />
          </div>
          {(d.total_sessions ?? 0) === 0 && <EmptyState>{m.insights_no_data()}</EmptyState>}
          {d.activity_by_day && d.activity_by_day.length > 0 && <Bars title={m.insights_by_day()} rows={d.activity_by_day.map((r) => ({ label: r.day, value: r.sessions }))} />}
          {d.activity_by_hour && d.activity_by_hour.length > 0 && <Bars title={m.insights_by_hour()} rows={d.activity_by_hour.map((r) => ({ label: String(r.hour), value: r.sessions }))} />}
          {d.daily_tokens && d.daily_tokens.length > 0 && <Bars title={m.insights_daily_tokens()} rows={d.daily_tokens.map((r) => ({ label: r.date, value: (r.input_tokens ?? 0) + (r.output_tokens ?? 0) }))} />}
          {d.models && d.models.length > 0 && (
            <table className="w-full text-sm">
              <caption className="mb-1 text-left text-sm font-medium text-text">{m.insights_models()}</caption>
              <thead><tr className="text-left text-xs text-muted"><th className="py-1">Model</th><th>{m.insights_sessions()}</th><th>{m.insights_tokens()}</th><th>{m.insights_cost()}</th></tr></thead>
              <tbody>{d.models.map((r, i) => <tr key={i} className="border-t border-border-subtle"><td className="py-1">{r.model ?? '—'}</td><td>{r.sessions ?? 0}</td><td>{(r.tokens ?? 0).toLocaleString()}</td><td>${(r.cost ?? 0).toFixed(2)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </HubPage>
  )
}
