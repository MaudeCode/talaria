import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { m } from '../../../paraglide/messages.js'
import { toolText } from '../../../i18n/toolText'
import { useLocale } from '../../../i18n/useLocale'
import { readPersistedJson, writePersistedJson } from '../../../lib/persisted'
import type { ToolCardData } from './ToolCard'

export type ActivityMode = 'compact_worklog' | 'transparent_stream' | 'hide_all_activity'

const DisclosureContext = createContext<{ choices: Record<string, boolean>; choose: (key: string, open: boolean) => void; forget: (key: string) => void } | null>(null)
export const DisclosureTurnContext = createContext('')
/**
 * A turn worklog's Expand all / Collapse all: every row disclosure inside it, nested groups included, registers a reset,
 * and `open` is the last bulk choice. It stays in memory so a long worklog never meets the stored-choice cap.
 */
const ExpandAllContext = createContext<{ resets: Set<() => void>; open: boolean | undefined } | null>(null)

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
  const forget = (key: string) => {
    setChoices((previous) => key in previous ? Object.fromEntries(Object.entries(previous).filter(([k]) => k !== key)) : previous)
  }
  return <DisclosureContext value={{ choices, choose, forget }}>{children}</DisclosureContext>
}

export function useDisclosure(id: string, defaultOpen: boolean): [boolean, () => void] {
  const context = useContext(DisclosureContext)
  const turn = useContext(DisclosureTurnContext)
  const key = JSON.stringify([turn, id])
  const [local, setLocal] = useState<boolean | undefined>()
  const all = useContext(ExpandAllContext)
  // A row's own choice wins; the bulk action clears those first, so only choices made after it remain.
  const open = context?.choices[key] ?? local ?? all?.open ?? defaultOpen
  useEffect(() => {
    if (!all) return
    const reset = () => { if (context) context.forget(key); else setLocal(undefined) }
    all.resets.add(reset)
    return () => { all.resets.delete(reset) }
  })
  return [open, () => { if (context) context.choose(key, !open); else setLocal(!open) }]
}

export function terminalOutcomeLabel(status: string): string | null {
  switch (status) {
    case 'running': case 'completed': return null
    case 'cancelled': return m.live_cancelled()
    case 'no_response': return m.worklog_no_answer()
    case 'interrupted': case 'connection_lost': return m.worklog_interrupted()
    case 'tool_limit_reached': return m.worklog_tool_limit()
    case 'compression_exhausted': return m.worklog_context_limit()
    default: return m.live_error()
  }
}

export function Worklog({ calls, status, children, sequenceKey, disclosureId = 'turn', active = false, activeLabel, expandedByDefault = false }: { calls: ToolCardData[]; status: string; children: ReactNode; sequenceKey?: string; /** A turn-level disclosure's key, one per phase of a steered turn. */ disclosureId?: string; active?: boolean; activeLabel?: string | undefined; expandedByDefault?: boolean }) {
  const locale = useLocale()
  const nested = sequenceKey !== undefined
  const running = status === 'running'
  // A live turn shows its work inline; the turn-level disclosure appears only once it settles.
  const live = !nested && running
  // The server decides whether a settled turn's work opens by default; nested groups start closed.
  const defaultOpen = !nested && expandedByDefault
  const [chosen, toggle] = useDisclosure(sequenceKey ?? disclosureId, defaultOpen)
  const open = live || chosen
  const bodyId = useId()
  // Only the turn-level worklog owns the control; nested groups and their rows register with it.
  const [resets] = useState(() => new Set<() => void>())
  const [all, setAll] = useState<boolean>()
  const setEvery = (next: boolean) => { for (const reset of resets) reset(); setAll(next) }
  const text = toolText(locale)
  const byKind = new Map<string, number>()
  for (const c of calls) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1)
  const failed = calls.filter((call) => call.isError).length
  const summary = activeLabel || (nested || (!running && status !== 'completed')
    ? text.summaryJoin([...byKind.entries()].map(([kind, n]) => text.worklogSummary(kind, calls.some((c) => !c.done) ? 'running' : 'done', n))) || m.thinking_label()
    : text.processedElapsed())
  return (
    <div className={cn('tool-group tool-worklog-group agent-activity-group activity', nested && 'activity-sequence-group', open && 'open', running && 'running', !open && 'tool-worklog-tool-group-collapsed')} data-tool-worklog-group="1" data-worklog-status={status} data-activity-sequence-group={nested ? '1' : undefined} data-live-activity-current={active ? '1' : undefined} data-open={open ? '1' : '0'}>
      {!live && (
        <button type="button" className="tool-call-group-summary tool-worklog-summary activity-summary" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          <span className="as-dot" aria-hidden="true" />
          <span className="tool-call-group-label tool-worklog-label as-text">{summary}</span>
          {failed > 0 && <span className="tool-call-group-duration text-error">{failed}✕</span>}
          <span className={cn('tool-call-group-chevron as-caret', open && 'rotate-90')}><ChevronRight size={12} aria-hidden="true" /></span>
        </button>
      )}
      <div id={bodyId} className="tool-call-group-body tool-worklog-body activity-body" hidden={!open}>
        <div className="worklog">
          {!nested && calls.length > 0 && (
            <div className="tool-worklog-controls">
              <button type="button" className="tool-worklog-control" onClick={() => { setEvery(true) }}>{m.expand_all()}</button>
              <button type="button" className="tool-worklog-control" onClick={() => { setEvery(false) }}>{m.collapse_all()}</button>
            </div>
          )}
          <div className="tool-worklog-list">{nested ? children : <ExpandAllContext value={{ resets, open: all }}>{children}</ExpandAllContext>}</div>
        </div>
      </div>
    </div>
  )
}
