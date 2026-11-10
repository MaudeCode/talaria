/**
 * TAL-2152: the conversation outline, a jump list of the chat's questions. From 900px it is a column at the transcript's
 * right edge; below, a symbol button beside the jump buttons opens the same list in a menu.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { List } from 'lucide-react'
import type { SessionOutlineEntry } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import type { LiveTurn } from '../../stream/reducer'
import { Menu, MenuChoiceItem, MenuRadioGroup } from '../../ui/Menu'
import { SECTION_HEADER } from '../../ui/List'
import { cn } from '../../ui/cn'
import { firstRowPast, rowBoxes } from './viewportAnchor'

/** The outline shows from this many questions. */
export const OUTLINE_MIN_ENTRIES = 4

/** `read`: when the outline read this entry came after was taken; a later read answers for it. */
interface Sent { stream: string; read: number; entry: SessionOutlineEntry }

/**
 * The server's outline, then each question sent here after that read, from the stream state: the user's own write, shown
 * until a later read answers for it. Only `revision` (a compaction or rename) reads the outline again.
 */
export function useOutline(sessionId: string, revision: string, live: LiveTurn | null): SessionOutlineEntry[] | undefined {
  const query = useQuery({
    queryKey: keys.sessionOutline(sessionId, revision),
    queryFn: ({ signal }) => api.fetchSessionOutline(sessionId, signal),
    staleTime: Infinity, refetchOnWindowFocus: false, retry: 1,
  })
  const [sent, setSent] = useState<{ sessionId: string; items: Sent[] }>({ sessionId, items: [] })
  if (sent.sessionId !== sessionId) setSent({ sessionId, items: [] })
  const items = sent.sessionId === sessionId ? sent.items : []
  const text = live?.sessionId === sessionId ? live.userText.split('\n').map((line) => line.trim()).find(Boolean) ?? live.userAttachments.map((a) => a.name ?? a.filename ?? '').filter(Boolean).join(', ') : ''
  if (live && text) {
    const message_id = live.userMessageId ?? `live:${live.streamId}`
    const known = items.find((item) => item.stream === live.streamId)
    if (known?.entry.message_id !== message_id) {
      // Its position is not known here: a jump finds it by its id, or else at the end.
      const entry = { message_id, index: Number.MAX_SAFE_INTEGER, excerpt: text, created_at: null }
      setSent({ sessionId, items: known ? items.map((item) => (item === known ? { ...known, entry } : item)) : [...items, { stream: live.streamId, read: query.dataUpdatedAt, entry }] })
    }
  }
  if (!query.data) return undefined
  const answered = new Set(query.data.entries.map((entry) => entry.message_id))
  return [...query.data.entries, ...items.filter((item) => item.read >= query.dataUpdatedAt && !answered.has(item.entry.message_id)).map((item) => item.entry)]
}

/**
 * The entry for the question in view: the last one at or above the row at the pane's top edge, or the last entry
 * once the reader is at the end, where the last question may never reach that line.
 */
function useEntryInView(pane: RefObject<HTMLDivElement | null>, entries: SessionOutlineEntry[]): number {
  const [viewIndex, setViewIndex] = useState<number | null>(null)
  useEffect(() => {
    const el = pane.current
    if (!el) return
    let frame = 0
    const measure = () => {
      frame = 0
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) { setViewIndex(Number.MAX_SAFE_INTEGER); return }
      const rows = [...el.querySelectorAll<HTMLElement>('[data-msg-idx]')]
      const bounds = el.getBoundingClientRect()
      const at = Number(rows[firstRowPast(rows.length, bounds.top, rowBoxes(rows))]?.dataset.msgIdx)
      setViewIndex(Number.isFinite(at) ? at : null)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    schedule()
    el.addEventListener('scroll', schedule, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(el)
    return () => { el.removeEventListener('scroll', schedule); resize?.disconnect(); cancelAnimationFrame(frame) }
  }, [pane, entries.length])
  return viewIndex === null ? -1 : entries.findLastIndex((entry) => entry.index <= viewIndex)
}

const NUMBER = 'w-7 shrink-0 text-right text-xs tabular-nums text-muted'

/** Arrow keys, Home and End move between the list's buttons; Enter and Space press them. */
function moveFocus(event: KeyboardEvent<HTMLOListElement>) {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key]
  if (next === undefined) return
  event.preventDefault()
  buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus()
}

export function Outline({ sessionId, revision, live, pane, onJump }: { sessionId: string; revision: string; live: LiveTurn | null; pane: RefObject<HTMLDivElement | null>; onJump: (entry: SessionOutlineEntry) => void }) {
  const entries = useOutline(sessionId, revision, live) ?? []
  const active = useEntryInView(pane, entries)
  const list = useRef<HTMLOListElement>(null)
  // The column scrolls on its own: it keeps the marked entry in its view, never moving the transcript.
  useLayoutEffect(() => {
    const scroller = list.current
    const row = scroller?.children[active] as HTMLElement | undefined
    if (!scroller || !row || !scroller.offsetParent) return
    if (row.offsetTop < scroller.scrollTop) scroller.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = row.offsetTop + row.offsetHeight - scroller.clientHeight
  }, [active])
  if (entries.length < OUTLINE_MIN_ENTRIES) return null
  const focusable = Math.max(active, 0)
  return (
    <>
      <nav aria-label={m.outline_label()} className="outline-column hidden min-h-0 w-56 shrink-0 flex-col border-l border-border min-[900px]:flex" data-outline>
        <h2 id="outlineTitle" className={cn(SECTION_HEADER, 'px-4 pt-4 pb-2')}>{m.outline_title()}</h2>
        <ol ref={list} aria-labelledby="outlineTitle" onKeyDown={moveFocus} className="relative m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain px-2 pb-4">
          {entries.map((entry, i) => (
            <li key={entry.message_id}>
              <button type="button" tabIndex={i === focusable ? 0 : -1} title={entry.excerpt} aria-current={i === active ? 'location' : undefined} onClick={() => onJump(entry)}
                className={cn('flex min-h-8 w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-[13px] outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:min-h-11', i === active ? 'text-accent-text' : 'text-muted hover:text-text')}>
                <span className={NUMBER}>{i + 1}</span>
                <span className="min-w-0 truncate">{entry.excerpt}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <Menu label={m.outline_label()} align="end" className="max-w-[min(92vw,320px)]" trigger={
        <button type="button" className="session-jump-btn session-jump-btn--outline" aria-label={m.outline_label()} title={m.outline_label()}><List size={14} aria-hidden="true" /></button>
      }>
        {/* The question in view is the checked choice, which the menu centres as it opens. */}
        <MenuRadioGroup value={String(active)}>
          {entries.map((entry, i) => (
            <MenuChoiceItem key={entry.message_id} value={String(i)} closeOnClick title={entry.excerpt} onClick={() => onJump(entry)}>
              <span className={NUMBER}>{i + 1}</span>
              <span className="min-w-0 truncate">{entry.excerpt}</span>
            </MenuChoiceItem>
          ))}
        </MenuRadioGroup>
      </Menu>
    </>
  )
}
