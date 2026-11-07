import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

const LABEL = 'text-xs uppercase tracking-wider text-muted'

/** A plain list on the page background (`docs/design-system.md` §3). */
export function RowList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul {...props} className={cn('flex flex-col', className)} />
}

/** One item of a `RowList`, split from its neighbours by a hairline; `compact` is the one-line row for items without data. */
export function Row({ compact, className, ...props }: ComponentProps<'li'> & { compact?: boolean }) {
  return <li {...props} className={cn(compact ? 'flex flex-wrap items-baseline gap-x-2 border-t border-border-subtle py-2 text-xs' : 'flex flex-col gap-4 border-t border-border py-4 first:border-t-0', className)} />
}

/** The `h3` above a group of rows (§4). `detail` is live data (a peak, a count), never an explanation; `action` sits at the right. */
export function SectionHeader({ children, detail, action, className }: { children: ReactNode; detail?: ReactNode; action?: ReactNode; className?: string }) {
  if (detail == null && action == null) return <h3 className={cn(LABEL, 'font-medium', className)}>{children}</h3>
  return (
    <div className={cn('flex min-w-0 items-baseline gap-2', className)}>
      <h3 className={cn('shrink-0', LABEL, 'font-medium')}>{children}</h3>
      {detail != null && <span className="min-w-0 truncate text-xs font-normal text-muted">{detail}</span>}
      {action != null && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  )
}

/** The label of one stat in a stat grid's `<dl>` (§5). */
export function StatLabel({ children }: { children: ReactNode }) {
  return <dt className={LABEL}>{children}</dt>
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
