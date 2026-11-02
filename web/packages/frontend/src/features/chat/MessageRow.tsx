import type { MessageReactionView, TurnUsage } from '@maudecode/talaria-web-contracts'
import { Popover } from '@base-ui/react/popover'
import { ContextMenu, Menu, MenuItem } from '../../ui/Menu'
import { memo, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, ArrowUp, CalendarClock, ChevronRight, Copy, GitBranch, Info, ListChecks, Pencil, RotateCcw, SmilePlus, Shrink, Volume2, Webhook, type LucideIcon } from 'lucide-react'
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
import { usageDetailLines } from '../composer/chips'
import { useLocale } from '../../i18n/useLocale'
import { formatCompact } from '../../i18n/units'
import { landSent } from './sendMotion'

export interface RowActions {
  onQuoteSelection?: (text: string) => void
  onReact?: (row: VisibleMessage, action: MessageReactionView['actions'][number]) => void
  onEdit?: (row: VisibleMessage, text: string) => void
  onRegenerate?: (row: VisibleMessage) => void
  onBranch?: (row: VisibleMessage) => void
}

const copyText = (text: string) => { void navigator.clipboard.writeText(text).then(() => showToast(m.copied())) }

/** One message action. TAL-1154: the hover bar and the right-click and long-press menu render the same list. */
interface MessageAction { label: string; Icon: LucideIcon; run: () => void; className?: string }

function ActionButtons({ items }: { items: readonly MessageAction[] }) {
  return items.map(({ label, Icon, run, className }) => <IconButton key={label} label={label} className={cn('h-6 w-6', className)} onClick={run}><Icon size={12} aria-hidden="true" /></IconButton>)
}

/** `row` opens `items` on right-click and long-press; links, selections and code-block controls in it keep the browser's menu. */
function MessageMenu({ items, row }: { items: readonly MessageAction[]; row: ReactElement }) {
  if (!items.length) return row
  return <ContextMenu label={m.message_menu()} trigger={row}>{items.map(({ label, run }) => <MenuItem key={label} onClick={run}>{label}</MenuItem>)}</ContextMenu>
}

/** Extends the existing row footer and Menu; both message roles share these counts and actions. */
function MessageReactions({ row, actions }: { row: VisibleMessage; actions: RowActions }) {
  const view = row.message.reaction_view
  if (!view || (!view.state.items.length && !view.actions.length)) return null
  const label = (emoji: string, mine: boolean) => mine ? m.reaction_remove({ emoji }) : m.reaction_add({ emoji })
  return <span className="message-reactions inline-flex flex-wrap items-center gap-1" role="group" aria-label={m.message_reaction_group({ number: String(row.index + 1) })}>
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
  </span>
}

function AttachmentList({ message, sessionId }: { message: Message; sessionId: string | undefined }) {
  const [enlarged, setEnlarged] = useState<number | null>(null)
  const images: LightboxImage[] = []
  const items = (message.attachments ?? []).map((a, i) => {
    const name = a.filename ?? a.name ?? a.path?.split('/').pop() ?? `file-${i + 1}`
    const href = a.download_url ? appUrl(a.download_url).href : a.path && sessionId ? appUrl(rawFileUrl(sessionId, a.path)).href : undefined
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

export const UserMessageRow = memo(function UserMessageRow({ row, renderMarkdown, sessionId, actions, pending = false, arrive = false }: { row: VisibleMessage; renderMarkdown: boolean; sessionId: string | undefined; actions: RowActions; pending?: boolean; /** The user just sent it: it lands from below as it mounts (TAL-1753). */ arrive?: boolean }) {
  const text = messageText(row.message.content)
  // Decided at mount: the same row staying on screen as the stream takes it over never lands twice.
  const [lands] = useState(arrive)
  const rowRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (lands && rowRef.current) landSent(rowRef.current, text) }, [lands, text])
  const items: MessageAction[] = pending ? [] : [
    { label: m.copy(), Icon: Copy, run: () => copyText(text) },
    ...(actions.onEdit ? [{ label: m.edit_message(), Icon: Pencil, run: () => actions.onEdit?.(row, text) }] : []),
    ...(actions.onBranch ? [{ label: m.branch_from_here(), Icon: GitBranch, run: () => actions.onBranch?.(row) }] : []),
  ]
  return <MessageMenu items={items} row={
    <div ref={rowRef} className="msg-row" data-role="user" data-msg-idx={pending ? undefined : row.index} data-message-key={row.key} data-live-user={pending ? "1" : undefined} aria-busy={pending || undefined}>
      <AttachmentList message={row.message} sessionId={sessionId} />
      <CollapsedBody excerpt={row.message._display_truncated ? row.message._display_excerpt : undefined}>
        {(excerpt) => <div className="msg-body">{renderMarkdown ? <Markdown text={excerpt ?? text} /> : <div className="whitespace-pre-wrap">{excerpt ?? text}</div>}</div>}
      </CollapsedBody>
      {!pending && <div className="msg-foot">
        <MessageReactions row={row} actions={actions} />
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        <ActionButtons items={items} />
      </div>}
    </div>
  } />
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
            <IconButton label={m.copy()} className="h-6 w-6" onClick={() => copyText(text)}><Copy size={12} aria-hidden="true" /></IconButton>
          </div>
        </div>
      </details>
    </div>
  )
})

