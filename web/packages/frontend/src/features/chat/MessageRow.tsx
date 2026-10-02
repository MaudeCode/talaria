import { memo } from 'react'
import { AlertTriangle, ArrowUp, CheckCircle2, Copy, GitBranch, Info, Pencil, RotateCcw, Volume2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { BackgroundLine, Message } from '../../contracts'
import { Markdown } from './render/Markdown'
import { messageText } from './render/text'
import type { ActivityMode } from './blocks/Worklog'
import { persistedActivity } from './turnActivity'
import { TurnActivityView } from './TurnActivityView'
import { CollapsedBody } from './CollapsedBody'
import type { VisibleMessage } from './useTranscript'
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

export const UserMessageRow = memo(function UserMessageRow({ row, renderMarkdown, sessionId, actions }: { row: VisibleMessage; renderMarkdown: boolean; sessionId: string | undefined; actions: RowActions }) {
  const text = messageText(row.message.content)
  return (
    <div className="msg-row" data-role="user" data-msg-idx={row.index} data-message-key={row.key}>
      <AttachmentList message={row.message} sessionId={sessionId} />
      <CollapsedBody excerpt={row.message._display_truncated ? row.message._display_excerpt : undefined}>
        {(excerpt) => <div className="msg-body">{renderMarkdown ? <Markdown text={excerpt ?? text} /> : <div className="whitespace-pre-wrap">{excerpt ?? text}</div>}</div>}
      </CollapsedBody>
      <div className="msg-foot">
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        <IconButton label={m.copy()} className="h-6 w-6" onClick={() => { void navigator.clipboard.writeText(text).then(() => showToast(m.copied())) }}><Copy size={12} aria-hidden="true" /></IconButton>
        {actions.onEdit && <IconButton label={m.edit_message()} className="h-6 w-6" onClick={() => actions.onEdit?.(row, text)}><Pencil size={12} aria-hidden="true" /></IconButton>}
        {actions.onBranch && <IconButton label={m.branch_from_here()} className="h-6 w-6" onClick={() => actions.onBranch?.(row)}><GitBranch size={12} aria-hidden="true" /></IconButton>}
      </div>
    </div>
  )
})

/**
 * A localized line with `label` set in its own element (`code` for a command), wherever the wording puts it. Only the
 * label truncates, so the verb stays readable on one line.
 */
function LineText({ text, label, code }: { text: (label: string) => string; label: string; code?: boolean }) {
  const [before = '', after = ''] = text('\u0000').split('\u0000')
  return (
    <span className="flex min-w-0 whitespace-pre">
      {before && <span className="shrink-0">{before}</span>}
      {code ? <code className="min-w-0 truncate font-mono text-[12px] leading-[inherit]" title={label}>{label}</code> : <span className="min-w-0 truncate text-text" title={label}>{label}</span>}
      {after && <span className="shrink-0">{after}</span>}
    </span>
  )
}

function BackgroundLineRow({ line }: { line: BackgroundLine }) {
  const failed = line.status === 'failed'
  const Icon = failed ? AlertTriangle : line.status === 'notice' ? Info : CheckCircle2
  const exit = line.exit_code === null || line.exit_code === undefined ? null : String(line.exit_code)
  const text = line.kind === 'agent'
    ? <LineText label={line.label} text={(goal) => (failed ? m.background_line_agent_failed({ goal }) : m.background_line_agent_completed({ goal }))} />
    : line.kind === 'command'
    ? <LineText code label={line.label} text={(command) => (failed && exit !== null ? m.background_line_command_failed_exit({ command, code: exit }) : failed ? m.background_line_command_failed({ command }) : m.background_line_command_finished({ command }))} />
    : line.label
  return (
    <li className="flex items-center gap-2">
      <Icon size={14} aria-hidden="true" className={cn('shrink-0', failed ? 'text-warning' : 'text-muted')} />
      <span className="min-w-0 truncate">{text}</span>
    </li>
  )
}

/**
 * TAL-460: an automatic background wakeup the server marked `_background_update`, in its chronological place as one quiet
 * line per finished item, never as the user's own bubble. The Agent's reply follows as an ordinary assistant message;
 * the full notification (copyable) opens from the lines.
 */
export const BackgroundUpdateRow = memo(function BackgroundUpdateRow({ row }: { row: VisibleMessage }) {
  const update = row.message._background_update
  if (!update) return null
  const text = messageText(row.message.content)
  return (
    <div className="msg-row" data-role="background" data-msg-idx={row.index} data-message-key={row.key}>
      <details className="background-update text-[13px] text-muted">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden" aria-label={m.background_update_details()}>
          <ul className="flex flex-col gap-1">{update.lines.map((line, i) => <BackgroundLineRow key={i} line={line} />)}</ul>
        </summary>
        <div className="mt-2 rounded-md border border-border bg-surface px-3 py-2">
          <CollapsedBody excerpt={row.message._display_truncated ? row.message._display_excerpt : undefined}>
            {(excerpt) => <div className="msg-body whitespace-pre-wrap">{excerpt ?? text}</div>}
          </CollapsedBody>
          <div className="msg-foot">
            {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
            <IconButton label={m.copy()} className="h-6 w-6" onClick={() => { void navigator.clipboard.writeText(text).then(() => showToast(m.copied())) }}><Copy size={12} aria-hidden="true" /></IconButton>
          </div>
        </div>
      </details>
    </div>
  )
})

export const AssistantMessageRow = memo(function AssistantMessageRow({ row, name, mode, actions, tts, isLast, sessionId, scope }: { row: VisibleMessage; name: string; mode: ActivityMode; actions: RowActions; tts: boolean; isLast: boolean; sessionId?: string | undefined; scope?: string | undefined }) {
  const activity = persistedActivity(row)
  const content = activity.finalAnswer || activity.items.flatMap((item) => item.kind === 'text' ? [item.text] : []).join('\n\n')
  const run = row.message as { _turnDuration?: number | null; _usedModel?: string | null }
  const meta = [typeof run._turnDuration === 'number' && run._turnDuration >= 0.5 ? `${run._turnDuration < 10 ? run._turnDuration.toFixed(1) : Math.round(run._turnDuration)}s` : null, run._usedModel || null].filter(Boolean).join(' · ')
  return (
    <div className="msg-row assistant-turn" data-role="assistant" data-msg-idx={row.index} data-message-key={row.key} data-latest={isLast ? '1' : undefined}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span>{row.message.badge && <span className="msg-badge">{row.message.badge}</span>}</div>
      <div className="assistant-turn-blocks">
        <TurnActivityView activity={activity} mode={mode} sessionId={sessionId} scope={scope} />
        {(row.assistantRows ?? [row]).map((part) => <AttachmentList key={part.key} message={part.message} sessionId={undefined} />)}
      </div>
      <div className={cn('msg-foot', isLast && 'msg-foot-latest')}>
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        {meta && <span className="msg-run-meta font-mono text-[11px] tabular-nums text-muted opacity-75">{meta}</span>}
        <span className="ml-auto" aria-hidden="true" />
        <IconButton label={m.copy()} className="h-6 w-6" onClick={() => { void navigator.clipboard.writeText(content).then(() => showToast(m.copied())) }}><Copy size={12} aria-hidden="true" /></IconButton>
        {tts && content.trim() && <IconButton label={m.speak_message()} className="h-6 w-6" onClick={() => { void speak(content) }}><Volume2 size={12} aria-hidden="true" /></IconButton>}
        {actions.onRegenerate && isLast && <IconButton label={m.regenerate_response()} className="h-6 w-6" onClick={() => actions.onRegenerate?.(row)}><RotateCcw size={12} aria-hidden="true" /></IconButton>}
        <IconButton label={m.jump_to_question_label()} className="msg-question-jump-btn h-6 w-6" onClick={(e) => { const rowEl = (e.currentTarget as HTMLElement).closest('.msg-row'); let prev = rowEl?.previousElementSibling; while (prev && !(prev instanceof HTMLElement && prev.dataset.role === 'user')) prev = prev.previousElementSibling; prev?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}><ArrowUp size={12} aria-hidden="true" /></IconButton>
      </div>
    </div>
  )
})
