import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { Attachment } from '../../contracts'
import { m } from '../../paraglide/messages.js'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import { AssistantMessageRow, BackgroundUpdateRow, DeliveryRow, MarkerRow, NoticeRow, UserMessageRow, type RowActions } from './MessageRow'
import { LiveTurnView } from './LiveTurnView'
import { messageKey, type VisibleMessage } from './useTranscript'
import { WorklogDisclosureProvider, type ActivityMode } from './blocks/Worklog'
import { groupAssistantTurns, isReplyRow, persistedActivity, toolIdsOf } from './turnActivity'
import { cn } from '../../ui/cn'
import { Button } from '../../ui/Button'
import { LoadingState } from '../../ui/States'
import { onScrollRequest, requestComposerRest } from './sendMotion'
import { QuoteSelection } from './QuoteSelection'
import { useAutoRead } from './useAutoRead'
import { useLiveTurn } from '../../stream/store'

const VIRTUALIZE_AT = 200
const NO_ACTIONS: RowActions = {}
const NO_ATTACHMENTS: Attachment[] = []
/** How long after a wheel or touch move a scroll still counts as the reader's own. */
const HAND_SCROLL_MS = 250

export interface TranscriptProps {
  rows: VisibleMessage[]
  disclosureScope?: string
  live: LiveTurn | null
  /** The connected chat owns its text subscription here; controlled transcript views pass `live` alone. */
  subscribeToStream?: boolean
  assistantName: string
  mode: ActivityMode
  renderUserMarkdown: boolean
  autoFollow: boolean
  sessionId: string | undefined
  /** `?msg=<key>` deep link: entry lands on this row instead of the bottom. */
  focusKey?: string | undefined
  actions: RowActions
  tts: boolean
  /** `tts_auto_read` setting: speak each reply this view watched finish. */
  autoRead?: boolean
  truncated: boolean
  /** Absolute index of the oldest loaded message; it drops with every older page, visible rows or not. */
  loadedFrom: number
  onLoadOlder: (retry?: boolean, beforePrepend?: () => void) => void
  loadingOlder: boolean
  olderError?: boolean
  emptyState: React.ReactNode
  /** Local submitted intent, shown through the existing user renderer until the server identifies its row. */
  pendingUserText?: string | undefined
  pendingAttachments?: Attachment[] | undefined
  pendingPreviousStreamId?: string | undefined
  showJumpButtons: boolean
  /** `virtualize_transcript` setting; off by default because variable-height rows made long chats oscillate. */
  virtualizeLongTranscripts: boolean
}

/**
 * The transcript pane. Settled rows come from the session payload; the live
 * turn renders at the tail. A live user row is shown while the server has not
 * yet persisted the pending user message. Lists over VIRTUALIZE_AT rows are
 * virtualized with TanStack Virtual.
 */
