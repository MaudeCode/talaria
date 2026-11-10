import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Accessibility, Bell, ChevronLeft, ChevronRight, Cpu, Gauge, Lock, MessageSquare, Mic, Palette, Paperclip, RefreshCw, Search, Settings, Share2, ShieldCheck, Sparkles, Workflow, type LucideIcon } from 'lucide-react'
import { WhatsNewObservedSchema, type WhatsNewAnnouncement } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { readPersisted, writePersisted } from '../../lib/persisted'
import { Button, IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Dialog } from '../../ui/Dialog'

type Icon = WhatsNewAnnouncement['rows'][number]['icon']

/** The one client mapping from the contract's semantic icon keys to symbols; each is decorative beside its title. */
const ICONS: Record<Icon, LucideIcon> = {
  sparkles: Sparkles, chat: MessageSquare, voice: Mic, attachment: Paperclip, search: Search, notifications: Bell,
  automation: Workflow, model: Cpu, appearance: Palette, speed: Gauge, reliability: ShieldCheck, security: Lock,
  sync: RefreshCw, share: Share2, settings: Settings, accessibility: Accessibility,
}

/**
 * Device-local presentation state (TAL-1617). This browser keeps the server's opaque token per Web origin (local
 * storage) and signed-in user; anonymous use has its own scope. The server decides eligibility from it (TAL-1616).
 */
export const whatsNewScope = (user: string | null | undefined) => `talaria-whats-new:${user ? `user:${user}` : 'anonymous'}`

const listeners = new Set<() => void>()
let manual = false
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Settings > About: replay the installed release's announcement; this never re-enables the automatic prompt. */
export function openWhatsNew(): void {
  manual = true
  notify()
}

const shown = (el: Element) => typeof el.checkVisibility !== 'function' || el.checkVisibility()
/** True while presenting would interrupt the user: another visible dialog or menu, or a focused field holding a draft. */
function busy(): boolean {
  if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some((el) => !el.querySelector('[data-whats-new]') && shown(el))) return true
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== ''
  return el instanceof HTMLElement && el.isContentEditable && (el.textContent ?? '') !== ''
}
function subscribeBusy(changed: () => void) {
  const observer = new MutationObserver(changed)
  observer.observe(document.body, { childList: true, subtree: true })
  for (const type of ['focusin', 'focusout', 'input']) document.addEventListener(type, changed, true)
  return () => {
    observer.disconnect()
    for (const type of ['focusin', 'focusout', 'input']) document.removeEventListener(type, changed, true)
  }
}
const subscribeNever = () => () => undefined

/** The server's answer for this browser scope; an `observation` is stored at once, never an unseen acknowledgement. */
export function useWhatsNewState() {
  const scope = whatsNewScope(useBootstrap().auth.user)
  const query = useQuery({
    queryKey: keys.whatsNew(scope),
    queryFn: async () => {
      const stored = readPersisted(scope)
      const state = await api.fetchWhatsNew(stored !== null && WhatsNewObservedSchema.safeParse(stored).success ? stored : null)
      if (state.observation !== null) writePersisted(scope, state.observation)
      return state
    },
    // One read per launch: a failure stays quiet and retries on the next launch or Settings visit, never by polling.
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  })
  return { scope, state: query.data, fetching: query.isFetching }
}

/** The What's New prompt: the server's unseen rows once automatically, the installed release's full announcement from Settings. */
export function WhatsNew() {
  const { scope, state, fetching } = useWhatsNewState()
  const qc = useQueryClient()
  // Another tab of this browser changed the token (it dismissed the prompt, or recorded a release): ask the server
  // again rather than judging the new token here. The prompt stays closed until that answer arrives.
  useEffect(() => {
    const changed = (e: StorageEvent) => { if (e.key === scope || e.key === null) void qc.invalidateQueries({ queryKey: keys.whatsNew(scope) }) }
    window.addEventListener('storage', changed)
    return () => { window.removeEventListener('storage', changed) }
  }, [qc, scope])
  const open = useSyncExternalStore(subscribe, () => manual, () => false)
  const acknowledgement = state?.eligible ? state.acknowledgement : null
  const unseen = state?.presentation != null && acknowledgement !== null && !fetching
  // Settings replays the full announcement; the automatic prompt shows only the server's unseen rows. A closing
  // dialog keeps the rows it opened with.
  const content = (open ? state?.announcement : unseen ? state?.presentation : null) ?? null
  const [announcement, setAnnouncement] = useState(content)
  if (content !== null && content !== announcement) setAnnouncement(content)
  const navigating = useRouterState({ select: (s) => s.status === 'pending' })
  const interrupting = useSyncExternalStore(unseen && !open ? subscribeBusy : subscribeNever, busy, () => true)
  const presented = content !== null && (open || (unseen && !navigating && !interrupting))
  // Every dismissal (Continue, Escape, backdrop) closes this page's prompt at once, whether or not the token could be
  // saved; only a dismissed eligible prompt records it.
  const dismiss = () => {
    manual = false
    if (unseen) {
      writePersisted(scope, acknowledgement)
      qc.setQueryData(keys.whatsNew(scope), { ...state, presentation: null, eligible: false, acknowledgement: null })
    }
    notify()
  }
  if (!announcement) return null
  return <WhatsNewDialog announcement={announcement} open={presented} onDismiss={dismiss} />
}

