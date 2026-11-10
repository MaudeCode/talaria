import { m } from '../../paraglide/messages.js'
import type { QuotaLevel } from '../../contracts'
import { StatusDot, type DotState } from '../../ui/Badge'

const LEVEL_DOT: Record<QuotaLevel, DotState> = { healthy: 'ok', warning: 'warning', critical: 'error', stale: 'warning', unavailable: 'idle' }
const LEVEL_LABEL: Record<QuotaLevel, () => string> = { healthy: m.quota_level_healthy, warning: m.quota_level_warning, critical: m.quota_level_critical, stale: m.quota_level_stale, unavailable: m.quota_level_unavailable }

/** A quota source's server `urgency` for both colour bases; nothing for an older server without it. */
export function QuotaUrgency({ urgency }: { urgency: { remaining: QuotaLevel; pace: QuotaLevel } | undefined }) {
  if (!urgency) return null
  return (
    <div className="flex flex-wrap gap-x-3">
      <span data-quota-urgency="remaining" data-level={urgency.remaining} className="flex min-w-0"><StatusDot state={LEVEL_DOT[urgency.remaining]}>{m.providers_quota_urgency_remaining({ level: LEVEL_LABEL[urgency.remaining]() })}</StatusDot></span>
      <span data-quota-urgency="pace" data-level={urgency.pace} className="flex min-w-0"><StatusDot state={LEVEL_DOT[urgency.pace]}>{m.providers_quota_urgency_pace({ level: LEVEL_LABEL[urgency.pace]() })}</StatusDot></span>
    </div>

  )
}