export function Transcript(props: TranscriptProps) {
  const { rows: rawRows, assistantName, mode, renderUserMarkdown, autoFollow, sessionId, focusKey, actions, tts, truncated, loadedFrom, onLoadOlder, loadingOlder, olderError = false, emptyState, pendingUserText, showJumpButtons, virtualizeLongTranscripts } = props
  const subscribedLive = useLiveTurn(props.subscribeToStream ? sessionId ?? null : null)
  const live = props.subscribeToStream ? subscribedLive : props.live
  const scrollRef = useRef<HTMLDivElement>(null)
  const prependRef = useRef<{ from: number; anchors: { key: string; top: number; height: number }[]; height: number; offset: number } | null>(null)
  const [pinned, setPinned] = useState(true)
  const [atTop, setAtTop] = useState(true)
  // The live turn gives way to the server's scene as soon as a terminal frame brings the settled session.
  const showLive = !!live && (!isTerminal(live.status) || live.doneSession === null)
  const grouped = useMemo(() => groupAssistantTurns(rawRows), [rawRows])
  const streamId = live?.streamId, turnId = live?.turnId, claimsPersistedRows = live?.claimsPersistedRows, userMessageId = live?.userMessageId
  const { rows, hasLiveUser, hasPersistedPending } = useMemo(() => {
    // A live turn attached without replay cannot restore the rows the server already persisted, so it leaves them visible.
    // The live turn owns rows the server already stamped with its turn id.
    const rows = showLive && claimsPersistedRows ? grouped.filter((row) => row.message.role !== 'assistant' || (row.turnKey !== streamId && row.turnKey !== turnId)) : grouped
    return {
      rows,
      hasLiveUser: rows.some((row) => row.message.role === 'user' && messageKey(row.message) === userMessageId),
      hasPersistedPending: streamId !== undefined && rows.some((row) => row.message.role === 'user' && ((userMessageId !== null && messageKey(row.message) === userMessageId) || row.message._turn_id === streamId || (turnId !== null && row.message._turn_id === turnId))),
    }
  }, [grouped, showLive, claimsPersistedRows, streamId, turnId, userMessageId])
  // A live turn attached without replay continues the running scene the server shipped for its persisted rows (TAL-374).
  const continued = useMemo(() => (showLive && streamId !== undefined && !claimsPersistedRows ? rows.find((row) => isReplyRow(row.message) && (row.turnKey === streamId || row.turnKey === turnId)) : undefined), [rows, streamId, turnId, claimsPersistedRows, showLive])
  const continuedTools = useMemo(() => (continued ? toolIdsOf(persistedActivity(continued)) : undefined), [continued])
  const lastRowIsUser = rows.length > 0 && rows[rows.length - 1]?.message.role === 'user' && !rows[rows.length - 1]?.message._marker_kind && !rows[rows.length - 1]?.message._delivery
  const showLiveUser = !!live && !isTerminal(live.status) && (live.userText.trim() !== '' || live.userAttachments.length > 0) && (live.userMessageId !== null || !lastRowIsUser) && !hasLiveUser
  // The submitted occurrence uses one slot until the server's identified row takes over.
  // Reconcile a newly observed turn by server identity, including a terminal snapshot that beats the POST response.
  const persistedPending = !!live && live.streamId !== props.pendingPreviousStreamId && hasPersistedPending
  const pending = pendingUserText !== undefined && !persistedPending
  const liveUserText = pending ? pendingUserText : showLiveUser ? (live?.userText ?? '') : ''
  // Built once per text and attachments, so a streamed token frame leaves the user's bubble unrendered.
  const liveUserAttachments = pending ? props.pendingAttachments ?? NO_ATTACHMENTS : live?.userAttachments ?? NO_ATTACHMENTS
  const liveUserRow = useMemo<VisibleMessage>(() => ({ index: -1, key: 'pending-user', message: { role: 'user', content: liveUserText, attachments: liveUserAttachments } }), [liveUserText, liveUserAttachments])
  useAutoRead(props.autoRead === true, rows, live, !showLive)
  const lastAssistantIndex = useMemo(() => rows.findLastIndex((row) => isReplyRow(row.message)), [rows])
  const virtualize = virtualizeLongTranscripts && rows.length > VIRTUALIZE_AT

  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  const pin = useCallback((next: boolean) => { pinnedRef.current = next; setPinned(next) }, [])
  // Entering a session settles at its bottom as its rows and layout arrive, even with auto-follow off,
  // until the reader scrolls up or a turn streams (auto-follow alone governs streamed content).
  const settlingRef = useRef(false)
  const streaming = showLive && !!live && !isTerminal(live.status)
  const followsRef = useRef((): boolean => false)
  followsRef.current = () => pinnedRef.current && (autoFollow || (settlingRef.current && !streaming))
  useEffect(() => { if (streaming) settlingRef.current = false }, [streaming])
  const lastTopRef = useRef(0)

  const readerAnchor = useRef<{ key: string; top: number } | null>(null)
  const anchorFrame = useRef<number | null>(null)
  const rememberReaderAnchor = useCallback(() => {
    // Following owns the scroll position; a reader anchor is only used away from the bottom.
    if (followsRef.current()) { readerAnchor.current = null; return }
    if (anchorFrame.current !== null) return
    anchorFrame.current = requestAnimationFrame(() => {
      anchorFrame.current = null
      if (followsRef.current()) return
      const pane = scrollRef.current
      if (!pane) return
      const bounds = pane.getBoundingClientRect()
      readerAnchor.current = null
      // Rows are in visual order; leave later contained history unmeasured once the anchor is known.
      for (const row of pane.querySelectorAll<HTMLElement>('[data-message-key]')) {
        const rect = row.getBoundingClientRect()
        if (rect.top >= bounds.bottom) break
        if (rect.bottom <= bounds.top) continue
        const key = row.dataset.messageKey
        if (!key) continue
        if (!readerAnchor.current || rect.top >= bounds.top) readerAnchor.current = { key, top: rect.top - bounds.top }
        if (rect.top >= bounds.top) break
      }
    })
  }, [])

  useLayoutEffect(() => () => {
    if (anchorFrame.current !== null) cancelAnimationFrame(anchorFrame.current)
    anchorFrame.current = null
  }, [props.disclosureScope, sessionId, focusKey])

  // A hand scroll (wheel or touch) that moves the transcript asks the composer to rest; a gesture against an edge
  // moves nothing, and programmatic follow and entry jumps record their own position, so neither does.
  const handAtRef = useRef(-Infinity)
  const onReaderInput = useCallback(() => { prependRef.current = null; readerAnchor.current = null }, [])
  const onReaderScroll = useCallback(() => { onReaderInput(); handAtRef.current = performance.now() }, [onReaderInput])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    // Clamped, so rubber-band overscroll past either edge reads as no movement.
    const clamp = (top: number) => Math.min(Math.max(top, 0), max)
    if (performance.now() - handAtRef.current < HAND_SCROLL_MS && clamp(el.scrollTop) !== clamp(lastTopRef.current)) requestComposerRest()
    // While following, only the reader moving up leaves the bottom; layout that lands between a jump and its scroll event does not.
    if (distance < 80) pin(true)
    else if (!followsRef.current() || el.scrollTop < lastTopRef.current) { pin(false); settlingRef.current = false }
    // A scroll invalidates the previous viewport anchor immediately, before a resize can restore it.
    if (lastTopRef.current !== el.scrollTop) readerAnchor.current = null
    lastTopRef.current = el.scrollTop
    rememberReaderAnchor()
    setAtTop(el.scrollTop < 40)
  }, [pin, rememberReaderAnchor])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    // Record our own jump now: a reader scroll merged into the same scroll event must still read as upward.
    if (!smooth) lastTopRef.current = el.scrollTop
    readerAnchor.current = null
    pin(true)
  }, [pin])

  // Follow while pinned: track every size change of the content (each streamed line, each
  // folding disclosure) and of the pane itself before paint, instead of catching up in jumps.
  const innerRef = useRef<HTMLDivElement>(null)
  const empty = rows.length === 0 && !showLive && !pending && !liveUserText
  // The disclosure provider below is keyed by this scope, so a new session brings a new pane to observe.
  const scope = props.disclosureScope ?? sessionId
  useLayoutEffect(() => {
    const inner = innerRef.current
    const pane = scrollRef.current
    if (!inner || !pane) return
    const follow = (fromMutation = false) => {
      // Settling entry must follow lazy content synchronously; steady streaming can wait for resize.
      if (fromMutation && !settlingRef.current && followsRef.current() && performance.now() - handAtRef.current >= HAND_SCROLL_MS) return
      // A reader scroll can precede its browser event; reconcile it before following a DOM mutation.
      if (pane.scrollTop !== lastTopRef.current) onScroll()
      if (followsRef.current()) scrollToBottom(false)
      else if (!virtualize && readerAnchor.current) {
        const anchor = readerAnchor.current
        const row = pane.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(anchor.key)}"]`)
        if (row) {
          pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.top
          lastTopRef.current = pane.scrollTop
        }
      }
      rememberReaderAnchor()
    }
    follow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => follow())
    observer.observe(inner)
    observer.observe(pane)
    // Suspense can move a reader's anchor without changing the total content height.
    const mutations = new MutationObserver(() => follow(true))
    mutations.observe(inner, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); mutations.disconnect() }
  }, [empty, scope, scrollToBottom, virtualize, rememberReaderAnchor, onScroll])

  // A submit returns to the end wherever the reader was, and the next layout follows it there (T3 Code's scrollToEnd).
  useEffect(() => onScrollRequest('end', () => { settlingRef.current = true; scrollToBottom(false) }), [scrollToBottom])
  // The composer grew (a tab row, the resting card lifting): a reader at the end stays there, whatever auto-follow
  // says, because this is the composer covering the end rather than new content arriving.
  useEffect(() => onScrollRequest('follow', () => { if (pinnedRef.current) scrollToBottom(false) }), [scrollToBottom])

  const virtualizer = useVirtualizer({
    enabled: virtualize,
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const row = rows[i]
      // Keep a rekeyed turn near the viewport until its new contents can be measured.
      const previous = prependRef.current?.anchors.find((anchor) => row?.key !== anchor.key && row?.assistantRows?.some((part) => part.key === anchor.key))
      return previous?.height ?? (row?.message.role === 'user' ? 96 : 220)
    },
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  })
  // While following, the follow above owns the scroll position. The virtualizer's own compensation for a row measured
  // above the fold moves the pane up before the list's height catches up, which reads as the reader leaving the end
  // (a fresh transcript measures many rows at once). Elsewhere (reading up, a deep link) its default keeps rows still.
  useLayoutEffect(() => {
    Object.defineProperty(virtualizer, 'shouldAdjustScrollPositionOnItemSizeChange', { configurable: true, get: () => (followsRef.current() ? () => false : undefined) })
  }, [virtualizer])

  // Entry is keyed by the session scope (and a `?msg=` link), never by row keys: sessions can share them, and older rows change the first.
  const entryRef = useRef<{ focus: string | undefined; pagedAt?: number } | null>(null)
  const requestOlder = useCallback((retry = false) => {
    const pane = scrollRef.current
    if (!pane || loadingOlder || (olderError && !retry)) return
    if (!entryRef.current) { pin(false); settlingRef.current = false }
    // Capture at response time: the reader can keep scrolling while the page is in flight.
    onLoadOlder(retry, () => {
      prependRef.current = null
      if (entryRef.current) return
      const top = pane.getBoundingClientRect().top
      const elements = [...pane.querySelectorAll<HTMLElement>('[data-message-key]')]
      const first = elements.findIndex((row) => row.getBoundingClientRect().bottom > top)
      // The following row stays keyed when the first visible assistant turn absorbs an older part.
      const anchors = first < 0 ? [] : elements.slice(first, first + 2).flatMap((row) => {
        const key = row.dataset.messageKey
        if (!key) return []
        const bounds = row.getBoundingClientRect()
        return [{ key, top: bounds.top - top, height: bounds.height }]
      })
      if (anchors.length) prependRef.current = { from: loadedFrom, anchors, height: pane.scrollHeight, offset: pane.scrollTop }
    })
  }, [loadedFrom, loadingOlder, olderError, onLoadOlder, pin])
  useLayoutEffect(() => {
    const saved = prependRef.current
    const pane = scrollRef.current
    if (!saved || !pane || loadedFrom >= saved.from) return
    let frame = 0
    let passes = 0
    // A merged turn gets a new key and has no remembered intrinsic height yet.
    // Measure it while restoring the reader, then return it to off-screen containment.
    const revealed = virtualize ? [] : rows.flatMap((row) => {
      if (!saved.anchors.some((anchor) => row.key !== anchor.key && row.assistantRows?.some((part) => part.key === anchor.key))) return []
      const element = pane.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(row.key)}"]`)
      return element ? [element] : []
    })
    for (const element of revealed) element.style.contentVisibility = 'visible'
    const release = () => { for (const element of revealed) element.style.removeProperty('content-visibility') }
    // A prepend can enable virtualization; its new rows measure over several frames.
    const restore = () => {
      if (prependRef.current !== saved) { release(); return }
      let offset = saved.offset + pane.scrollHeight - saved.height
      for (const candidate of saved.anchors) {
        const anchor = pane.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(candidate.key)}"]`)
        if (anchor) {
          offset = pane.scrollTop + anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - candidate.top
          break
        }
        if (virtualize) {
          const index = rows.findIndex((row) => row.key === candidate.key)
          const item = virtualizer.measurementsCache[index]
          const list = pane.querySelector<HTMLElement>('[data-virtual-history]')
          if (item && list) { offset = item.start + list.offsetTop - candidate.top; break }
        }
      }
      if (virtualize) virtualizer.scrollToOffset(offset)
      else pane.scrollTop = offset
      lastTopRef.current = pane.scrollTop
      if (++passes < 12) frame = requestAnimationFrame(restore)
      else { prependRef.current = null; release() }
    }
    restore()
    return () => { cancelAnimationFrame(frame); release() }
  }, [loadedFrom, rows, virtualize, virtualizer])
  useLayoutEffect(() => { prependRef.current = null; readerAnchor.current = null; entryRef.current = { focus: focusKey }; settlingRef.current = true; lastTopRef.current = 0; pin(true) }, [scope, focusKey, pin])
  useLayoutEffect(() => {
    const entry = entryRef.current
    if (!entry || rows.length === 0) return
    // A grouped turn is keyed by its first assistant message but answers for every message it holds.
    const index = entry.focus ? rows.findIndex((row) => row.key === entry.focus || !!row.assistantRows?.some((part) => part.key === entry.focus)) : -1
    // A linked message pages until it appears; an error keeps its target for explicit retry.
    // Progress follows the loaded offset: a page can join an existing grouped row or hold no visible rows at all.
    if (index < 0 && entry.focus && truncated && !olderError && (entry.pagedAt !== loadedFrom || loadingOlder)) {
      if (entry.pagedAt !== loadedFrom && !loadingOlder) { entry.pagedAt = loadedFrom; requestOlder() }
      return
    }
    if (index < 0 && entry.focus && olderError) return
    entryRef.current = null
    readerAnchor.current = null
    const target = index < 0 || virtualize ? null : scrollRef.current?.querySelector(`[data-message-key="${CSS.escape(rows[index]?.key ?? '')}"]`)
    if (index < 0 || (!virtualize && !target)) { scrollToBottom(false); return }
    pin(false)
    settlingRef.current = false
    if (target) {
      target.scrollIntoView({ block: 'center' })
      lastTopRef.current = scrollRef.current?.scrollTop ?? 0
      rememberReaderAnchor()
    } else virtualizer.scrollToIndex(index, { align: 'center' })
  }, [rows, loadedFrom, virtualize, virtualizer, truncated, loadingOlder, olderError, requestOlder, pin, scrollToBottom, rememberReaderAnchor])

  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const pane = scrollRef.current
    const sentinel = sentinelRef.current
    if (!pane || !sentinel || !truncated || loadingOlder || olderError || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestOlder()
    }, { root: pane, rootMargin: `${pane.clientHeight}px 0px 0px 0px` })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [scope, truncated, loadingOlder, olderError, requestOlder])

  const continuedTurn = continued ? live ?? undefined : undefined
  const renderRow = useCallback((row: VisibleMessage, i: number) => (
    row.message._background_update
      ? <BackgroundUpdateRow key={row.key} row={row} />
      : row.message._marker_kind
      ? <MarkerRow key={row.key} row={row} />
      : row.message._notice_kind
      ? <NoticeRow key={row.key} row={row} />
      : row.message._delivery
      ? <DeliveryRow key={row.key} row={row} />
      : row.message.role === 'user'
      ? <UserMessageRow key={row.key} row={row} renderMarkdown={renderUserMarkdown} sessionId={sessionId} actions={actions} />
      : <AssistantMessageRow sessionId={sessionId} scope={props.disclosureScope} key={row.key} row={row} name={assistantName} mode={mode} actions={actions} tts={tts} isLast={i === lastAssistantIndex && !showLive} retainHeight={i === lastAssistantIndex} continuation={row === continued ? continuedTurn : undefined} />
  ), [renderUserMarkdown, sessionId, actions, props.disclosureScope, assistantName, mode, tts, lastAssistantIndex, showLive, continued, continuedTurn])
  // Reuse mounted history; the opt-in virtualizer still creates only its visible window.
  const renderedRows = useMemo(() => virtualize ? null : rows.map(renderRow), [virtualize, rows, renderRow])

  return (
    <WorklogDisclosureProvider key={scope} scope={scope ?? ""}>
    <div className="messages-shell relative flex flex-1 min-h-0 flex-col">
      {sessionId && actions.onQuoteSelection && <QuoteSelection key={`${scope ?? ''}:${sessionId}`} transcript={scrollRef} onQuote={actions.onQuoteSelection} />}
      <div ref={scrollRef} onScroll={onScroll} onWheel={(e) => { if (e.deltaY !== 0) onReaderScroll() }} onTouchMove={onReaderScroll} onPointerDown={onReaderInput} onKeyDown={onReaderInput} className={cn('messages relative z-0 flex flex-1 flex-col min-h-0 px-5 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch] touch-pan-y overscroll-y-contain [overflow-anchor:none] max-[641px]:pl-[max(10px,env(safe-area-inset-left,0))] max-[641px]:pr-[max(10px,env(safe-area-inset-right,0))]', empty && 'messages-empty')} id="messages" role="log" aria-live="off" aria-relevant="additions">
        {empty ? emptyState : (
          <div ref={innerRef} className="messages-inner mx-auto w-full max-w-(--msg-max) pt-5 pb-[calc(var(--composer-h,0px)+2rem)] max-[641px]:pt-3 max-[641px]:max-w-full max-[641px]:overflow-x-clip max-[641px]:[word-break:break-word] max-[641px]:min-w-0" id="msgInner">
            {truncated && (
              <div ref={sentinelRef} className="flex h-11 shrink-0 items-center justify-center" data-history-sentinel>
                {loadingOlder ? <LoadingState compact /> : olderError ? <div role="alert" className="flex items-center gap-2 text-sm text-muted">{m.error_generic()}<Button variant="ghost" className="min-h-11" onClick={() => requestOlder(true)}>{m.retry()}</Button></div> : null}
              </div>
            )}
            {virtualize ? (
              <div data-virtual-history style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((v) => {
                  const row = rows[v.index]
                  if (!row) return null
                  return (
                    <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}>
                      {renderRow(row, v.index)}
                    </div>
                  )
                })}
              </div>
            ) : <div className="messages-inner messages-history">{renderedRows}</div>}
            {(pending || showLiveUser) && <UserMessageRow row={liveUserRow} renderMarkdown={renderUserMarkdown} sessionId={sessionId} actions={NO_ACTIONS} pending />}
            {showLive && live && <LiveTurnView turn={live} name={assistantName} mode={mode} userVisible omitToolIds={continuedTools} />}
            {/* The settled error row carries the message; only the frame's continuation link lives outside the session. */}
            {!showLive && live?.error?.continuationSessionId && <Link to="/session/$sessionId" params={{ sessionId: live.error.continuationSessionId }} className="mt-1 inline-block text-[13px] text-accent-text underline">{m.live_continuation()}</Link>}
          </div>
        )}
      </div>
      {showJumpButtons && !atTop && rows.length > 3 && (
        <button type="button" className="session-jump-btn session-jump-btn--start" onClick={() => scrollRef.current?.scrollTo({ top: 0 })} aria-label={m.jump_to_start()}>
          <ArrowUp size={12} aria-hidden="true" /> <span className="max-[640px]:hidden">{m.jump_to_start()}</span>
        </button>
      )}
      {!pinned && !empty && (
        <button type="button" className="scroll-to-bottom-btn" onClick={() => scrollToBottom(true)} aria-label={m.scroll_to_bottom()}>
          <ArrowDown size={12} aria-hidden="true" /> <span className="max-[640px]:hidden">{m.scroll_to_bottom()}</span>
        </button>
      )}
    </div>
    </WorklogDisclosureProvider>
  )
}
