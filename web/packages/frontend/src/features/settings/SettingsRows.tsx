import { useState, type ReactNode } from 'react'
import { Check, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { IconButton } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'

/** What every server-setting row takes; `id` defaults to `settings-<settingKey>`, `icon` (TAL-2131) is drawn before the label. */
interface SettingProps { label: string; hint?: string; settingKey: string; id?: string; disabled?: boolean; icon?: LucideIcon }
const rowId = (id: string | undefined, settingKey: string) => id ?? `settings-${settingKey}`
const trimmed = (draft: string) => draft.trim()

/**
 * One boolean server setting as a switch row; `onSaved` runs once the server confirms a write. `inverted` shows the switch on
 * while the stored value is false, for a `hide_*` key labelled as the thing shown; `fallback` stays the stored value's default.
 */
export function SettingToggle({ label, hint, settingKey, id: givenId, fallback = false, inverted = false, disabled, onSaved, icon, detail }: SettingProps & { fallback?: boolean; inverted?: boolean; onSaved?: () => void; detail?: ReactNode }) {
  const id = rowId(givenId, settingKey)
  const { bool, set } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} detail={detail} inline>
      <Switch id={id} disabled={disabled} checked={bool(settingKey, fallback) !== inverted} onCheckedChange={(checked) => set({ [settingKey]: checked !== inverted }, onSaved)} />
    </FieldRow>
  )
}

/** One string server setting picked from a fixed list. */
export function SettingSelect({ label, hint, settingKey, id: givenId, fallback, options, disabled, icon }: SettingProps & { fallback: string; options: readonly { value: string; label: string }[] }) {
  const id = rowId(givenId, settingKey)
  const { str, set } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} inline>
      <Select id={id} disabled={!!disabled} value={str(settingKey, fallback)} onValueChange={(v) => set({ [settingKey]: v })}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </FieldRow>
  )
}

/**
 * TAL-2131: one string server setting as a segmented control, saving like `SettingSelect`. For two to four options whose
 * labels are 12 characters or fewer; anything longer or more is a `SettingSelect`.
 */
export function SettingSegmented({ label, hint, settingKey, id: givenId, fallback, options, disabled, icon }: SettingProps & { fallback: string; options: readonly { value: string; label: string }[] }) {
  const id = rowId(givenId, settingKey)
  const { str, set } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} inline>
      <Segmented id={id} label={label} disabled={disabled} options={options} value={str(settingKey, fallback)} onChange={(v) => set({ [settingKey]: v })} />
    </FieldRow>
  )
}

/** One integer server setting. An integer from `min` up goes to the server, which owns the accepted range; `max` only bounds the input's stepper. With `allowEmpty` an empty field writes `null`. A stored 0 or unset value shows empty. */
export function SettingNumber({ label, hint, settingKey, id: givenId, fallback = 0, min = 1, max, allowEmpty, placeholder, width = 'w-20', disabled, icon }: SettingProps & { fallback?: number; min?: number; max?: number; allowEmpty?: boolean; placeholder?: string; width?: string }) {
  const id = rowId(givenId, settingKey)
  const { num, setAsync } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} inline>
      <TextInput id={id} type="number" retainDraft min={min} max={max} disabled={disabled} className={width} placeholder={placeholder} value={num(settingKey, fallback) || ''} onChange={(e) => {
        const raw = e.target.value.trim()
        if (raw === '') return allowEmpty ? setAsync({ [settingKey]: null }) : undefined
        const n = Number(raw)
        if (Number.isInteger(n) && n >= min) return setAsync({ [settingKey]: n })
      }} />
    </FieldRow>
  )
}

/**
 * One text server setting with a Save button, enabled while the draft differs from the stored value. Save writes `parse(draft)`
 * and drops the draft once the write confirms, so a refused save keeps it. It stacks: the field needs the row's width.
 */
export function SettingText({ label, hint, settingKey, id: givenId, fallback = '', maxLength, multiline, placeholder, parse = trimmed, format, disabled, icon }: SettingProps & { fallback?: string; maxLength?: number; multiline?: boolean; placeholder?: string; parse?: (draft: string) => unknown; format?: (stored: unknown) => string }) {
  const id = rowId(givenId, settingKey)
  const { settings, str, set } = useSettingField([settingKey])
  const [draft, setDraft] = useState<string | null>(null)
  const stored = format ? format(settings.data?.[settingKey]) : str(settingKey, fallback)
  const value = draft ?? stored
  const field = { id, value, disabled, maxLength, placeholder }
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon}>
      <form className={cn('flex gap-2', multiline && 'items-start')} onSubmit={(e) => {
        e.preventDefault()
        if (draft === null || draft === stored) return
        const submitted = draft
        set({ [settingKey]: parse(submitted) }, () => setDraft((current) => current === submitted ? null : current))
      }}>
        {multiline
          ? <textarea {...field} rows={3} spellCheck={false} autoCapitalize="none" className="min-h-9 w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-text placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50" onChange={(e) => setDraft(e.target.value)} />
          : <TextInput {...field} onChange={(e) => setDraft(e.target.value)} />}
        <IconButton type="submit" variant="default" label={m.save()} disabled={disabled || value === stored}><Check aria-hidden="true" /></IconButton>
      </form>
    </FieldRow>
  )
}

export { SETTINGS_PAGE, SettingAction, SettingLink, SettingRow, SettingsGroup, SettingsStats, SettingValue, SettingValues } from './SettingsGroup'
