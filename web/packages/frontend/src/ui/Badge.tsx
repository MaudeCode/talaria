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

export type DotState = 'ok' | 'warning' | 'error' | 'idle'
const DOT: Record<DotState, string> = { ok: 'bg-success', warning: 'bg-warning', error: 'bg-error', idle: 'bg-muted' }

/**
 * TAL-2131: a state as a 7px dot and its words (§7); the words stay muted, the dot alone takes the server's state colour.
 * TAL-2142: `wrap` lets words that must be read whole (what an extension can access) run onto more lines, the dot on the first.
 */
export function StatusDot({ state, title, wrap, children }: { state: DotState; title?: string | undefined; wrap?: boolean; children: ReactNode }) {
  return (
    <span title={title} data-status={state} className={cn('inline-flex min-w-0 gap-1.5 text-xs text-muted', wrap ? 'items-baseline' : 'items-center')}>
      <span aria-hidden="true" className={cn('size-[7px] shrink-0 rounded-full', wrap && 'translate-y-[-1px]', DOT[state])} />
      <span className={cn('min-w-0', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>{children}</span>
    </span>
  )
}