/** Layout, not a decision about which rows show: every row shows, this many to a page (TAL-2174). */
const ROWS_PER_PAGE = 4
/** The skip line's slot; the last page keeps it empty so the dialog's height never changes as the pages turn. */
const SKIP_SLOT = 'mt-1 min-h-9 w-full pointer-coarse:min-h-11'

const editable = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable)

/**
 * Apple Notes-style announcement: heading, icon/title/benefit rows, one Continue action. More than four rows turn into
 * pages of four with dots and arrows; Continue turns the page until the last, where it closes, and a skip line under it
 * closes the dialog from any earlier page (TAL-2174). Every way of closing it acknowledges every row.
 */
export function WhatsNewDialog({ announcement, open, onDismiss }: { announcement: WhatsNewAnnouncement; open: boolean; onDismiss: () => void }) {
  const pages: WhatsNewAnnouncement['rows'][] = []
  for (let i = 0; i < announcement.rows.length; i += ROWS_PER_PAGE) pages.push(announcement.rows.slice(i, i + ROWS_PER_PAGE))
  const [page, setPage] = useState(0)
  // Each opening starts on the first page.
  const [shownOpen, setShownOpen] = useState(open)
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open) setPage(0)
  }
  const current = Math.min(page, pages.length - 1)
  const paged = pages.length > 1
  const last = current === pages.length - 1
  const turn = (to: number) => { if (to >= 0 && to < pages.length) setPage(to) }
  const continueRef = useRef<HTMLButtonElement>(null)
  const pageKeys = (event: KeyboardEvent) => {
    if (!paged || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || editable(event.target)) return
    if (event.key === 'ArrowRight') turn(current + 1)
    else if (event.key === 'ArrowLeft') turn(current - 1)
    else return
    event.preventDefault()
  }
  // An unavailable arrow keeps focus (aria-disabled, not disabled) and does nothing.
  const arrow = (to: number, label: string, Icon: LucideIcon) => {
    const unavailable = to < 0 || to >= pages.length
    return (
      <IconButton variant="ghost" label={label} aria-disabled={unavailable || undefined} onClick={() => { turn(to) }}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent">
        <Icon aria-hidden="true" />
      </IconButton>
    )
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss() }} title={m.whats_new_title()} initialFocus={continueRef} onKeyDown={pageKeys}
      maxWidth={440} className="max-h-[90dvh] overflow-y-auto px-6 pt-8 pb-6 max-[480px]:px-5" titleClassName="text-center text-2xl leading-tight font-bold tracking-(--heading-tracking)">
      <div data-whats-new="">
        {/* Every page shares one grid cell, so the dialog is as tall as its tallest page and nothing moves on a turn. */}
        <div className="mt-2 grid">
          {pages.map((rows, index) => {
            const hidden = index !== current
            return (
              <ul key={index} className={cn('col-start-1 row-start-1 flex flex-col gap-6', hidden && 'invisible')} inert={hidden} aria-hidden={hidden || undefined}>
                {rows.map((row) => {
                  const RowIcon = ICONS[row.icon]
                  return (
                    <li key={row.id} className="flex items-start gap-4">
                      <RowIcon aria-hidden="true" className="mt-0.5 size-7 shrink-0 text-accent-text" strokeWidth={1.75} />
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-strong [overflow-wrap:anywhere]">{row.title}</p>
                        <p className="mt-0.5 text-sm text-muted [overflow-wrap:anywhere]">{row.description}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          })}
        </div>
        {paged && (
          <div className="mt-6 flex items-center justify-center gap-3">
            {arrow(current - 1, m.whats_new_previous_page(), ChevronLeft)}
            {/* The dots only show where the reader is; the live region below says it. */}
            <div aria-hidden="true" className="flex items-center gap-2">
              {pages.map((_, index) => <span key={index} data-page-dot={index === current ? 'current' : ''} className={cn('size-2 rounded-full', index === current ? 'bg-accent' : 'bg-border2')} />)}
            </div>
            {arrow(current + 1, m.whats_new_next_page(), ChevronRight)}
            <p className="sr-only" aria-live="polite">{m.whats_new_page_status({ page: String(current + 1), pages: String(pages.length) })}</p>
          </div>
        )}
        <Button ref={continueRef} variant="primary" className={cn(paged ? 'mt-4' : 'mt-8', 'min-h-11 w-full justify-center')} onClick={() => { if (last) onDismiss(); else turn(current + 1) }}>{m.whats_new_continue()}</Button>
        {/* Translations keep the word for skipping first and stay one short line. */}
        {paged && !last && <button type="button" className={cn(SKIP_SLOT, 'text-[13px] text-muted hover:underline focus-visible:underline')} onClick={onDismiss}>{m.whats_new_skip()}</button>}
        {paged && last && <div aria-hidden="true" className={SKIP_SLOT} />}
      </div>
    </Dialog>
  )
}
