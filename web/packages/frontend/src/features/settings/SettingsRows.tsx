import { useState, type ReactNode } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, HelpTip, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { Button } from '../../ui/Button'
import { SectionHeader } from '../../ui/List'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'

/** What every server-setting row takes; `id` defaults to `settings-<settingKey>`. */
interface SettingProps { label: string; hint?: string; settingKey: string; id?: string; disabled?: boolean }
const rowId = (id: string | undefined, settingKey: string) => id ?? `settings-${settingKey}`
const trimmed = (draft: string) => draft.trim()

/** One boolean server setting as a switch row; `onSaved` runs once the server confirms a write. */
export function SettingToggle({ label, hint, settingKey, id: givenId, fallback = false, disabled, onSaved }: SettingProps & { fallback?: boolean; onSaved?: () => void }) {
  const id = rowId(givenId, settingKey)
  const { bool, set } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} inline>
      <Switch id={id} disabled={disabled} checked={bool(settingKey, fallback)} onCheckedChange={(checked) => set({ [settingKey]: checked }, onSaved)} />
    </FieldRow>
  )
}

/** One string server setting picked from a fixed list. */
export function SettingSelect({ label, hint, settingKey, id: givenId, fallback, options, disabled }: SettingProps & { fallback: string; options: readonly { value: string; label: string }[] }) {
  const id = rowId(givenId, settingKey)
  const { str, set } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} inline>
      <Select id={id} disabled={!!disabled} value={str(settingKey, fallback)} onValueChange={(v) => set({ [settingKey]: v })}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </FieldRow>
  )
}

/** One integer server setting. An integer from `min` up goes to the server, which owns the accepted range; `max` only bounds the input's stepper. With `allowEmpty` an empty field writes `null`. A stored 0 or unset value shows empty. */
export function SettingNumber({ label, hint, settingKey, id: givenId, fallback = 0, min = 1, max, allowEmpty, placeholder, width = 'w-20', disabled }: SettingProps & { fallback?: number; min?: number; max?: number; allowEmpty?: boolean; placeholder?: string; width?: string }) {
  const id = rowId(givenId, settingKey)
  const { num, setAsync } = useSettingField([settingKey])
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} inline>
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
export function SettingText({ label, hint, settingKey, id: givenId, fallback = '', maxLength, multiline, placeholder, parse = trimmed, format, disabled }: SettingProps & { fallback?: string; maxLength?: number; multiline?: boolean; placeholder?: string; parse?: (draft: string) => unknown; format?: (stored: unknown) => string }) {
  const id = rowId(givenId, settingKey)
  const { settings, str, set } = useSettingField([settingKey])
  const [draft, setDraft] = useState<string | null>(null)
  const stored = format ? format(settings.data?.[settingKey]) : str(settingKey, fallback)
  const value = draft ?? stored
  const field = { id, value, disabled, maxLength, placeholder }
  return (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <form className={cn('flex gap-2', multiline && 'items-start')} onSubmit={(e) => {
        e.preventDefault()
        if (draft === null || draft === stored) return
        const submitted = draft
        set({ [settingKey]: parse(submitted) }, () => setDraft((current) => current === submitted ? null : current))
      }}>
        {multiline
          ? <textarea {...field} rows={3} spellCheck={false} autoCapitalize="none" className="min-h-9 w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-text placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50" onChange={(e) => setDraft(e.target.value)} />
          : <TextInput {...field} onChange={(e) => setDraft(e.target.value)} />}
        <Button type="submit" disabled={disabled || value === stored}>{m.save()}</Button>
      </form>
    </FieldRow>
  )
}

/** A labelled control that is not a server setting (device-local preferences, lists of switches). `stacked` puts a multi-control body under its label. */
export function SettingRow({ label, hint, htmlFor, stacked, children }: { label: string; hint?: string; htmlFor?: string; stacked?: boolean; children: ReactNode }) {
  return <FieldRow label={label} hint={hint} htmlFor={htmlFor} inline={!stacked}>{children}</FieldRow>
}

/** A label with action button(s) at the right; the button's own `variant` carries any danger styling. */
export function SettingAction({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <FieldRow label={label} hint={hint} inline>{children}</FieldRow>
}

/** TAL-2081: read-only label/value rows (versions, keyboard shortcuts) as one `<dl>`; each row is a `SettingValue`. */
export function SettingValues({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col divide-y divide-border-subtle">{children}</dl>
}

/** One row of `SettingValues`: the label at the left, the value at the right in muted text. */
export function SettingValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <dt className="shrink-0 text-text">{label}</dt>
      <dd className="min-w-0 break-all text-right text-muted">{children}</dd>
    </div>
  )
}

/** TAL-2081: a row that is itself the control: an external page in a new tab (`href`) or a dialog (`onClick`). */
export function SettingLink({ label, ...target }: { label: string } & ({ href: string } | { onClick: () => void })) {
  const className = 'flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left text-sm text-text transition-colors hover:text-accent-text focus-visible:outline-2 focus-visible:outline-accent'
  const icon = { size: 14, 'aria-hidden': true, className: 'shrink-0 text-muted' } as const
  return 'href' in target
    ? <a className={className} href={target.href} target="_blank" rel="noopener noreferrer">{label}<ExternalLink {...icon} /></a>
    : <button type="button" className={className} onClick={target.onClick}>{label}<ChevronRight {...icon} /></button>
}

/** TAL-1691: a titled group of rows on a Settings page (§4 `SectionHeader`); `hint` opens from a `HelpTip` beside the title. */
export function SettingsGroup({ id, title, hint, detail, action, children }: { id: string; title: string; hint?: ReactNode; detail?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} data-group={id} className="flex flex-col gap-1">
      <SectionHeader detail={detail} action={action}>{title}{hint && <HelpTip label={m.field_help_about({ label: title })}>{hint}</HelpTip>}</SectionHeader>
      <div className="flex flex-col divide-y divide-border-subtle">{children}</div>
    </section>
  )
}
