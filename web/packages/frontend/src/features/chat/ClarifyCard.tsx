import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, HelpCircle } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { IconButton } from '../../ui/Button'
import { HelpTip } from '../../ui/Field'
import { cn } from '../../ui/cn'
import type { Clarify } from './useClarify'

/** The active clarification step: its question and choices, with the server countdown; the composer takes the typed answer. */
export function ClarifyCard({ clarify }: { clarify: Clarify }) {
  const { pending, step, index, total, selected, busy } = clarify
  const [collapsed, setCollapsed] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(pending.timeout_seconds ?? null)
  const hasTimeout = remaining !== null
  useEffect(() => {
    if (!hasTimeout) return
    const t = window.setInterval(() => setRemaining((r) => (r === null ? null : Math.max(0, r - 1))), 1000)
    return () => window.clearInterval(t)
  }, [hasTimeout])
  return (
    <div className={cn('visible', collapsed && 'collapsed', "clarify-card mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-info bg-surface shadow-md")} role="dialog" aria-labelledby="clarifyHeading" aria-describedby="clarifyQuestion" id="clarifyCard">
      <div className="clarify-inner p-3">
        <div className="clarify-header flex items-center gap-2 text-sm font-semibold text-text">
          <HelpCircle size={14} className="text-info" aria-hidden="true" />
          <span id="clarifyHeading">{pending.title ?? m.clarify_heading()}</span>
          <HelpTip label={m.field_help_about({ label: pending.title ?? m.clarify_heading() })} className="shrink-0">{m.clarify_hint()}</HelpTip>
          {remaining !== null && <span className="clarify-countdown text-xs tabular-nums text-muted" aria-live="polite">{remaining}s</span>}
          {total > 1 && <span className="text-xs text-muted">{m.clarify_progress({ a0: index + 1, a1: total })}</span>}
          <span className="flex-1" />
          <IconButton label={collapsed ? m.approval_expand() : m.approval_collapse()} className="h-7 w-7" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</IconButton>
        </div>
        <div className={cn(collapsed && 'hidden')}>
          <div className="clarify-question mt-1 whitespace-pre-wrap text-[13px] text-text" id="clarifyQuestion">{step.question}</div>
          {step.choices.length > 0 && (
            <div className="clarify-choices mt-2 flex flex-wrap gap-2">
              {step.choices.map((c, i) => (
                <button key={`${c}-${i}`} type="button" disabled={busy} aria-pressed={step.multi_select ? selected.includes(c) : undefined} onClick={() => clarify.choose(c)} className={cn('rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:border-accent hover:text-accent-text', selected.includes(c) && 'border-accent text-accent-text')}>{c}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
