import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { m } from '../../../paraglide/messages.js'
import { toolText } from '../../../i18n/toolText'
import { useLocale } from '../../../i18n/useLocale'
import { readPersistedJson, writePersistedJson } from '../../../lib/persisted'
import { toolKind } from '../toolKind'
import type { ToolCardData } from './ToolCard'

export type ActivityMode = 'compact_worklog' | 'transparent_stream' | 'hide_all_activity'

const DisclosureContext = createContext<{ choices: Record<string, boolean>; choose: (key: string, open: boolean) => void } | null>(null)
export const DisclosureTurnContext = createContext('')

/** Renderer preferences only, scoped to profile/session and bounded to recent disclosures. */
export function WorklogDisclosureProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const storageKey = `hermes-worklog:v1:${scope}`
  const [choices, setChoices] = useState(() => readPersistedJson(storageKey, z.record(z.string(), z.boolean())) ?? {})
  useEffect(() => { writePersistedJson(storageKey, choices) }, [storageKey, choices])
  const choose = (key: string, open: boolean) => {
    setChoices((previous) => {
      const next = Object.fromEntries([...Object.entries(previous).filter(([k]) => k !== key), [key, open]].slice(-200)) as Record<string, boolean>
      return next
    })
  }
  return <DisclosureContext value={{ choices, choose }}>{children}</DisclosureContext>
}

export function useDisclosure(id: string, defaultOpen: boolean): [boolean, () => void] {
  const context = useContext(DisclosureContext)
  const turn = useContext(DisclosureTurnContext)
  const key = JSON.stringify([turn, id])
  const [local, setLocal] = useState<boolean | undefined>()
  const open = context?.choices[key] ?? local ?? defaultOpen
  return [open, () => { if (context) context.choose(key, !open); else setLocal(!open) }]
}

export function Worklog({ calls, status, children, sequenceKey }: { calls: ToolCardData[]; status: string; children: ReactNode; sequenceKey?: string }) {
  const locale = useLocale()
  const nested = sequenceKey !== undefined
  const running = status === 'running'
  const defaultOpen = !nested && (running || ['error', 'no_response', 'degraded', 'connection_lost', 'tool_limit_reached', 'compression_exhausted'].includes(status))
  const [open, toggle] = useDisclosure(sequenceKey ?? 'turn', defaultOpen)
  const bodyId = useId()
  const text = toolText(locale)
  const byKind = new Map<string, number>()
  for (const c of calls) byKind.set(toolKind(c.name), (byKind.get(toolKind(c.name)) ?? 0) + 1)
  const failed = calls.filter((call) => call.isError).length
  const summary = nested
    ? text.summaryJoin([...byKind.entries()].map(([kind, n]) => text.worklogSummary(kind, calls.some((c) => !c.done) ? 'running' : 'done', n))) || m.thinking_label()
    : status === 'completed' ? text.processedElapsed()
      : status === 'cancelled' ? m.live_cancelled()
        : running ? m.live_streaming() : status === 'no_response' ? m.worklog_no_answer()
          : status === 'interrupted' || status === 'connection_lost' ? m.worklog_interrupted()
            : status === 'tool_limit_reached' ? m.worklog_tool_limit()
              : status === 'compression_exhausted' ? m.worklog_context_limit() : m.live_error()
  return (
    <div className={cn('tool-group tool-worklog-group agent-activity-group activity', open && 'open', running && 'running', !open && 'tool-worklog-tool-group-collapsed')} data-tool-worklog-group="1" data-worklog-status={status} data-activity-sequence-group={nested ? '1' : undefined} data-open={open ? '1' : '0'}>
      <button type="button" className="tool-call-group-summary tool-worklog-summary activity-summary" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className="as-dot" aria-hidden="true" />
        <span className="tool-call-group-label tool-worklog-label as-text">{summary}</span>
        {failed > 0 && <span className="tool-call-group-duration text-error">{failed}✕</span>}
        <span className={cn('tool-call-group-chevron as-caret', open && 'rotate-90')}><ChevronRight size={12} aria-hidden="true" /></span>
      </button>
      <div id={bodyId} className="tool-call-group-body tool-worklog-body activity-body" hidden={!open}><div className="worklog"><div className="tool-worklog-list">{children}</div></div></div>
    </div>
  )
}
