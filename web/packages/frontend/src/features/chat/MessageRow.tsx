import type { MessageReactionView } from '@maudecode/talaria-web-contracts'
import { Menu, MenuItem } from '../../ui/Menu'
import { memo, useState } from 'react'
import { AlertTriangle, ArrowUp, CalendarClock, Copy, GitBranch, Info, ListChecks, Pencil, RotateCcw, SmilePlus, Shrink, Volume2, Webhook } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { BackgroundLine, Message } from '../../contracts'
import { StatusIcon } from '../background/BackgroundWork'
import { Markdown } from './render/Markdown'
import { messageText } from './render/text'
import type { ActivityMode } from './blocks/Worklog'
import { activityText, continuedActivity, persistedActivity } from './turnActivity'
import type { LiveTurn } from '../../stream/reducer'
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
import { ImageLightbox, type LightboxImage } from './ImageLightbox'

export interface RowActions {
  onQuoteSelection?: (text: string) => void
  onReact?: (row: VisibleMessage, action: MessageReactionView['actions'][number]) => void
  onEdit?: (row: VisibleMessage, text: string) => void
  onRegenerate?: (row: VisibleMessage) => void
  onBranch?: (row: VisibleMessage) => void
}

/** Extends the existing row footer and Menu; both message roles share these counts and actions. */
function MessageReactions({ row, actions }: { row: VisibleMessage; actions: RowActions }) {
  const view = row.message.reaction_view
  if (!view) return null
  const label = (emoji: string, mine: boolean) => mine ? m.reaction_remove({ emoji }) : m.reaction_add({ emoji })
  return <>
    {view.state.items.map((item) => {
      const action = view.actions.find((action) => action.emoji === item.emoji)
      return <button key={item.emoji} type="button" className="message-reaction" aria-pressed={item.mine}
        aria-label={`${label(item.emoji, item.mine)}, ${item.count}`} disabled={!action || !actions.onReact}
        onClick={() => { if (action) actions.onReact?.(row, action) }}><span aria-hidden="true">{item.emoji} {item.count}</span></button>
    })}
    {!!view.actions.length && actions.onReact && <Menu side="top" align="end" label={m.message_reactions()}
      trigger={<IconButton className="message-reaction-trigger" label={m.message_reactions()}><SmilePlus size={14} aria-hidden="true" /></IconButton>}>
      {view.actions.map((action) => <MenuItem className="min-h-11" key={action.emoji ?? 'remove'}
        onClick={() => actions.onReact?.(row, action)}>
        {action.emoji === null ? m.reaction_clear() : label(action.emoji, view.state.selected === action.emoji)}
      </MenuItem>)}
    </Menu>}
  </>
}

function AttachmentList({ message, sessionId }: { message: Message; sessionId: string | undefined }) {
  const [enlarged, setEnlarged] = useState<number | null>(null)
  const images: LightboxImage[] = []
  const items = (message.attachments ?? []).map((a, i) => {
    const name = a.filename ?? a.name ?? a.path?.split('/').pop() ?? `file-${i + 1}`
    const href = a.path && sessionId ? appUrl(rawFileUrl(sessionId, a.path)).href : undefined
    const image = a.is_image && href ? images.push({ name, src: href }) - 1 : undefined
    return { name, href, image }
  })
  if (items.length === 0) return null
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-2" aria-label={m.attachments_label()}>
        {items.map(({ name, href, image }, i) => (
          <li key={`${name}-${i}`} className="attachment-chip rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-text">
            {image !== undefined
              ? <button type="button" aria-label={m.image_enlarge({ name })} className="flex min-h-11 min-w-11 cursor-zoom-in items-center justify-center" onClick={() => setEnlarged(image)}><img src={href} alt={name} className="max-h-48 rounded" loading="lazy" /></button>
              : href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{name}</a> : <span>{name}</span>}
          </li>
        ))}
      </ul>
      <ImageLightbox images={images} index={enlarged} onIndexChange={setEnlarged} />
    </>
  )
}

