import { cn } from './cn'

/** A small status chip; `tone` picks its border and text colour. */
export function Badge({ tone, title, children }: { tone: string; title?: string | undefined; children: string }) {
  return <span title={title} className={cn('rounded-full border px-1.5 text-[10px] uppercase tracking-wider', tone)}>{children}</span>
}
