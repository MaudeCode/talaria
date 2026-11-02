import type { UseQueryResult } from '@tanstack/react-query'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import { formatBurnRate, formatMinutes, formatPercent, resetTime } from '../../i18n/units'
import type { ProviderQuotaSourceSchema, ProviderQuotasSchema, QuotaLevel } from '../../contracts'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { cn } from '../../ui/cn'

type QuotaSource = z.infer<typeof ProviderQuotaSourceSchema>
type QuotaWindow = NonNullable<QuotaSource['windows']>[number]

/** Which server percent the headline, meter and marker show; the App's `ProviderQuotaPercentageMode`, `used` by default on both. */
export type QuotaPercentMode = 'used' | 'remaining'
export const QUOTA_PERCENT_MODES: QuotaPercentMode[] = ['used', 'remaining']
/** A stored or selected value as a mode; anything else is the default. */
export const toQuotaPercentMode = (value: string | null): QuotaPercentMode => (value === 'remaining' ? 'remaining' : 'used')

/** The meter fill per server level; `healthy` wears the accent like the App's rail, state colours are state only. */
const LEVEL_FILL: Record<QuotaLevel, string> = { healthy: 'bg-accent', warning: 'bg-warning', critical: 'bg-error', stale: 'bg-muted', unavailable: 'bg-muted' }

const STATUS_LABEL: Record<string, () => string> = {
  exhausted: m.provider_quota_status_exhausted, unavailable: m.provider_quota_status_unavailable, stale: m.quota_level_stale,
}

/**
 * Every `/api/provider/quotas` source with every window laid out like the App's Insights rows (TAL-1750, TAL-1782):
 * the window's headline percent in the chosen mode, a meter with the pace marker, the reset beside the forecast,
 * then Pace / Burn / Budget cells. Each value is a contract field (TAL-409 pace, TAL-411 urgency); the client only
 * formats. Settings › Providers keeps its sibling `ProviderQuotaPace`: one pace window as inline metadata.
 */
