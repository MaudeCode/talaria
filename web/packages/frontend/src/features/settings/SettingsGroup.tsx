import type { ReactNode } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, HelpTip } from '../../ui/Field'
import { SectionHeader } from '../../ui/List'

// The Settings kit's rows that read no server setting, apart from `SettingsRows.tsx` so a page can use them without
// loading the settings store (TAL-2106: the Extensions chunk reaching it split the static Menu chunk past the layout budget).

/** A labelled control that is not a server setting (device-local preferences, lists of switches). `stacked` puts a multi-control body under its label. */
export function SettingRow({ label, hint, htmlFor, stacked, children }: { label: string; hint?: string | undefined; htmlFor?: string; stacked?: boolean; children: ReactNode }) {
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

/** TAL-1691: a titled group of rows on a Settings page (§4 `SectionHeader`); `hint` opens from a `HelpTip` beside the title. `section` keeps a page's `data-section` hook. */
export function SettingsGroup({ id, title, hint, detail, action, section, children }: { id: string; title: string; hint?: ReactNode; detail?: ReactNode; action?: ReactNode; section?: string; children: ReactNode }) {
  return (
    <section aria-label={title} data-group={id} data-section={section} className="flex flex-col gap-1">
      <SectionHeader detail={detail} action={action}>{title}{hint && <HelpTip label={m.field_help_about({ label: title })}>{hint}</HelpTip>}</SectionHeader>
      <div className="flex flex-col divide-y divide-border-subtle">{children}</div>
    </section>
  )
}
