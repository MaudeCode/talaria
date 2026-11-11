import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { IconButton } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'
import { partialSetting } from '../../app/queries'

/** What every server-setting row takes; `id` defaults to `settings-<settingKey>`, `icon` (TAL-2131) is drawn before the label. */
interface SettingProps { label: string; hint?: string; settingKey: string; id?: string; disabled?: boolean; icon?: LucideIcon }
const rowId = (id: string | undefined, settingKey: string) => id ?? `settings-${settingKey}`
const trimmed = (draft: string) => draft.trim()

/**
 * One boolean server setting as a switch row; `onSaved` runs once the server confirms a write. `inverted` shows the switch on
 * while the stored value is false, for a `hide_*` key labelled as the thing shown; `fallback` stays the stored value's default.
 */
export function SettingToggle({ label, hint, settingKey, id: givenId, fallback = false, inverted = false, disabled, onSaved, confirmOn, icon, indent, detail }: SettingProps & { fallback?: boolean; inverted?: boolean; onSaved?: () => void; confirmOn?: () => Promise<boolean>; indent?: boolean; detail?: ReactNode }) {
  const id = rowId(givenId, settingKey)
  const { bool, set } = useSettingField([settingKey])
  // `confirmOn` (a permission prompt) holds the switch on while it asks; a refusal leaves the setting off.
  const [asking, setAsking] = useState(false)
  const change = (checked: boolean) => {
    const save = () => { set({ [settingKey]: checked !== inverted }, onSaved) }
    if (!checked || !confirmOn) { save(); return }
    setAsking(true)
    void confirmOn().then((ok) => { if (ok) save() }, () => undefined).finally(() => { setAsking(false) })
  }
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} indent={indent} detail={detail} inline>
      <Switch id={id} disabled={disabled} checked={asking || bool(settingKey, fallback) !== inverted} onCheckedChange={change} />
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
 * TAL-2131: one string server setting as a segmented control, saving like `SettingSelect`, for two to four short options.
 * On a column too narrow for the label and every option, the control moves under its label (TAL-2138). `value` (TAL-2160)
 * shows a rule in force instead of the stored choice, for a disabled control.
 */
export function SettingSegmented({ label, hint, settingKey, id: givenId, fallback, options, disabled, icon, value }: SettingProps & { fallback: string; options: readonly { value: string; label: string }[]; value?: string }) {
  const id = rowId(givenId, settingKey)
  const { str, set } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} inline wrap>
      <Segmented id={id} label={label} disabled={disabled} options={options} value={value ?? str(settingKey, fallback)} onChange={(v) => set({ [settingKey]: v })} />
    </FieldRow>
  )
}

/**
 * One integer server setting, with `unit` (TAL-2136) after the field. An integer from `min` up goes to the server, which owns
 * the accepted range; `max` and `step` only bound the input's stepper. With `allowEmpty` an empty field writes `null`. A stored 0 or unset
 * value shows empty. With `field` the row edits that key of an object setting the server merges key by key: it saves the typed
 * number on blur or Enter as a `partialSetting` and shows the server's answer, which owns the range; anything but a number puts
 * the stored value back.
 */
export function SettingNumber({ label, hint, settingKey, field, id: givenId, fallback = 0, min = 1, max, step, allowEmpty, placeholder, width = 'w-20', disabled, icon, unit, onSaved }: SettingProps & { field?: string; fallback?: number; min?: number; max?: number; step?: number; allowEmpty?: boolean; placeholder?: string; width?: string; unit?: string; onSaved?: () => void }) {
  const id = rowId(givenId, settingKey)
  const { settings, num, setAsync } = useSettingField([settingKey])
  const [draft, setDraft] = useState<string | null>(null)
  const stored = settings.data?.[settingKey]
  const object = field && typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : null
  const nested = field ? object?.[field] : undefined
  const commit = () => {
    if (draft === null || !field || !object) return
    setDraft(null)
    const n = Number(draft.trim())
    if (draft.trim() === '' || !Number.isFinite(n) || n === nested) return
    void setAsync({ [settingKey]: partialSetting({ [field]: n }) }, onSaved)
  }
  const input = field
    ? <TextInput id={id} type="number" inputMode="numeric" min={min} max={max} step={step} disabled={disabled} placeholder={placeholder} value={draft ?? (typeof nested === 'number' ? String(nested) : '')}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
    : <TextInput id={id} type="number" retainDraft min={min} max={max} step={step} disabled={disabled} placeholder={placeholder} value={num(settingKey, fallback) || ''} onChange={(e) => {
      const raw = e.target.value.trim()
      if (raw === '') return allowEmpty ? setAsync({ [settingKey]: null }, onSaved) : undefined
      const n = Number(raw)
      if (Number.isInteger(n) && n >= min) return setAsync({ [settingKey]: n }, onSaved)
    }} />
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} inline>
      {/* `TextInput` is `w-full`, so `width` sizes its box; a fixed unit column keeps a group's fields in one column. */}
      <span className="flex items-center gap-2"><span className={cn('block', width)}>{input}</span>{unit && <span className="w-10 text-sm text-muted">{unit}</span>}</span>
    </FieldRow>
  )
}

/**
 * One text server setting with a Save button, enabled while the draft differs from the stored value. Save writes `parse(draft)`
 * and drops the draft once the write confirms, so a refused save keeps it. It stacks: the field needs the row's width.
 * With `summary` (TAL-2143) the row is closed by default: its `id` is the button that opens the field under it, showing
 * `summary` (words for a server field, such as a count) before its chevron; a save leaves it open.
 */
export function SettingText({ label, hint, settingKey, id: givenId, fallback = '', maxLength, multiline, placeholder, parse = trimmed, format, disabled, icon, summary }: SettingProps & { fallback?: string; maxLength?: number; multiline?: boolean; placeholder?: string; parse?: (draft: string) => unknown; format?: (stored: unknown) => string; summary?: string }) {
  const id = rowId(givenId, settingKey)
  const { settings, str, set } = useSettingField([settingKey])
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const stored = format ? format(settings.data?.[settingKey]) : str(settingKey, fallback)
  const value = draft ?? stored
  // Behind a disclosure the label names the button, so the field takes the label as its own name.
  const field = { ...(summary !== undefined ? { 'aria-label': label } : { id }), value, disabled, maxLength, placeholder }
  const editor = (
    <form className={cn('flex gap-2', summary !== undefined ? 'flex-col items-end' : multiline && 'items-start')} onSubmit={(e) => {
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
  )
  if (summary === undefined) return <FieldRow label={label} htmlFor={id} hint={hint} icon={icon}>{editor}</FieldRow>
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div>
      <FieldRow label={label} htmlFor={id} hint={hint} icon={icon} inline>
        <button id={id} type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-9 items-center gap-2 text-xs text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent">
          {summary}<Chevron size={14} aria-hidden="true" />
        </button>
      </FieldRow>
      {open && <div className={cn('pb-2', icon && 'ps-7')}>{editor}</div>}
    </div>
  )
}

export { SETTINGS_PAGE, SETTINGS_TITLE, SettingAction, SettingHeadline, SettingLink, SettingRow, SettingsBack, SettingsGroup, SettingsStats, SettingValue, SettingValues } from './SettingsGroup'
