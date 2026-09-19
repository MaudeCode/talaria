import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { m } from '../../../paraglide/messages.js'
import { toolText } from '../../../i18n/toolText'
import { useLocale } from '../../../i18n/useLocale'
import { toolKind } from '../toolKind'
import type { ToolCardData } from './ToolCard'

export type ActivityMode = 'compact_worklog' | 'transparent_stream' | 'hide_all_activity'

/**
 * Compact worklog: one summary line ("Read 3 files · Ran a command") that
 * expands to the individual cards. Transparent stream renders the children
 * inline in order. Hide mode renders nothing.
 */
export function Worklog({ mode, calls, live, children, defaultOpen, hasReasoning }: { mode: ActivityMode; calls: ToolCardData[]; live: boolean; children: ReactNode; defaultOpen?: boolean; hasReasoning?: boolean }) {
  const locale = useLocale()
  const [open, setOpen] = useState(!!defaultOpen)
  if (mode === 'hide_all_activity') return null
  if (mode === 'transparent_stream') return <div className="transparent-stream flex flex-col">{children}</div>
  if (calls.length === 0 && !hasReasoning) return <>{children}</>
  const text = toolText(locale)
  const byKind = new Map<string, number>()
  for (const c of calls) byKind.set(toolKind(c.name), (byKind.get(toolKind(c.name)) ?? 0) + 1)
  const state = live && calls.some((c) => !c.done) ? 'running' : 'done'
  const summary = state === 'running' ? text.summaryJoin([...byKind.entries()].map(([kind, n]) => text.worklogSummary(kind, state, n))) || m.thinking_label() : text.processedElapsed()
  const failed = calls.filter((c) => c.isError).length
  return (
    <div className={cn('tool-group tool-worklog-group agent-activity-group', state === 'running' && 'running', !open && 'tool-worklog-tool-group-collapsed')} data-tool-worklog-group="1" data-open={open ? '1' : '0'}>
      <button type="button" className="tool-call-group-summary tool-worklog-summary activity-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="as-dot" aria-hidden="true" />
        <span className="tool-call-group-label tool-worklog-label as-text">{summary}</span>
        {failed > 0 && <span className="tool-call-group-duration text-error">{failed}✕</span>}
        <span className="tool-call-group-chevron as-caret"><ChevronRight size={12} aria-hidden="true" /></span>
      </button>
      <div className="tool-call-group-body tool-worklog-body activity-body" hidden={!open}><div className="worklog"><div className="tool-worklog-list">{children}</div></div></div>
    </div>
  )
}
