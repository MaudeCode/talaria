import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate, useRouter, type LinkProps } from '@tanstack/react-router'
import { ArrowUpRight, ChevronRight, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { SettingsSection } from '../../contracts/url'
import { BackButton } from '../../ui/Button'
import { FieldRow, HelpTip, RowIcon } from '../../ui/Field'
import { Figure, SectionHeader, StatLabel, type FigureTone } from '../../ui/List'
import { Monogram } from '../../ui/Monogram'

/** TAL-2131: a Settings page's column of groups, 30px between one group and the next header (§4). */
export const SETTINGS_PAGE = 'flex flex-col gap-7.5'
/** A Settings page's `h1`: the section's title, or on a provider's own page (TAL-2135) its name. */
export const SETTINGS_TITLE = 'settings-section-title text-lg font-semibold tracking-(--heading-tracking) text-text leading-[1.3] mb-1'

// The Settings kit's rows that read no server setting, apart from `SettingsRows.tsx` so a page can use them without
// loading the settings store (TAL-2106: the Extensions chunk reaching it split the static Menu chunk past the layout budget).

/** A labelled control that is not a server setting (device-local preferences, lists of switches). `stacked` puts a multi-control body under its label. */
export function SettingRow({ label, hint, htmlFor, stacked, icon, detail, children }: { label: string; hint?: string | undefined; htmlFor?: string; stacked?: boolean; icon?: LucideIcon; detail?: ReactNode; children: ReactNode }) {
  return <FieldRow label={label} hint={hint} htmlFor={htmlFor} icon={icon} detail={detail} inline={!stacked}>{children}</FieldRow>
}

/** A label with action button(s) at the right; the button's own `variant` carries any danger styling. `detail` is its second line (TAL-2135). */
export function SettingAction({ label, hint, icon, detail, children }: { label: string; hint?: string; icon?: LucideIcon; detail?: ReactNode; children?: ReactNode }) {
  return <FieldRow label={label} hint={hint} icon={icon} detail={detail} inline>{children}</FieldRow>
}

/** TAL-2081: read-only label/value rows (versions, keyboard shortcuts) as one `<dl>`; each row is a `SettingValue`. */
export function SettingValues({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col divide-y divide-border-subtle">{children}</dl>
}

/** One row of `SettingValues`: the label at the left, after its optional row `icon` (§12), the value at the right in muted text. */
export function SettingValue({ label, icon: Icon, children }: { label: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <dt className="flex min-w-0 shrink-0 items-center gap-2.5 text-text">{Icon && <Icon size={18} strokeWidth={1.75} aria-hidden="true" data-row-icon="" className="shrink-0 text-muted" />}{label}</dt>
      <dd className="min-w-0 break-all text-right text-muted">{children}</dd>
    </div>
  )
}

/**
 * TAL-2137: the one choice a page is about (the main model) as its headline: the provider's `Monogram`, the name in
 * `text-xl`, a muted second line, and the action that changes it at the right.
 */
export function SettingHeadline({ monogram, title, detail, action }: { monogram: string; title: string; detail?: string | undefined; action: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2" data-setting-headline="">
      <Monogram name={monogram} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold text-strong" title={title}>{title}</p>
        {detail && <p className="truncate text-xs text-muted" title={detail}>{detail}</p>}
      </div>
      {action}
    </div>
  )
}

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** TAL-2135, TAL-2138: this page was opened from a row on its parent page, so Back returns there where it was scrolled. */
    settingsParent?: true
  }
}

/**
 * TAL-2081: a row that is itself the control: an external page in a new tab (`href`, ending in §12's Open symbol), a dialog
 * (`onClick`, a chevron), or a Settings sub-page (`link`, a chevron; TAL-2138). `detail` is trailing muted text before the symbol.
 */
export function SettingLink({ label, icon: Icon, detail, ...target }: { label: string; icon?: LucideIcon; detail?: string } & ({ href: string } | { onClick: () => void } | { link: LinkProps })) {
  const className = 'flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left text-sm text-text transition-colors hover:text-accent-text focus-visible:outline-2 focus-visible:outline-accent'
  const icon = { size: 14, 'aria-hidden': true, className: 'shrink-0 text-muted' } as const
  const text = Icon ? <span className="flex min-w-0 items-center gap-2.5"><RowIcon icon={Icon} />{label}</span> : label
  const end = (symbol: ReactNode) => detail ? <span className="flex shrink-0 items-center gap-2 text-xs text-muted">{detail}{symbol}</span> : symbol
  if ('href' in target) return <a className={className} href={target.href} target="_blank" rel="noopener noreferrer">{text}{end(<ArrowUpRight {...icon} />)}</a>
  if ('link' in target) return <Link {...target.link} state={{ settingsParent: true }} className={className}>{text}{end(<ChevronRight {...icon} />)}</Link>
  return <button type="button" className={className} onClick={target.onClick}>{text}{end(<ChevronRight {...icon} />)}</button>
}

/**
 * TAL-2135, TAL-2138: a sub-page's link back to its parent section. Opened from the parent's row, it goes back in history,
 * so the parent returns where it was scrolled; opened directly, it navigates to the parent.
 */
export function SettingsBack({ label, section }: { label: string; section: SettingsSection }) {
  const navigate = useNavigate()
  const router = useRouter()
  const fromParent = useLocation({ select: (l) => l.state.settingsParent === true })
  return <div><BackButton label={label} onClick={() => { if (fromParent) router.history.back(); else void navigate({ to: '/settings/$section', params: { section } }) }} /></div>
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
