import { useDisclosure } from './Worklog'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../ui/cn'
import { ToolKindIcon, toolKind, toolTarget } from '../toolKind'
import { toolText } from '../../../i18n/toolText'
import { useLocale } from '../../../i18n/useLocale'
import { m } from '../../../paraglide/messages.js'

export interface ToolCardData {
  id: string
  name: string
  args: unknown
  preview: string | null
  done: boolean
  isError: boolean
  duration: number | null
  costUsd: number | null
  result: unknown
}

export function toolCardLabel(call: ToolCardData, locale: string): string {
  const kind = toolKind(call.name)
  return toolText(locale).actionLabel(kind, call.done ? 'done' : 'running', toolTarget(call.name, call.args), call.name, call.isError)
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[unserializable]'
  }
}

/** One tool invocation. Collapsed by default: verb + target; details show arguments and result preview as text. */
export function ToolCard({ call, timestamp }: { call: ToolCardData; timestamp?: string | undefined }) {
  const locale = useLocale()
  const [open, toggle] = useDisclosure(`tool:${call.id}`, false)
  const kind = toolKind(call.name)
  const label = toolCardLabel(call, locale)
  const args = pretty(call.args)
  const result = call.result !== null && call.result !== undefined ? pretty(call.result) : call.preview ?? ''
  return (
    <div className={cn('tool-card-row tool-card my-1 rounded-lg border border-border-subtle bg-surface-subtle text-[13px]', call.isError && 'border-error/40', !call.done && 'tool-card-running')} data-tool-id={call.id} data-tool-kind={kind} data-tool-done={call.done ? '1' : '0'} data-tool-error={call.isError ? '1' : undefined}>
      <button type="button" className="tool-card-header flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-text" aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className={cn('tool-card-toggle shrink-0 text-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="tool-card-icon"><ToolKindIcon kind={kind} /></span>
        <span className="tool-card-name min-w-0 flex-1 truncate"><span className="tool-card-name-label">{label}</span></span>
        {!call.done && <span className="tool-card-running-dot h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-label={m.status_streaming()} />}
        {call.done && call.duration !== null && <span className="shrink-0 text-[11px] tabular-nums text-muted">{call.duration.toFixed(1)}s</span>}
        {timestamp && <span className="shrink-0 text-[11px] tabular-nums text-muted">{timestamp}</span>}
      </button>
      {open && (
        <div className="tool-card-detail border-t border-border-subtle px-2.5 py-2">
          {args && args !== '{}' && (
            <div className="tool-card-args mb-2">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">{m.tool_args_label()}</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 font-mono text-[12px] text-pre-text">{args}</pre>
            </div>
          )}
          {result && (
            <div className="tool-card-result">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">{call.isError ? m.tool_error_label() : m.tool_result_label()}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-2 font-mono text-[12px] text-pre-text">{result}</pre>
            </div>
          )}
          {call.costUsd !== null && <div className="mt-1 text-[11px] text-muted">${call.costUsd.toFixed(4)}</div>}
        </div>
      )}
    </div>
  )
}
