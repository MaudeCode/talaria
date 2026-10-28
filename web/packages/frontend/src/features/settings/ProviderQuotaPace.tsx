import type { PlanGauge, PlanUsage } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import { formatDurationUnits, resetTime } from '../../i18n/units'
import type { ProviderQuotaSourceSchema } from '../../contracts'
import { QuotaUrgency } from './QuotaThresholds'

type QuotaSource = z.infer<typeof ProviderQuotaSourceSchema>

/** Minutes as `1d 6h` / `18h` / `45m`; formatting only, the minutes are the server's. */
function formatMinutes(locale: string, minutes: number): string {
  const total = Math.round(Math.abs(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  if (days > 0) return formatDurationUnits(locale, [days, 'day'], [hours, 'hour'])
  return hours > 0 ? formatDurationUnits(locale, [hours, 'hour']) : formatDurationUnits(locale, [total, 'minute'])
}

/** The server-selected pace window (`pace_window_index`) of a quota source and the source's urgency; every value is a TAL-409/TAL-411 contract field. */
export function ProviderQuotaPace({ source, showAccount = false, plan, planStale = false, gauge, compact = false }: { source?: QuotaSource; showAccount?: boolean; plan?: PlanUsage | null | undefined; planStale?: boolean | undefined; gauge?: PlanGauge | null | undefined; compact?: boolean }) {
  const locale = useLocale()
  const allowance = plan ?? source?.plan_usage
  const stale = planStale || source?.plan_stale
  if (gauge) return <span className="text-[11px] tabular-nums text-muted" data-plan-gauge={gauge.id}>
    {m.plan_used({ label: gauge.label, percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(gauge.used_bp / 10000) })}
    {gauge.resets_at_ms !== null && <span> · {m.provider_quota_resets({ time: resetTime(locale, gauge.resets_at_ms) })}</span>}
  </span>
  if (allowance) return <div className={compact ? 'px-2.5 py-1 text-xs text-muted' : 'mt-2 border-t border-border pt-2 text-xs text-muted'} data-testid="provider-plan-usage">
    <div className="flex flex-wrap gap-x-2"><span className="font-medium text-text">{allowance.plan}</span>{stale && <span>{m.catalog_last_confirmed()}</span>}{allowance.paused_reason && <span>{m.plan_paused()}</span>}</div>
    {allowance.gauges.map((g) => <div key={`${g.scope}:${g.label}`} className="flex flex-wrap gap-x-2 tabular-nums"><span>{g.title || g.label}</span><span>{m.plan_remaining({ percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(g.left_fraction) })}</span>{g.resets_at_ms !== null && <span>{m.provider_quota_resets({ time: resetTime(locale, g.resets_at_ms) })}</span>}</div>)}
    {allowance.credits_pay === true && !stale && !allowance.paused_reason && <span>{m.plan_credits_cover()}</span>}
  </div>
  if (!source) return null
  const w = source.pace_window_index == null ? undefined : source.windows?.[source.pace_window_index]
  if (!w) {
    if (!source.urgency) return null
    return (
      <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2 text-[11px] text-muted">
        {showAccount && source.account_label && <span className="font-medium text-text">{source.account_label}</span>}
        <QuotaUrgency urgency={source.urgency} />
      </div>
    )
  }
  const { pace, forecast } = w
  const percent = (value: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100)
  return (
    <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2 text-[11px] text-muted" data-testid="provider-quota-pace">
      <QuotaUrgency urgency={source.urgency} />
      <div className="flex flex-wrap gap-x-3">
        <span className="font-medium text-text">{showAccount && source.account_label ? `${source.account_label} · ${w.label}` : w.label}</span>
        {w.remaining_percent !== null && <span>{m.provider_quota_remaining({ percent: percent(w.remaining_percent) })}</span>}
        {w.reset_at !== null && <span>{m.provider_quota_resets({ time: new Date(w.reset_at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3">
        {pace ? (
          <>
            <span>{pace.status === 'over' ? m.provider_quota_over_pace({ percent: percent(-pace.pace_delta_percent) }) : pace.status === 'under' ? m.provider_quota_under_pace({ percent: percent(pace.pace_delta_percent) }) : m.provider_quota_on_pace()}</span>
            <span>{m.provider_quota_burn({ rate: `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(pace.burn_rate)}×` })}</span>
          </>
        ) : <span>{m.provider_quota_pace_unavailable()}</span>}
        {forecast ? (
          <>
            {forecast.budget_percent !== null && <span>{(forecast.budget_unit === 'day' ? m.provider_quota_budget_day : m.provider_quota_budget_hour)({ percent: percent(forecast.budget_percent) })}</span>}
            <span>{forecast.outcome === 'warning' && forecast.depletion_margin_minutes !== null ? m.provider_quota_empty_early({ duration: formatMinutes(locale, forecast.depletion_margin_minutes) }) : m.provider_quota_lasts_through_reset()}</span>
          </>
        ) : <span>{m.provider_quota_forecast_unavailable()}</span>}
      </div>
    </div>
  )
}
