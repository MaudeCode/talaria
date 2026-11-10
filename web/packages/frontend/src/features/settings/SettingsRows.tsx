import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, HelpTip, Switch } from '../../ui/Field'
import { SectionHeader } from '../../ui/List'
import { useSettingField } from './useSettingField'

/** One boolean server setting as a switch row. */
export function SettingToggle({ label, hint, settingKey, fallback = false, disabled }: { label: string; hint?: string; settingKey: string; fallback?: boolean; disabled?: boolean }) {
  const { bool, set } = useSettingField([settingKey])
  const id = `settings-${settingKey}`
  return (
    <FieldRow label={label} htmlFor={id} {...(hint ? { hint } : {})} inline>
      <Switch id={id} disabled={disabled} checked={bool(settingKey, fallback)} onCheckedChange={(checked) => set({ [settingKey]: checked })} />
    </FieldRow>
  )
}

/** TAL-1691: a titled group of rows on a Settings page (§4 `SectionHeader`); `hint` opens from a `HelpTip` beside the title. */
export function SettingsGroup({ id, title, hint, children }: { id: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} data-group={id} className="flex flex-col gap-1">
      <SectionHeader>{title}{hint && <HelpTip label={m.field_help_about({ label: title })}>{hint}</HelpTip>}</SectionHeader>
      <div className="flex flex-col divide-y divide-border-subtle">{children}</div>
    </section>
  )
}
