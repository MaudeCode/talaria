import { createFileRoute, useLocation } from '@tanstack/react-router'
import { SettingsSection } from '../features/settings/SettingsSection'

/** TAL-2136: Settings › Providers › Quota alerts. Its `#<row id>` reveals a threshold, as on a section's page. */
export const Route = createFileRoute('/_app/settings/providers/quota-alerts')({
  component: QuotaAlertsRoute,
})

function QuotaAlertsRoute() {
  const row = useLocation({ select: (location) => location.hash || undefined })
  const visit = useLocation({ select: (location) => location.state.__TSR_key })
  return <SettingsSection section="providers" page="quota-alerts" row={row} visit={visit} />
}