export const UserMessageRow = memo(function UserMessageRow({ row, renderMarkdown, sessionId, actions, pending = false }: { row: VisibleMessage; renderMarkdown: boolean; sessionId: string | undefined; actions: RowActions; pending?: boolean }) {
  const text = messageText(row.message.content)
  return (
    <div className="msg-row" data-role="user" data-msg-idx={pending ? undefined : row.index} data-message-key={row.key} data-live-user={pending ? "1" : undefined} aria-busy={pending || undefined}>
      <AttachmentList message={row.message} sessionId={sessionId} />
      <CollapsedBody excerpt={row.message._display_truncated ? row.message._display_excerpt : undefined}>
        {(excerpt) => <div className="msg-body">{renderMarkdown ? <Markdown text={excerpt ?? text} /> : <div className="whitespace-pre-wrap">{excerpt ?? text}</div>}</div>}
      </CollapsedBody>
      {!pending && <div className="msg-foot">
        <MessageReactions row={row} actions={actions} />
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        <IconButton label={m.copy()} className="h-6 w-6" onClick={() => { void navigator.clipboard.writeText(text).then(() => showToast(m.copied())) }}><Copy size={12} aria-hidden="true" /></IconButton>
        {actions.onEdit && <IconButton label={m.edit_message()} className="h-6 w-6" onClick={() => actions.onEdit?.(row, text)}><Pencil size={12} aria-hidden="true" /></IconButton>}
        {actions.onBranch && <IconButton label={m.branch_from_here()} className="h-6 w-6" onClick={() => actions.onBranch?.(row)}><GitBranch size={12} aria-hidden="true" /></IconButton>}
      </div>}
    </div>
  )
})

function reviewLabel(state: NonNullable<BackgroundLine['review_state']>): string {
  switch (state) {
    case 'waiting': return m.background_review_waiting()
    case 'reviewing': return m.background_review_reviewing()
    case 'reviewed': return m.background_review_reviewed()
    case 'failed': return m.background_review_failed()
    case 'unknown': return m.background_review_unknown()
  }
}

/** Older servers/caches can prove worker failure, but never successful parent review. */
function lineReviewState(line: BackgroundLine): NonNullable<BackgroundLine['review_state']> {
  return line.review_state ?? (line.status === 'failed' ? 'failed' : 'unknown')
}

function reviewDescription(line: BackgroundLine, parentReview: BackgroundLine['review_state']): string {
  return `${line.label}. ${reviewLabel(lineReviewState(line))}${parentReview && parentReview !== lineReviewState(line) ? ` ${m.background_review_parent({ state: reviewLabel(parentReview) })}` : ''}`
}

