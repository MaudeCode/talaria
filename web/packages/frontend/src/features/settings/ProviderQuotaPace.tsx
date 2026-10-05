import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import type { ProviderQuotaSourceSchema } from '../../contracts'

type QuotaSource = z.infer<typeof ProviderQuotaSourceSchema>

/** Minutes as `1d 6h` / `18h` / `45m`; formatting only, the minutes are the server's. */
function formatMinutes(locale: string, minutes: number): string {
  const unit = (n: number, u: 'day' | 'hour' | 'minute') => new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n)
  const total = Math.round(Math.abs(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  if (days > 0) return `${unit(days, 'day')} ${unit(hours, 'hour')}`
  return hours > 0 ? unit(hours, 'hour') : unit(total, 'minute')
}

/** The server-selected pace window (`pace_window_index`) of a quota source; every value is a TAL-409 contract field. */
export function ProviderQuotaPace({ source, showAccount }: { source: QuotaSource; showAccount: boolean }) {
  const locale = useLocale()
  const w = source.pace_window_index == null ? undefined : source.windows?.[source.pace_window_index]
  if (!w) return null
  const { pace, forecast } = w
  const percent = (value: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100)
  return (
    <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2 text-[11px] text-muted" data-testid="provider-quota-pace">
      <div className="flex flex-wrap gap-x-3">
        <span className="font-medium text-text">{showAccount && source.account_label ? `${source.account_label} · ${w.label}` : w.label}</span>
        {w.remaining_percent !== null && <span>{m.provider_quota_remaining({ percent: percent(w.remaining_percent) })}</span>}
        {w.reset_at !== null && <span>{m.provider_quota_resets({ time: new Date(w.reset_at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3">
        {pace ? (
          <>
            <span>{pace.pace_delta_percent < 0 ? m.provider_quota_over_pace({ percent: percent(-pace.pace_delta_percent) }) : pace.pace_delta_percent > 0 ? m.provider_quota_under_pace({ percent: percent(pace.pace_delta_percent) }) : m.provider_quota_on_pace()}</span>
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
