import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { useSetting } from '../../app/queries'
import { useLocale } from '../../i18n/useLocale'
import { formatPercent } from '../../i18n/units'
import { useProviderQuotas, useSidebarQuotaPinChoice, useSidebarQuotaPins } from '../../lib/useProviderQuotas'
import { SIDEBAR_ROW } from '../../shell/nav'
import { closeMobileSidebar, useIsSidebarRail } from '../../shell/useShellState'
import { cn } from '../../ui/cn'
import { QuotaMeter, quotaCreditsText, quotaSourceName, quotaStatusText, quotaWindowFigures, type QuotaSource } from './QuotaMeter'

/**
 * TAL-1870: the expanded sidebar's Quotas group, the App's `AppSidebar` rows: the server's `sidebar_source_ids`, or the
 * choice pending over them. Reads run while anything is pinned, by the setting, a pending choice or the last projection;
 * this layer stays mounted, hidden, behind the collapsed rail, which reads nothing.
 */
export function SidebarQuotas() {
  const choice = useSidebarQuotaPinChoice()
  const setting = useSetting('sidebar_quota_sources')
  const rail = useIsSidebarRail()
  const pinned = (choice ?? setting ?? []).length > 0
  const { quotas } = useProviderQuotas({ enabled: (query) => !rail && (pinned || !!query.state.data?.sidebar_source_ids?.length) })
  const { ids } = useSidebarQuotaPins(quotas.data)
  const locale = useLocale()
  const sources = ids.flatMap((id) => quotas.data?.sources.find((s) => s.source_id === id) ?? [])
  if (sources.length === 0) return null
  return (
    <section className="mt-2 flex flex-none flex-col gap-0.5" data-section="sidebar-quotas">
      <h3 className="px-2.5 py-1 text-xs font-medium uppercase tracking-wider text-muted">{m.insights_tab_quotas()}</h3>
      <ul className="flex flex-col gap-0.5">{sources.map((s) => <li key={s.source_id}><SidebarQuotaRow source={s} locale={locale} /></li>)}</ul>
    </section>
  )
}

function SidebarQuotaRow({ source, locale }: { source: QuotaSource; locale: string }) {
  const w = source.headline_window_index == null ? undefined : source.windows?.[source.headline_window_index]
  const { level, percent, marker, modeLabel } = quotaWindowFigures(source, w, 'used')
  const title = source.display_name ?? quotaSourceName(source)
  const status = source.status ?? 'unavailable'
  const statusText = status === 'available' ? null : quotaStatusText(source)
  const figure = percent === null ? (w?.detail ?? quotaCreditsText(source, locale)) : `${formatPercent(locale, percent)} ${modeLabel}`
  const description = [figure, statusText].filter(Boolean).join(', ')
  return (
    <Link to="/insights" search={{ tab: 'quotas' }} className={cn(SIDEBAR_ROW, 'py-1.5')} aria-label={description ? `${title}: ${description}` : title} data-quota-source={source.source_id} data-quota-status={status} data-level={level} onClick={closeMobileSidebar}>
      <span className="flex w-full min-w-0 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate">{title}</span>
          {figure && <span className="shrink-0 text-xs tabular-nums text-muted">{figure}</span>}
        </span>
        {percent !== null && figure && <QuotaMeter level={level} percent={percent} marker={marker} label={`${title}: ${figure}`} />}
        {statusText && <span className={cn('truncate text-xs', status === 'stale' || status === 'unavailable' ? 'text-warning' : 'text-error')}>{statusText}</span>}
      </span>
    </Link>
  )
}
