import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from './cn'

/** A small status chip; `tone` picks its border and text colour. Settings, Profiles, Spaces, Logs and Connectors use `Mark` and `StatusDot` instead (§7). */
export function Badge({ tone, title, children }: { tone: string; title?: string | undefined; children: string }) {
  return <span title={title} className={cn('rounded-full border px-1.5 text-xs uppercase tracking-wider', tone)}>{children}</span>
}

/**
 * TAL-2131: the active or selected mark (§7): a check and one or two words in the accent, no border and no fill, so colour
 * never carries it alone. TAL-2146: without words it is the bare check on a control whose own state (`aria-pressed`) names it.
 */
export function Mark({ title, children }: { title?: string | undefined; children?: string }) {
  return (
    <span title={title} data-mark="" aria-hidden={children ? undefined : true} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-text">
      <Check size={13} strokeWidth={2.25} aria-hidden="true" />{children}
    </span>
  )
}

/** `changed` (TAL-2137) marks a value the user set apart from its default, such as a task model off Auto. */
export type DotState = 'ok' | 'warning' | 'error' | 'idle' | 'changed'
/** A state's dot fill; the System update path's nodes (TAL-2140) use it too. */
export const DOT_FILL: Record<DotState, string> = { ok: 'bg-success', warning: 'bg-warning', error: 'bg-error', idle: 'bg-muted', changed: 'bg-accent' }

/** The 7px dot alone, before words that keep their own colour (a task's name); `StatusDot` pairs it with muted words. */
export function Dot({ state, className }: { state: DotState; className?: string | undefined }) {
  return <span aria-hidden="true" data-dot={state} className={cn('size-[7px] shrink-0 rounded-full', className, DOT_FILL[state])} />
}

/**
 * TAL-2131: a state as a 7px dot and its words (§7); the words stay muted, the dot alone takes the server's state colour.
 * TAL-2142: `wrap` lets words that must be read whole (what an extension can access) run onto more lines, the dot on the first.
 */
export function StatusDot({ state, title, wrap, children }: { state: DotState; title?: string | undefined; wrap?: boolean; children: ReactNode }) {
  return (
    <span title={title} data-status={state} className={cn('inline-flex min-w-0 gap-1.5 text-xs text-muted', wrap ? 'items-baseline' : 'items-center')}>
      <Dot state={state} className={wrap ? 'translate-y-[-1px]' : undefined} />
      <span className={cn('min-w-0', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>{children}</span>
    </span>
  )
}
