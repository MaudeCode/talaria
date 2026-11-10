import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

const LABEL = 'text-xs uppercase tracking-wider text-muted'
/** The `SectionHeader` type, for a group heading another component renders (§4): sentence case, as strong as a row name. */
export const SECTION_HEADER = 'text-sm font-semibold text-strong'

/** The meter track (§5), shared by the quota meter and the Kanban timing bar. */
const RAIL = 'relative overflow-hidden rounded-full bg-border'
export const METER_RAIL = `${RAIL} h-2`
/** TAL-2131: the thin share meter at the end of a row, 4px by 84px (§5). */
export const METER_RAIL_THIN = `${RAIL} h-1 w-[84px] shrink-0`

/** A plain list on the page background (`docs/design-system.md` §3); `data-row-list` lets tests tell it from a page-local list. */
export function RowList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul {...props} data-row-list="" className={cn('flex flex-col', className)} />
}

/** One item of a `RowList`, split from its neighbours by a hairline; `compact` is the one-line row for items without data. */
export function Row({ compact, className, ...props }: ComponentProps<'li'> & { compact?: boolean }) {
  return <li {...props} className={cn(compact ? 'flex flex-wrap items-baseline gap-x-2 border-t border-border-subtle py-2 text-xs' : 'flex flex-col gap-4 border-t border-border py-4 first:border-t-0', className)} />
}

/** The `h3` above a group of rows (§4). `detail` is live data (a peak, a count), never an explanation; `action` sits at the right. */
export function SectionHeader({ children, detail, action, className }: { children: ReactNode; detail?: ReactNode; action?: ReactNode; className?: string }) {
  if (detail == null && action == null) return <h3 className={cn(SECTION_HEADER, className)}>{children}</h3>
  return (
    <div className={cn('flex min-w-0 items-baseline gap-2', className)}>
      <h3 className={cn('shrink-0', SECTION_HEADER)}>{children}</h3>
      {detail != null && <span className="min-w-0 truncate text-xs font-normal tabular-nums text-muted">{detail}</span>}
      {action != null && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  )
}

/** The label of one stat in a stat grid's `<dl>` (§5). */
export function StatLabel({ children }: { children: ReactNode }) {
  return <dt className={LABEL}>{children}</dt>
}

export type FigureTone = 'warning' | 'error'
const FIGURE_TONE: Record<FigureTone, string> = { warning: 'text-warning', error: 'text-error' }

/** TAL-2131: a headline figure (§5) with its optional mode word, for a stat grid or the end of a row; `tone` is a server level. */
export function Figure({ value, mode, tone }: { value: string; mode?: string | undefined; tone?: FigureTone | undefined }) {
  return (
    <span className="inline-flex items-baseline gap-1" data-figure-tone={tone}>
      <span className={cn('text-lg font-semibold tabular-nums', tone ? FIGURE_TONE[tone] : 'text-strong')}>{value}</span>
      {mode && <span className="text-xs text-muted">{mode}</span>}
    </span>
  )
}

/** One labelled figure, the App's `ProviderQuotaMetricCell`: the label in small muted type above a semibold value. */
export function MetricCell({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md bg-hover px-2 py-1.5" data-metric={id}>
      <span className="text-[11px] text-muted">{label}</span>
      <span className="truncate text-xs font-semibold tabular-nums text-text">{value}</span>
    </div>
  )
}