function BackgroundLineRow({ line, parentReview }: { line: BackgroundLine; parentReview: BackgroundLine['review_state'] }) {
  const description = reviewDescription(line, parentReview)
  return (
    <li className="flex items-center gap-2" aria-label={description} title={description}>
      <StatusIcon status={lineReviewState(line)} />
      <span className={cn('min-w-0 truncate', line.kind === 'agent' && 'text-text', line.kind === 'command' && 'font-mono')} title={line.label}>{line.label}</span>
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
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden" aria-label={update.lines.map((line) => reviewDescription(line, update.review_state)).join(', ')}>
          <ul className="flex flex-col gap-1">{update.lines.map((line, i) => <BackgroundLineRow key={i} line={line} parentReview={update.review_state} />)}</ul>
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

/**
 * TAL-305: a marker the server stamped `_marker_kind` (a compaction summary or a preserved task list), shown as a collapsed
 * card titled by its kind, never as anyone's message. The body opens from the title: `_marker_body` when sent, else `content`.
 */
export const MarkerRow = memo(function MarkerRow({ row }: { row: VisibleMessage }) {
  const { message } = row
  if (!message._marker_kind) return null
  const tasks = message._marker_kind === 'preserved_task_list'
  const Icon = tasks ? ListChecks : Shrink
  const text = message._marker_body ?? messageText(message.content)
  return (
    <div className="msg-row" data-role="marker" data-msg-idx={row.index} data-message-key={row.key}>
      <details className="marker-card rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted">
        <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
          <Icon size={14} aria-hidden="true" className="shrink-0" />
          <span className="font-medium text-text">{tasks ? m.marker_preserved_task_list() : m.marker_context_compaction()}</span>
        </summary>
        <div className="mt-2">
          <CollapsedBody excerpt={message._marker_body === undefined && message._display_truncated ? message._display_excerpt : undefined}>
            {(excerpt) => <div className="msg-body whitespace-pre-wrap">{excerpt ?? text}</div>}
          </CollapsedBody>
        </div>
      </details>
    </div>
  )
})

/** A server-classified notice, one quiet line in its place, never a reply. */
export const NoticeRow = memo(function NoticeRow({ row }: { row: VisibleMessage }) {
  const failed = row.message._notice_kind === 'failed_turn'
  const Icon = failed ? AlertTriangle : Info
  return (
    <div className="msg-row" data-role="notice" data-msg-idx={row.index} data-message-key={row.key}>
      <p role="note" className="flex items-center gap-2 text-[13px] text-muted">
        <Icon size={14} aria-hidden="true" className={cn("shrink-0", failed && "text-warning")} />
        <span className="min-w-0">{messageText(row.message.content)}</span>
      </p>
    </div>
  )
})

/**
 * TAL-816: a webhook or cron delivery the server stamped `_delivery` (the Agent mirrored it into a messaging chat), shown
 * as a notice titled by its source with the delivered text beneath, never as the user's own bubble.
 */
export const DeliveryRow = memo(function DeliveryRow({ row }: { row: VisibleMessage }) {
  const delivery = row.message._delivery
  if (!delivery) return null
  const Icon = delivery.kind === 'webhook' ? Webhook : CalendarClock
  const label = delivery.kind === 'webhook' ? m.delivery_webhook({ name: delivery.name }) : m.delivery_cron({ name: delivery.name })
  return (
    <div className="msg-row" data-role="delivery" data-msg-idx={row.index} data-message-key={row.key}>
      <section role="note" aria-label={label} className="rounded-md border border-border bg-surface px-3 py-2 text-[13px]">
        <p className="flex items-center gap-2 text-muted">
          <Icon size={14} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0">{label}</span>
          {row.message.timestamp ? <span className="msg-time ml-auto shrink-0">{formatDate(row.message.timestamp)}</span> : null}
        </p>
        <div className="mt-1">
          <CollapsedBody excerpt={row.message._display_truncated ? row.message._display_excerpt : undefined}>
            {(excerpt) => <div className="msg-body"><Markdown text={excerpt ?? delivery.body} /></div>}
          </CollapsedBody>
        </div>
      </section>
    </div>
  )
})

/** `continuation`: the live turn that continues this running scene (TAL-374). */
export const AssistantMessageRow = memo(function AssistantMessageRow({ row, name, mode, actions, tts, isLast, retainHeight = isLast, sessionId, scope, continuation }: { row: VisibleMessage; name: string; mode: ActivityMode; actions: RowActions; tts: boolean; isLast: boolean; retainHeight?: boolean; sessionId?: string | undefined; scope?: string | undefined; continuation?: LiveTurn | undefined }) {
  const activity = continuation ? continuedActivity(persistedActivity(row), continuation) : persistedActivity(row)
  const content = activityText(activity)
  const run = row.message as { _turnDuration?: number | null; _usedModel?: string | null }
  const meta = [typeof run._turnDuration === 'number' && run._turnDuration >= 0.5 ? `${run._turnDuration < 10 ? run._turnDuration.toFixed(1) : Math.round(run._turnDuration)}s` : null, run._usedModel || null].filter(Boolean).join(' · ')
  return (
    <div className="msg-row assistant-turn" data-role="assistant" data-msg-idx={row.index} data-message-key={row.key} data-latest={retainHeight ? '1' : undefined}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span>{row.message.badge && <span className="msg-badge">{row.message.badge}</span>}</div>
      <div className="assistant-turn-blocks">
        <TurnActivityView activity={activity} mode={mode} sessionId={sessionId} scope={scope} />
        {(row.assistantRows ?? [row]).map((part) => <AttachmentList key={part.key} message={part.message} sessionId={undefined} />)}
      </div>
      <div className={cn('msg-foot', isLast && 'msg-foot-latest')}>
        <MessageReactions row={row} actions={actions} />
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
