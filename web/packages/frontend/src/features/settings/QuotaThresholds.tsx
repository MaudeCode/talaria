import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import { keys } from '../../api/queryKeys'
import { useSaveSettings, useSetting } from '../../app/queries'
import type { QuotaLevel, QuotaThresholds } from '../../contracts'
import { Check } from 'lucide-react'
import { IconButton } from '../../ui/Button'
import { StatusDot, type DotState } from '../../ui/Badge'
import { FieldRow, TextInput } from '../../ui/Field'
import { SettingsGroup } from './SettingsRows'
import { showToast } from '../toast/toast'

const FIELDS: [keyof QuotaThresholds, () => string, number, number, number][] = [
  ['warning_remaining_percent', m.providers_quota_warning_remaining, 1, 99, 1],
  ['critical_remaining_percent', m.providers_quota_critical_remaining, 0, 99, 1],
  ['pace_tolerance_percent', m.providers_quota_pace_tolerance, 0, 25, 1],
  ['pace_warning_burn_rate_percent', m.providers_quota_pace_warning_burn, 100, 300, 5],
  ['pace_critical_burn_rate_percent', m.providers_quota_pace_critical_burn, 100, 400, 5],
  ['pace_minimum_elapsed_hours', m.providers_quota_pace_minimum_hours, 0, 72, 1],
]

/** TAL-411: the profile's `provider_quota_thresholds`; the server validates, clamps, and classifies quotas with them. Hidden on an older server. */
export function QuotaThresholdsForm() {
  const qc = useQueryClient()
  const stored = useSetting('provider_quota_thresholds')
  const save = useSaveSettings()
  const [draft, setDraft] = useState<Partial<Record<keyof QuotaThresholds, string>>>({})
  if (!stored) return null
  const value = (key: keyof QuotaThresholds): string => draft[key] ?? String(stored[key])
  const submit = () => {
    const patch = Object.fromEntries(FIELDS.flatMap(([key]) => { const n = Number.parseInt(value(key), 10); return Number.isFinite(n) ? [[key, n]] : [] }))
    save.mutate({ provider_quota_thresholds: patch }, {
      onSuccess: () => { setDraft({}); void qc.invalidateQueries({ queryKey: keys.providerQuotas }) },
      onError: () => showToast(m.providers_quota_thresholds_save_failed(), 4000, 'error'),
    })
  }
  return (
    <form className="flex flex-col gap-2" data-quota-thresholds onSubmit={(e) => { e.preventDefault(); submit() }}>
      <SettingsGroup id="quota-thresholds" title={m.providers_quota_thresholds_title()} hint={m.providers_quota_thresholds_help()} action={<IconButton type="submit" variant="ghost" label={m.providers_quota_thresholds_save()}><Check aria-hidden="true" /></IconButton>}>
        {FIELDS.map(([key, label, min, max, step]) => (
          <FieldRow key={key} label={label()} htmlFor={`quotaThreshold-${key}`} inline>
            <div className="w-20"><TextInput id={`quotaThreshold-${key}`} type="number" inputMode="numeric" min={min} max={max} step={step} value={value(key)} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} /></div>
          </FieldRow>
        ))}
      </SettingsGroup>
    </form>
  )
}

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
