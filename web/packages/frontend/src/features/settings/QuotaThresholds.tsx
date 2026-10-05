import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import { keys } from '../../api/queryKeys'
import { useSaveSettings, useSettingsQuery } from '../../app/queries'
import type { QuotaLevel, QuotaThresholds } from '../../contracts'
import { Button } from '../../ui/Button'
import { HelpTip, TextInput } from '../../ui/Field'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

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
  const stored = useSettingsQuery().data?.provider_quota_thresholds
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
    <form className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3" data-quota-thresholds onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="text-sm font-medium text-text">
        {m.providers_quota_thresholds_title()}
        <HelpTip label={m.field_help_about({ label: m.providers_quota_thresholds_title() })}>{m.providers_quota_thresholds_help()}</HelpTip>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map(([key, label, min, max, step]) => (
          <label key={key} className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>{label()}</span>
            <div className="w-20 shrink-0"><TextInput type="number" inputMode="numeric" min={min} max={max} step={step} value={value(key)} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} /></div>
          </label>
        ))}
      </div>
      <div><Button type="submit" disabled={save.isPending}>{m.providers_quota_thresholds_save()}</Button></div>
    </form>
  )
}

const LEVEL_TEXT: Record<QuotaLevel, string> = { healthy: 'text-accent-text', warning: 'text-warning', critical: 'text-error', stale: 'text-warning', unavailable: 'text-muted' }
const LEVEL_LABEL: Record<QuotaLevel, () => string> = { healthy: m.quota_level_healthy, warning: m.quota_level_warning, critical: m.quota_level_critical, stale: m.quota_level_stale, unavailable: m.quota_level_unavailable }

/** A quota source's server `urgency` for both colour bases; nothing for an older server without it. */
export function QuotaUrgency({ urgency }: { urgency: { remaining: QuotaLevel; pace: QuotaLevel } | undefined }) {
  if (!urgency) return null
  return (
    <div className="flex flex-wrap gap-x-3 text-[11px]">
      <span data-quota-urgency="remaining" data-level={urgency.remaining} className={cn(LEVEL_TEXT[urgency.remaining])}>{m.providers_quota_urgency_remaining({ level: LEVEL_LABEL[urgency.remaining]() })}</span>
      <span data-quota-urgency="pace" data-level={urgency.pace} className={cn(LEVEL_TEXT[urgency.pace])}>{m.providers_quota_urgency_pace({ level: LEVEL_LABEL[urgency.pace]() })}</span>
    </div>
  )
}
