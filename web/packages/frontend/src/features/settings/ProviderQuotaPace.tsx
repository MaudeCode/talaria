import type { PlanGauge, PlanUsage } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import { resetTime } from '../../i18n/units'
import type { ProviderQuotaSourceSchema } from '../../contracts'
import { QuotaUrgency } from './QuotaThresholds'

type QuotaSource = z.infer<typeof ProviderQuotaSourceSchema>

/** A plan gauge, a plan allowance, else a windowless quota source's urgency (TAL-411); every value is a contract field. */
export function ProviderQuotaPace({ source, showAccount = false, plan, planStale = false, gauge, compact = false, gauges = true }: { source?: QuotaSource; showAccount?: boolean; plan?: PlanUsage | null | undefined; planStale?: boolean | undefined; gauge?: PlanGauge | null | undefined; compact?: boolean; /** TAL-2135: false leaves out the gauges a page already shows as quota windows. */ gauges?: boolean }) {
  const locale = useLocale()
  const allowance = plan ?? source?.plan_usage
  const stale = planStale || source?.plan_stale || source?.status === 'stale' || source?.status === 'unavailable'
  if (gauge) return <span className="text-xs tabular-nums text-muted" data-plan-gauge={gauge.id}>
    {m.plan_used({ label: gauge.label, percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(gauge.used_bp / 10000) })}
    {gauge.resets_at_ms !== null && <span> · {m.provider_quota_resets({ time: resetTime(locale, gauge.resets_at_ms) })}</span>}
  </span>
  if (allowance) return <div className={compact ? 'px-2.5 py-1 text-xs text-muted' : 'text-xs text-muted'} data-testid="provider-plan-usage">
    <div className="flex flex-wrap gap-x-2"><span className="font-medium text-text">{allowance.plan}</span>{stale && <span>{m.catalog_last_confirmed()}</span>}{allowance.paused_reason && <span>{m.plan_paused()}</span>}</div>
    {gauges && allowance.gauges.map((g) => <div key={`${g.scope}:${g.label}`} className="flex flex-wrap gap-x-2 tabular-nums"><span>{g.title || g.label}</span><span>{m.plan_remaining({ percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(g.left_fraction) })}</span>{g.resets_at_ms !== null && <span>{m.provider_quota_resets({ time: resetTime(locale, g.resets_at_ms) })}</span>}</div>)}
    {allowance.credits_pay === true && !stale && !allowance.paused_reason && <span>{m.plan_credits_cover()}</span>}
  </div>
  // TAL-2135: a source with windows shows them on its provider's page; this is the windowless source's urgency.
  if (!source?.urgency) return null
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted">
      {showAccount && source.account_label && <span className="font-medium text-text">{source.account_label}</span>}
      <QuotaUrgency urgency={source.urgency} />
    </div>
  )
}
