import type { ReactNode } from 'react'
import { ChevronRight, ExternalLink, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, HelpTip, RowIcon } from '../../ui/Field'
import { Figure, SectionHeader, StatLabel, type FigureTone } from '../../ui/List'

/** TAL-2131: a Settings page's column of groups, 30px between one group and the next header (§4). */
export const SETTINGS_PAGE = 'flex flex-col gap-7.5'

// The Settings kit's rows that read no server setting, apart from `SettingsRows.tsx` so a page can use them without
// loading the settings store (TAL-2106: the Extensions chunk reaching it split the static Menu chunk past the layout budget).

/** A labelled control that is not a server setting (device-local preferences, lists of switches). `stacked` puts a multi-control body under its label. */
export function SettingRow({ label, hint, htmlFor, stacked, icon, children }: { label: string; hint?: string | undefined; htmlFor?: string; stacked?: boolean; icon?: LucideIcon; children: ReactNode }) {
  return <FieldRow label={label} hint={hint} htmlFor={htmlFor} icon={icon} inline={!stacked}>{children}</FieldRow>
}

/** A label with action button(s) at the right; the button's own `variant` carries any danger styling. */
export function SettingAction({ label, hint, icon, children }: { label: string; hint?: string; icon?: LucideIcon; children: ReactNode }) {
  return <FieldRow label={label} hint={hint} icon={icon} inline>{children}</FieldRow>
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
export function SettingLink({ label, icon: Icon, ...target }: { label: string; icon?: LucideIcon } & ({ href: string } | { onClick: () => void })) {
  const className = 'flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left text-sm text-text transition-colors hover:text-accent-text focus-visible:outline-2 focus-visible:outline-accent'
  const icon = { size: 14, 'aria-hidden': true, className: 'shrink-0 text-muted' } as const
  const text = Icon ? <span className="flex min-w-0 items-center gap-2.5"><RowIcon icon={Icon} />{label}</span> : label
  return 'href' in target
    ? <a className={className} href={target.href} target="_blank" rel="noopener noreferrer">{text}<ExternalLink {...icon} /></a>
    : <button type="button" className={className} onClick={target.onClick}>{text}<ChevronRight {...icon} /></button>
}

export interface SettingsStat { id: string; label: string; value: string; mode?: string | undefined; title?: string | undefined; tone?: FigureTone | undefined }

/**
 * TAL-2131: a Settings page's figures (§5), the Insights stat grid: two columns, four once the column is 521px wide.
 * Every value is a server field the caller formats; `tone` colours a value the server marked warning or error.
 */
export function SettingsStats({ label, stats }: { label: string; stats: readonly SettingsStat[] }) {
  return (
    <div className="@container">
      <dl aria-label={label} className="grid grid-cols-2 gap-x-6 gap-y-3 @min-[521px]:grid-cols-4" data-settings-stats="">
        {stats.map((s) => (
          <div key={s.id} className="min-w-0" data-stat={s.id}>
            <StatLabel>{s.label}</StatLabel>
            <dd className="truncate" title={s.title}><Figure value={s.value} mode={s.mode} tone={s.tone} /></dd>
          </div>
        ))}
      </dl>
    </div>
  )
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