/**
 * TAL-305: a marker the server stamped `_marker_kind` (a compaction summary or a preserved task list), one quiet line in its
 * place like a notice, titled by its kind, never anyone's message. TAL-1566: no card. The body opens from the title:
 * `_marker_body` when sent, else `content`.
 */
export const MarkerRow = memo(function MarkerRow({ row }: { row: VisibleMessage }) {
  const { message } = row
  if (!message._marker_kind) return null
  const tasks = message._marker_kind === 'preserved_task_list'
  const Icon = tasks ? ListChecks : Shrink
  const text = message._marker_body ?? messageText(message.content)
  return (
    <div className="msg-row" data-role="marker" data-msg-idx={row.index} data-message-key={row.key}>
      <details className="marker-row group text-[13px] text-muted">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
          <Icon size={14} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0">{tasks ? m.marker_preserved_task_list() : m.marker_context_compaction()}</span>
          <ChevronRight size={14} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        </summary>
        <div className="mt-2 pl-[22px]">
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

/** TAL-1076: the reply's own in/out tokens, opening its cache and estimated-cost figures; every value is the server's. */
function TurnUsageMeta({ usage }: { usage: TurnUsage }) {
  const locale = useLocale()
  const figures = { input: formatCompact(locale, usage.input_tokens), output: formatCompact(locale, usage.output_tokens) }
  const details = usageDetailLines({ input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_tokens, cacheWrite: usage.cache_write_tokens, cacheHitPercent: usage.cache_hit_percent, cost: usage.estimated_cost })
  return (
    <Popover.Root>
      <Popover.Trigger className="msg-turn-usage rounded-sm font-mono text-[11px] tabular-nums text-muted opacity-75 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-(--focus-ring)" aria-label={m.turn_usage_label(figures)}>{m.turn_usage_summary(figures)}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-[1500]">
          <Popover.Popup aria-label={m.turn_usage_label(figures)} className="flex max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-0.5 rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text shadow-md outline-none">
            {details.map((d) => <span key={d} className="tabular-nums text-muted">{d}</span>)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** `continuation`: the live turn that continues this running scene (TAL-374). `tokenUsage`: the `show_token_usage` setting. */
export const AssistantMessageRow = memo(function AssistantMessageRow({ row, name, mode, actions, tts, tokenUsage = false, isLast, retainHeight = isLast, sessionId, scope, continuation }: { row: VisibleMessage; name: string; mode: ActivityMode; actions: RowActions; tts: boolean; tokenUsage?: boolean; isLast: boolean; retainHeight?: boolean; sessionId?: string | undefined; scope?: string | undefined; continuation?: LiveTurn | undefined }) {
  const activity = continuation ? continuedActivity(persistedActivity(row), continuation) : persistedActivity(row)
  const content = activityText(activity)
  const parts = row.assistantRows ?? [row]
  const run = row.message as { _turnDuration?: number | null; _usedModel?: string | null }
  const meta = [typeof run._turnDuration === 'number' && run._turnDuration >= 0.5 ? `${run._turnDuration < 10 ? run._turnDuration.toFixed(1) : Math.round(run._turnDuration)}s` : null, run._usedModel || null].filter(Boolean).join(' · ')
  const ref = useRef<HTMLDivElement>(null)
  const jumpToQuestion = () => {
    let prev = ref.current?.previousElementSibling
    while (prev && !(prev instanceof HTMLElement && prev.dataset.role === 'user')) prev = prev.previousElementSibling
    prev?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const items: MessageAction[] = [
    { label: m.copy(), Icon: Copy, run: () => copyText(content) },
    ...(tts && content.trim() ? [{ label: m.speak_message(), Icon: Volume2, run: () => { void speak(content) } }] : []),
    ...(actions.onRegenerate && isLast ? [{ label: m.regenerate_response(), Icon: RotateCcw, run: () => actions.onRegenerate?.(row) }] : []),
    { label: m.jump_to_question_label(), Icon: ArrowUp, run: jumpToQuestion, className: 'msg-question-jump-btn' },
  ]
  return <MessageMenu items={items} row={
    <div ref={ref} className="msg-row assistant-turn" data-role="assistant" data-member-author={row.author === undefined ? undefined : '1'} data-msg-idx={row.index} data-message-key={row.key} data-latest={retainHeight ? '1' : undefined}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span>{row.message.badge && <span className="msg-badge">{row.message.badge}</span>}</div>
      <div className="assistant-turn-blocks">
        <TurnActivityView activity={activity} mode={mode} sessionId={sessionId} scope={scope} />
        {parts.map((part) => <AttachmentList key={part.key} message={part.message} sessionId={undefined} />)}
      </div>
      <div className={cn('msg-foot', isLast && 'msg-foot-latest')}>
        {parts.map((part) => <MessageReactions key={part.key} row={part} actions={actions} />)}
        {row.message.timestamp ? <span className="msg-time">{formatDate(row.message.timestamp)}</span> : null}
        {meta && <span className="msg-run-meta font-mono text-[11px] tabular-nums text-muted opacity-75">{meta}</span>}
        {tokenUsage && row.message._turnUsage && <TurnUsageMeta usage={row.message._turnUsage} />}
        <span className="ml-auto" aria-hidden="true" />
        <ActionButtons items={items} />
      </div>
    </div>
  } />
})
