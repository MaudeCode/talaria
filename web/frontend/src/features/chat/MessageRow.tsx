import { memo, useMemo } from 'react'
import { ArrowUp, Copy, GitBranch, Pencil, RotateCcw, Volume2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { Message } from '../../contracts'
import { Markdown } from './render/Markdown'
import { extractInlineThinking, messageText } from './render/text'
import { ReasoningBlock } from './blocks/ReasoningBlock'
import { ToolCard, type ToolCardData } from './blocks/ToolCard'
import { Worklog, type ActivityMode } from './blocks/Worklog'
import { toolCallId, messageKey, toolCallName, toolCallArgs, type VisibleMessage } from './useTranscript'
import { IconButton } from '../../ui/Button'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { formatDate } from '../../ui/States'
import { rawFileUrl } from '../../api/endpoints'
import { appUrl } from '../../lib/appRoot'
import { speak } from '../voice/tts'

export interface RowActions {
  onEdit?: (row: VisibleMessage, text: string) => void
  onRegenerate?: (row: VisibleMessage) => void
  onBranch?: (row: VisibleMessage) => void
}

function AttachmentList({ message, sessionId }: { message: Message; sessionId: string | undefined }) {
  const items = message.attachments ?? []
  if (items.length === 0) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label={m.attachments_label()}>
      {items.map((a, i) => {
        const name = a.filename ?? a.name ?? a.path?.split('/').pop() ?? `file-${i + 1}`
        const href = a.path && sessionId ? appUrl(rawFileUrl(sessionId, a.path)).href : undefined
        return (
          <li key={`${name}-${i}`} className="attachment-chip rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-text">
            {a.is_image && href ? <img src={href} alt={name} className="max-h-48 rounded" loading="lazy" /> : href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{name}</a> : <span>{name}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export function toolCardsFor(message: Message, toolResults: Record<string, Message>): ToolCardData[] {
  return (message.tool_calls ?? []).map((tc, i) => {
    const id = toolCallId(tc, `${messageKey(message) ?? 'm'}-${i}`)
    const result = toolResults[id]
    return { id, name: toolCallName(tc) ?? 'tool', args: toolCallArgs(tc), preview: tc.preview ?? null, done: tc.done ?? true, isError: !!tc.is_error, duration: tc.duration ?? null, costUsd: tc.cost_usd ?? null, result: result ? messageText(result.content) : tc.result ?? tc.output ?? null }
  })
}

export const UserMessageRow = memo(function UserMessageRow({ row, renderMarkdown, sessionId, actions }: { row: VisibleMessage; renderMarkdown: boolean; sessionId: string | undefined; actions: RowActions }) {
  const text = messageText(row.message.content)
  return (
    <div className="msg-row" data-role="user" data-msg-idx={row.index} data-message-key={row.key}>
      <AttachmentList message={row.message} sessionId={sessionId} />
      <div className="msg-body">{renderMarkdown ? <Markdown text={text} /> : <div className="whitespace-pre-wrap">{text}</div>}</div>
      <div className="msg-foot">
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        <IconButton label={m.copy()} className="h-6 w-6" onClick={() => { void navigator.clipboard.writeText(text).then(() => showToast(m.copied())) }}><Copy size={12} aria-hidden="true" /></IconButton>
        {actions.onEdit && <IconButton label={m.edit_message()} className="h-6 w-6" onClick={() => actions.onEdit?.(row, text)}><Pencil size={12} aria-hidden="true" /></IconButton>}
        {actions.onBranch && <IconButton label={m.branch_from_here()} className="h-6 w-6" onClick={() => actions.onBranch?.(row)}><GitBranch size={12} aria-hidden="true" /></IconButton>}
      </div>
    </div>
  )
})

export const AssistantMessageRow = memo(function AssistantMessageRow({ row, name, mode, actions, tts, isLast }: { row: VisibleMessage; name: string; mode: ActivityMode; actions: RowActions; tts: boolean; isLast: boolean }) {
  const raw = messageText(row.message.content)
  const split = useMemo(() => extractInlineThinking(raw), [raw])
  const reasoning = [row.message.reasoning_content, typeof row.message.reasoning === 'string' ? row.message.reasoning : '', row.message.thinking, split.reasoning].filter((x): x is string => !!x && x.trim() !== '').join('\n')
  const calls = useMemo(() => toolCardsFor(row.message, row.toolResults), [row])
  const run = row.message as { _turnDuration?: number | null; _usedModel?: string | null }
  const meta = [typeof run._turnDuration === 'number' && run._turnDuration >= 0.5 ? `${run._turnDuration < 10 ? run._turnDuration.toFixed(1) : Math.round(run._turnDuration)}s` : null, run._usedModel || null].filter(Boolean).join(' · ')
  return (
    <div className="msg-row assistant-turn" data-role="assistant" data-msg-idx={row.index} data-message-key={row.key} data-latest={isLast ? '1' : undefined}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span>{row.message.badge && <span className="msg-badge">{row.message.badge}</span>}</div>
      <div className="assistant-turn-blocks">
        {calls.length > 0 ? (
          <Worklog mode={mode} calls={calls} live={false} hasReasoning={!!reasoning}>
            {reasoning && <ReasoningBlock text={reasoning} />}
            {calls.map((c) => <ToolCard key={c.id} call={c} />)}
          </Worklog>
        ) : reasoning ? <ReasoningBlock text={reasoning} /> : null}
        {split.content.trim() && <div className="msg-body"><Markdown text={split.content} /></div>}
        <AttachmentList message={row.message} sessionId={undefined} />
      </div>
      <div className={cn('msg-foot', isLast && 'msg-foot-latest')}>
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        {meta && <span className="msg-run-meta font-mono text-[11px] tabular-nums text-muted opacity-75">{meta}</span>}
        <span className="ml-auto" aria-hidden="true" />
        <IconButton label={m.copy()} className="h-6 w-6" onClick={() => { void navigator.clipboard.writeText(split.content).then(() => showToast(m.copied())) }}><Copy size={12} aria-hidden="true" /></IconButton>
        {tts && split.content.trim() && <IconButton label={m.speak_message()} className="h-6 w-6" onClick={() => { void speak(split.content) }}><Volume2 size={12} aria-hidden="true" /></IconButton>}
        {actions.onRegenerate && isLast && <IconButton label={m.regenerate_response()} className="h-6 w-6" onClick={() => actions.onRegenerate?.(row)}><RotateCcw size={12} aria-hidden="true" /></IconButton>}
        <IconButton label={m.jump_to_question_label()} className="msg-question-jump-btn h-6 w-6" onClick={(e) => { const rowEl = (e.currentTarget as HTMLElement).closest('.msg-row'); let prev = rowEl?.previousElementSibling; while (prev && !(prev instanceof HTMLElement && prev.dataset.role === 'user')) prev = prev.previousElementSibling; prev?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}><ArrowUp size={12} aria-hidden="true" /></IconButton>
      </div>
    </div>
  )
})
