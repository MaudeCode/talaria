import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import type { LiveTurn } from '../../stream/reducer'
import { isTerminal } from '../../stream/reducer'
import { AssistantMessageRow, UserMessageRow, type RowActions } from './MessageRow'
import { LiveStatusPill, LiveTurnView } from './LiveTurnView'
import { messageKey, type VisibleMessage } from './useTranscript'
import { WorklogDisclosureProvider, type ActivityMode } from './blocks/Worklog'
import { groupAssistantTurns } from './turnActivity'
import { cn } from '../../ui/cn'
import { Button } from '../../ui/Button'

const VIRTUALIZE_AT = 200

export interface TranscriptProps {
  rows: VisibleMessage[]
  disclosureScope?: string
  live: LiveTurn | null
  assistantName: string
  mode: ActivityMode
  renderUserMarkdown: boolean
  autoFollow: boolean
  sessionId: string | undefined
  /** `?msg=<key>` deep link: entry lands on this row instead of the bottom. */
  focusKey?: string | undefined
  actions: RowActions
  tts: boolean
  truncated: boolean
  onLoadOlder: () => void
  loadingOlder: boolean
  emptyState: React.ReactNode
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
  const { rows: rawRows, live, assistantName, mode, renderUserMarkdown, autoFollow, sessionId, focusKey, actions, tts, truncated, onLoadOlder, loadingOlder, emptyState, showJumpButtons, virtualizeLongTranscripts } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [atTop, setAtTop] = useState(true)
  // The live turn gives way to the server's scene as soon as a terminal frame brings the settled session.
  const showLive = !!live && (!isTerminal(live.status) || live.doneSession === null)
  const grouped = useMemo(() => groupAssistantTurns(rawRows), [rawRows])
  const rows = useMemo(() => {
    // A live turn attached without replay cannot restore the rows the server already persisted, so it leaves them visible.
    if (!showLive || !live?.claimsPersistedRows) return grouped
    // The live turn owns rows the server already stamped with its turn id.
    return grouped.filter((row) => row.message.role !== 'assistant' || (row.turnKey !== live.streamId && row.turnKey !== live.turnId))
  }, [grouped, live, showLive])
  const lastRowIsUser = rows.length > 0 && rows[rows.length - 1]?.message.role === 'user'
  const showLiveUser = !!live && !isTerminal(live.status) && live.userText.trim() !== '' && !lastRowIsUser && !rows.some((r) => r.message.role === 'user' && messageKey(r.message) === live.userMessageId)
  const liveUserText = live?.userText ?? ''
  const lastAssistantIndex = useMemo(() => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.message.role === 'assistant') return i; return -1 }, [rows])
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

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    // While following, only the reader moving up leaves the bottom; layout that lands between a jump and its scroll event does not.
    if (distance < 80) pin(true)
    else if (!followsRef.current() || el.scrollTop < lastTopRef.current) { pin(false); settlingRef.current = false }
    lastTopRef.current = el.scrollTop
    setAtTop(el.scrollTop < 40)
    if (el.scrollTop < 40 && truncated && !loadingOlder) onLoadOlder()
  }, [pin, truncated, loadingOlder, onLoadOlder])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    pin(true)
  }, [pin])

  // Follow while pinned: track every size change of the content (each streamed line, each
  // folding disclosure) and of the pane itself before paint, instead of catching up in jumps.
  const innerRef = useRef<HTMLDivElement>(null)
  const empty = rows.length === 0 && !showLive && !showLiveUser
  // The disclosure provider below is keyed by this scope, so a new session brings a new pane to observe.
  const scope = props.disclosureScope ?? sessionId
  useLayoutEffect(() => {
    const inner = innerRef.current
    const pane = scrollRef.current
    if (!inner || !pane) return
    const follow = () => { if (followsRef.current()) scrollToBottom(false) }
    follow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(follow)
    observer.observe(inner)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [empty, scope, scrollToBottom])

  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.message.role === 'user' ? 96 : 220),
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  })

  // Entry is keyed by the session scope (and a `?msg=` link), never by row keys: sessions can share them, and older rows change the first.
  const entryRef = useRef<{ focus: string | undefined; pagedAt?: number } | null>(null)
  useLayoutEffect(() => { entryRef.current = { focus: focusKey }; settlingRef.current = true; lastTopRef.current = 0; pin(true) }, [scope, focusKey, pin])
  useLayoutEffect(() => {
    const entry = entryRef.current
    if (!entry || rows.length === 0) return
    // A grouped turn is keyed by its first assistant message but answers for every message it holds.
    const index = entry.focus ? rows.findIndex((row) => row.key === entry.focus || !!row.assistantRows?.some((part) => part.key === entry.focus)) : -1
    // A linked message older than the loaded window pages older rows in until it appears; a failed page falls back to the bottom.
    if (index < 0 && entry.focus && truncated && (entry.pagedAt !== rows.length || loadingOlder)) {
      if (entry.pagedAt !== rows.length && !loadingOlder) { entry.pagedAt = rows.length; onLoadOlder() }
      return
    }
    entryRef.current = null
    const target = index < 0 || virtualize ? null : scrollRef.current?.querySelector(`[data-message-key="${CSS.escape(rows[index]?.key ?? '')}"]`)
    if (index < 0 || (!virtualize && !target)) { scrollToBottom(false); return }
    pin(false)
    settlingRef.current = false
    if (target) target.scrollIntoView({ block: 'center' })
    else virtualizer.scrollToIndex(index, { align: 'center' })
  }, [rows, virtualize, virtualizer, truncated, loadingOlder, onLoadOlder, pin, scrollToBottom])

  const renderRow = (row: VisibleMessage, i: number) => (
    row.message.role === 'user'
      ? <UserMessageRow key={row.key} row={row} renderMarkdown={renderUserMarkdown} sessionId={sessionId} actions={actions} />
      : <AssistantMessageRow sessionId={sessionId} scope={props.disclosureScope} key={row.key} row={row} name={assistantName} mode={mode} actions={actions} tts={tts} isLast={i === lastAssistantIndex && !showLive} />
  )

  return (
    <WorklogDisclosureProvider key={scope} scope={scope ?? ""}>
    <div className="messages-shell relative flex flex-1 min-h-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className={cn('messages relative z-0 flex flex-1 flex-col min-h-0 px-5 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch] touch-pan-y overscroll-y-contain [overflow-anchor:auto] [@media(hover:hover)_and_(pointer:fine)]:[overflow-anchor:none] max-[641px]:pl-[max(10px,env(safe-area-inset-left,0))] max-[641px]:pr-[max(10px,env(safe-area-inset-right,0))]', empty && 'messages-empty')} id="messages" role="log" aria-live="off" aria-relevant="additions">
        {empty ? emptyState : (
          <div ref={innerRef} className="messages-inner mx-auto w-full flex flex-col max-w-(--msg-max) pt-5 pb-12 max-[641px]:pt-3 max-[641px]:pb-11 max-[641px]:max-w-full max-[641px]:overflow-x-clip max-[641px]:[word-break:break-word] max-[641px]:min-w-0" id="msgInner">
            {truncated && (
              <div className="flex justify-center py-2">
                <Button variant="ghost" onClick={onLoadOlder} disabled={loadingOlder}>{loadingOlder ? m.loading() : m.load_older()}</Button>
              </div>
            )}
            {virtualize ? (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
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
            ) : rows.map((row, i) => renderRow(row, i))}
            {showLiveUser && (
              <div className="msg-row" data-role="user" data-live-user="1">
                <div className="msg-body whitespace-pre-wrap break-words">{liveUserText}</div>
              </div>
            )}
            {showLive && live && <LiveTurnView turn={live} name={assistantName} mode={mode} userVisible />}
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
      {showLive && live && !isTerminal(live.status) && <LiveStatusPill turn={live} />}
    </div>
    </WorklogDisclosureProvider>
  )
}
