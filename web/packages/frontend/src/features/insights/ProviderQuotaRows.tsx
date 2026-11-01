import type { UseQueryResult } from '@tanstack/react-query'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import { formatMinutes, formatPercent, resetTime } from '../../i18n/units'
import type { ProviderQuotaSourceSchema, ProviderQuotasSchema, QuotaLevel } from '../../contracts'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { cn } from '../../ui/cn'
import { QuotaPaceSummary } from '../settings/ProviderQuotaPace'

type QuotaSource = z.infer<typeof ProviderQuotaSourceSchema>
type QuotaWindow = NonNullable<QuotaSource['windows']>[number]

/** The meter fill per server level; `healthy` wears the accent like the App's rail, state colours are state only. */
const LEVEL_FILL: Record<QuotaLevel, string> = { healthy: 'bg-accent', warning: 'bg-warning', critical: 'bg-error', stale: 'bg-muted', unavailable: 'bg-muted' }

const STATUS_LABEL: Record<string, () => string> = {
  exhausted: m.provider_quota_status_exhausted, unavailable: m.provider_quota_status_unavailable, stale: m.quota_level_stale,
}

/**
 * Every `/api/provider/quotas` source with every window: a meter at the server's remaining percent with the pace
 * marker at its expected position, the reset, and the server pace and forecast. Each value is a contract field
 * (TAL-409 pace, TAL-411 urgency); the client only formats. Settings › Providers keeps its sibling
 * `ProviderQuotaPace`, one pace window as metadata under a provider card; both share `QuotaPaceSummary`.
 */
export function ProviderQuotaRows({ quotas, onRefresh }: { quotas: UseQueryResult<z.infer<typeof ProviderQuotasSchema>>; onRefresh: () => void }) {
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
      {data && data.sources.length > 0 && (
        <ul className="flex flex-col">
          {data.sources.map((s) => <QuotaSourceRow key={s.source_id} source={s} locale={locale} />)}
        </ul>
      )}
    </section>
  )
}

function QuotaSourceRow({ source: s, locale }: { source: QuotaSource; locale: string }) {
  const name = s.provider_label ?? s.provider_id ?? s.source_id
  const account = s.account_label && s.account_label !== name ? s.account_label : null
  const plan = typeof s.plan === 'string' && s.plan ? s.plan : null
  const status = s.status ?? 'unavailable'
  const stale = status === 'stale' || status === 'unavailable'
  const quota = s.quota as { limit_remaining?: unknown } | null | undefined
  const credits = typeof quota?.limit_remaining === 'number' ? quota.limit_remaining : null
  const detail = Array.isArray(s.details) && typeof s.details[0] === 'string' ? s.details[0] : null
  return (
    <li className="flex flex-col gap-3 border-t border-border py-3 first:border-t-0" data-quota-source={s.source_id} data-quota-status={status}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-text">{name}</span>
        {account && <span className="text-xs text-muted">{account}</span>}
        {plan && <Badge tone="border-border text-muted">{plan}</Badge>}
        {s.is_active_provider && <Badge tone="border-accent text-accent-text">{m.provider_quota_active_provider()}</Badge>}
        {status !== 'available' && <span className={cn('text-xs', stale ? 'text-warning' : 'text-error')}>{typeof s.unavailable_reason === 'string' ? s.unavailable_reason : s.message ?? STATUS_LABEL[status]?.() ?? status}</span>}
      </div>
      {(s.windows ?? []).map((w, i) => <QuotaWindowRow key={`${w.label}-${String(i)}`} window={w} source={s} locale={locale} />)}
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

function QuotaWindowRow({ window: w, source, locale }: { window: QuotaWindow; source: QuotaSource; locale: string }) {
  const { pace, forecast } = w
  // The server's pace level already falls back to its remaining classification for a window without pace (TAL-411).
  const level: QuotaLevel = w.urgency?.pace ?? source.urgency?.pace ?? 'healthy'
  const remaining = w.remaining_percent
  // The server's minutes to reset, as of its `computed_at`; the list rereads every minute.
  const countdown = pace ? formatMinutes(locale, pace.minutes_to_reset) : null
  return (
    <div className="flex flex-col gap-1" data-quota-window={w.label} data-level={level}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-text">{w.label}</span>
        {remaining !== null ? <span className="tabular-nums text-text">{m.provider_quota_remaining({ percent: formatPercent(locale, remaining) })}</span> : w.detail && <span className="text-muted">{w.detail}</span>}
      </div>
      {remaining !== null && (
        <div className="relative h-1.5 overflow-hidden rounded-full bg-border" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)} aria-label={`${w.label}: ${m.provider_quota_remaining({ percent: formatPercent(locale, remaining) })}`}>
          <div className={cn('h-full rounded-full', LEVEL_FILL[level])} style={{ width: `${String(Math.min(100, Math.max(0, remaining)))}%` }} />
          {pace && <div aria-hidden="true" className="absolute inset-y-0 w-px bg-text" style={{ left: `${String(Math.min(100, Math.max(0, pace.expected_remaining_percent)))}%` }} />}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
        {w.reset_at && <span>{m.provider_quota_resets({ time: resetTime(locale, w.reset_at) })}{countdown && ` · ${countdown}`}</span>}
        {pace && <QuotaPaceSummary pace={pace} forecast={forecast} locale={locale} forecastClassName={(outcome) => (outcome === 'warning' ? 'text-warning' : '')} />}
      </div>
    </div>
  )
}