export function ProviderQuotaRows({ quotas, mode, onRefresh }: { quotas: UseQueryResult<z.infer<typeof ProviderQuotasSchema>>; mode: QuotaPercentMode; onRefresh: () => void }) {
  const locale = useLocale()
  const data = quotas.data
  return (
    <section className="flex flex-col gap-2" data-section="insights-quotas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text">{m.provider_quota_title()}</h2>
        <Button onClick={onRefresh} disabled={quotas.isFetching}>{quotas.isFetching ? m.provider_quota_refreshing() : m.providers_quota_refresh()}</Button>
      </div>
      {data?.availability?.unavailable_reason && <p role="status" className="text-xs text-muted">{data.availability.unavailable_reason}</p>}
      {quotas.isPending && <LoadingState compact />}
      {quotas.isError && !data && <ErrorState error={quotas.error} onRetry={onRefresh} />}
      {data?.sources.length === 0 && <EmptyState>{m.insights_quotas_empty()}</EmptyState>}
      {data && data.sources.length > 0 && (() => {
        // Accounts with windows or credits first; the rest (unsupported providers, rejected keys) in a compact group.
        const withData = data.sources.filter((s) => (s.windows?.length ?? 0) > 0 || s.quota)
        const unavailable = data.sources.filter((s) => !withData.includes(s))
        return (
          <>
            {withData.length > 0 && <ul className="flex flex-col">{withData.map((s) => <QuotaSourceRow key={s.source_id} source={s} mode={mode} locale={locale} />)}</ul>}
            {unavailable.length > 0 && (
              <section className="mt-4 flex flex-col gap-1" data-section="insights-quotas-unavailable">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted">{m.insights_quotas_unavailable()}</h3>
                <ul className="flex flex-col">
                  {unavailable.map((s) => (
                    <li key={s.source_id} className="flex flex-wrap items-baseline gap-x-2 border-t border-border-subtle py-2 text-xs" data-quota-source={s.source_id} data-quota-status={s.status ?? 'unavailable'}>
                      <span className="font-medium text-text">{s.provider_label ?? s.provider_id ?? s.source_id}</span>
                      <span className="text-muted">{typeof s.unavailable_reason === 'string' ? s.unavailable_reason : s.message ?? STATUS_LABEL[s.status ?? 'unavailable']?.() ?? s.status}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      })()}
    </section>
  )
}

function QuotaSourceRow({ source: s, mode, locale }: { source: QuotaSource; mode: QuotaPercentMode; locale: string }) {
  const name = s.provider_label ?? s.provider_id ?? s.source_id
  const account = s.account_label && s.account_label !== name ? s.account_label : null
  const plan = typeof s.plan === 'string' && s.plan ? s.plan : null
  const status = s.status ?? 'unavailable'
  const stale = status === 'stale' || status === 'unavailable'
  const quota = s.quota as { limit_remaining?: unknown } | null | undefined
  const credits = typeof quota?.limit_remaining === 'number' ? quota.limit_remaining : null
  const detail = Array.isArray(s.details) && typeof s.details[0] === 'string' ? s.details[0] : null
  return (
    <li className="flex flex-col gap-4 border-t border-border py-4 first:border-t-0" data-quota-source={s.source_id} data-quota-status={status}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-text">{name}</span>
        {account && <span className="text-xs text-muted">{account}</span>}
        {plan && <Badge tone="border-border text-muted">{plan}</Badge>}
        {s.is_active_provider && <Badge tone="border-accent text-accent-text">{m.provider_quota_active_provider()}</Badge>}
        {status !== 'available' && <span className={cn('text-xs', stale ? 'text-warning' : 'text-error')}>{typeof s.unavailable_reason === 'string' ? s.unavailable_reason : s.message ?? STATUS_LABEL[status]?.() ?? status}</span>}
      </div>
      {(s.windows ?? []).map((w, i) => <QuotaWindowRow key={`${w.label}-${String(i)}`} window={w} source={s} mode={mode} locale={locale} />)}
      {(s.windows ?? []).length === 0 && credits !== null && <div className="text-xs text-text tabular-nums">{m.provider_quota_credits_remaining({ amount: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(credits) })}</div>}
      {detail && <div className="text-xs text-muted">{detail}</div>}
      {(s.computed_at || typeof s.fetched_at === 'string') && (
        <div className={cn('text-xs', stale ? 'text-warning' : 'text-muted')}>
          {s.computed_at && m.provider_quota_as_of({ time: resetTime(locale, s.computed_at) })}
          {s.computed_at && typeof s.fetched_at === 'string' && ' · '}
          {typeof s.fetched_at === 'string' && m.provider_quota_last_checked({ a0: resetTime(locale, s.fetched_at) })}
          {stale && ` · ${m.quota_level_stale()}`}
        </div>
      )}
    </li>
  )
}

function QuotaWindowRow({ window: w, source, mode, locale }: { window: QuotaWindow; source: QuotaSource; mode: QuotaPercentMode; locale: string }) {
  const { pace, forecast } = w
  // A source the server marks stale or unavailable outranks its cached windows' levels (`reconcileProviderQuotas` keeps
  // the windows as they were); otherwise the window's pace level, which already falls back to its remaining
  // classification without a pace (TAL-411). The App's `ProviderQuotaPresentation.state` orders them the same way.
  const level: QuotaLevel = source.status !== 'available'
    ? source.urgency?.pace ?? 'unavailable'
    : w.urgency?.pace ?? source.urgency?.pace ?? 'healthy'
  // The headline, fill and marker read the server percent for the mode; the server ships both normalized.
  const percent = mode === 'used' ? w.used_percent : w.remaining_percent
  const marker = pace ? (mode === 'used' ? pace.expected_used_percent : pace.expected_remaining_percent) : null
  const modeLabel = mode === 'used' ? m.provider_quota_metric_used() : m.provider_quota_metric_remaining()
  // The server's minutes to reset, as of its `computed_at`; the list rereads every minute.
  const countdown = pace ? formatMinutes(locale, pace.minutes_to_reset) : null
  const clamp = (n: number) => `${String(Math.min(100, Math.max(0, n)))}%`
  return (
    <div className="flex flex-col gap-1.5" data-quota-window={w.label} data-level={level}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-text">{w.label}</span>
        {percent !== null ? (
          <span className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums text-strong">{formatPercent(locale, percent)}</span>
            <span className="text-xs text-muted">{modeLabel}</span>
          </span>
        ) : w.detail && <span className="text-xs text-muted">{w.detail}</span>}
      </div>
      {percent !== null && (
        <div className="relative h-2 overflow-hidden rounded-full bg-border" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={`${w.label}: ${formatPercent(locale, percent)} ${modeLabel}`}>
          <div className={cn('h-full rounded-full', LEVEL_FILL[level])} style={{ width: clamp(percent) }} />
          {marker !== null && <div aria-hidden="true" className="absolute inset-y-0 w-px bg-text" style={{ left: clamp(marker) }} />}
        </div>
      )}
      {(w.reset_at || forecast || (percent !== null && w.detail)) && (
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
          <span>
            {w.reset_at ? <>{m.provider_quota_resets({ time: resetTime(locale, w.reset_at) })}{countdown && ` · ${countdown}`}</> : percent !== null && w.detail}
          </span>
          {forecast && (
            <span className={cn('shrink-0', forecast.outcome === 'warning' && 'text-warning')} data-forecast={forecast.outcome}>
              {forecast.outcome === 'warning' && forecast.depletion_margin_minutes !== null ? m.provider_quota_empty_early({ duration: formatMinutes(locale, forecast.depletion_margin_minutes) }) : m.provider_quota_lasts_through_reset()}
            </span>
          )}
        </div>
      )}
      {pace && (
        <div className="mt-0.5 flex gap-2">
          <MetricCell id="pace" label={m.provider_quota_pace_label()} value={pace.status === 'over' ? m.provider_quota_pace_over_short({ percent: formatPercent(locale, -pace.pace_delta_percent) }) : pace.status === 'under' ? m.provider_quota_pace_under_short({ percent: formatPercent(locale, pace.pace_delta_percent) }) : m.provider_quota_on_pace()} />
          <MetricCell id="burn" label={m.provider_quota_burn_label()} value={formatBurnRate(locale, pace.burn_rate)} />
          {forecast?.budget_percent != null && <MetricCell id="budget" label={m.provider_quota_budget_label()} value={(forecast.budget_unit === 'day' ? m.provider_quota_budget_day_short : m.provider_quota_budget_hour_short)({ percent: formatPercent(locale, forecast.budget_percent) })} />}
        </div>
      )}
    </div>
  )
}

/** One labelled figure, the App's `ProviderQuotaMetricCell`: the label in small muted type above a semibold value. */
function MetricCell({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md bg-hover px-2 py-1.5" data-metric={id}>
      <span className="text-[11px] text-muted">{label}</span>
      <span className="truncate text-xs font-semibold tabular-nums text-text">{value}</span>
    </div>
  )
}
