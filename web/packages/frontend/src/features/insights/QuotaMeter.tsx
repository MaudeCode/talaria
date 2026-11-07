import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import type { ProviderQuotaSourceSchema, QuotaLevel } from '../../contracts'
import { cn } from '../../ui/cn'
import { METER_RAIL } from '../../ui/List'

export type QuotaSource = z.infer<typeof ProviderQuotaSourceSchema>
export type QuotaWindow = NonNullable<QuotaSource['windows']>[number]

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

export const quotaSourceName = (s: QuotaSource): string => s.provider_label ?? s.provider_id ?? s.source_id

/** The server's text for a source's status, else the localized status word. */
export function quotaStatusText(s: QuotaSource): string {
  const status = s.status ?? 'unavailable'
  return s.status_message ?? STATUS_LABEL[status]?.() ?? status
}

/** OpenRouter-style credits, for a source with no windows to show a percent from. */
export function quotaCreditsText(s: QuotaSource, locale: string): string | null {
  const quota = s.quota as { limit_remaining?: unknown } | null | undefined
  return typeof quota?.limit_remaining === 'number' ? m.provider_quota_credits_remaining({ amount: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(quota.limit_remaining) }) : null
}

/** One window's server level and the server percents for the mode; the server ships both percents normalized. */
export function quotaWindowFigures(source: QuotaSource, w: QuotaWindow | undefined, mode: QuotaPercentMode) {
  const level: QuotaLevel = w?.display_level ?? source.display_level ?? 'unavailable'
  const percent = w ? (mode === 'used' ? w.used_percent : w.remaining_percent) : null
  const marker = w?.pace ? (mode === 'used' ? w.pace.expected_used_percent : w.pace.expected_remaining_percent) : null
  const modeLabel = mode === 'used' ? m.provider_quota_metric_used() : m.provider_quota_metric_remaining()
  return { level, percent, marker, modeLabel }
}

const clamp = (n: number) => `${String(Math.min(100, Math.max(0, n)))}%`

/** The quota meter: a server percent, filled by level, with the pace marker. `label` carries the percent and its mode (design system §10). */
export function QuotaMeter({ level, percent, marker, label }: { level: QuotaLevel; percent: number; marker: number | null; label: string }) {
  return (
    <div className={METER_RAIL} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
      <div className={cn('h-full rounded-full', LEVEL_FILL[level])} style={{ width: clamp(percent) }} />
      {marker !== null && <div aria-hidden="true" className="absolute inset-y-0 w-px bg-text" style={{ left: clamp(marker) }} />}
    </div>
  )
}
