import { useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import { keys } from '../../api/queryKeys'
import { useSettingsQuery } from '../../app/queries'
import type { QuotaThresholds } from '../../contracts'
import { LoadingState } from '../../ui/States'
import { SETTINGS_PAGE, SETTINGS_TITLE, SettingsBack, SettingsGroup } from './SettingsGroup'
import { SettingNumber } from './SettingsRows'

type Field = readonly [key: keyof QuotaThresholds, label: () => string, min: number, max: number, step: number, unit: () => string]
const percent = m.providers_quota_unit_percent
/** The thresholds in page order, each with its server range (`mergeQuotaThresholds`) and step. */
const QUOTA_REMAINING: readonly Field[] = [
  ['warning_remaining_percent', m.providers_quota_warning_remaining, 1, 99, 1, percent],
  ['critical_remaining_percent', m.providers_quota_critical_remaining, 0, 99, 1, percent],
]
const QUOTA_PACE: readonly Field[] = [
  ['pace_tolerance_percent', m.providers_quota_pace_tolerance, 0, 25, 1, percent],
  ['pace_warning_burn_rate_percent', m.providers_quota_pace_warning_burn, 100, 300, 5, percent],
  ['pace_critical_burn_rate_percent', m.providers_quota_pace_critical_burn, 100, 400, 5, percent],
  ['pace_minimum_elapsed_hours', m.providers_quota_pace_minimum_hours, 0, 72, 1, m.providers_quota_unit_hours],
]

/**
 * TAL-411, TAL-2136: Settings › Providers › Quota alerts: the profile's `provider_quota_thresholds`, each saved on its own; the
 * server validates them and classifies quotas with them. Nothing to edit on an older server without them.
 */
export function QuotaAlertsPage() {
  const qc = useQueryClient()
  const settings = useSettingsQuery(['provider_quota_thresholds'])
  const onSaved = () => { void qc.invalidateQueries({ queryKey: keys.providerQuotas }) }
  const group = (id: string, title: string, fields: readonly Field[], hint?: string) => (
    <SettingsGroup id={id} title={title} hint={hint}>
      {fields.map(([key, label, min, max, step, unit]) => (
        <SettingNumber key={key} id={`quotaThreshold-${key}`} label={label()} settingKey="provider_quota_thresholds" field={key} min={min} max={max} step={step} unit={unit()} onSaved={onSaved} />
      ))}
    </SettingsGroup>
  )
  return (
    <div className={SETTINGS_PAGE} data-section="providers" data-quota-alerts="">
      <div className="flex flex-col gap-2">
        <SettingsBack label={m.settings_section_providers_title()} section="providers" />
        <h1 className={SETTINGS_TITLE}>{m.providers_quota_alerts()}</h1>
      </div>
      {settings.isPending ? <LoadingState /> : settings.data?.provider_quota_thresholds && <>
        {group('quota-remaining', m.providers_quota_group_remaining(), QUOTA_REMAINING, m.providers_quota_thresholds_help())}
        {group('quota-pace', m.providers_quota_group_pace(), QUOTA_PACE)}
      </>}
    </div>
  )
}
