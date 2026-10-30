import { useEffect, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Accessibility, Bell, Cpu, Gauge, Lock, MessageSquare, Mic, Palette, Paperclip, RefreshCw, Search, Settings, Share2, ShieldCheck, Sparkles, Workflow, type LucideIcon } from 'lucide-react'
import type { WhatsNewAnnouncement } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { readPersisted, writePersisted } from '../../lib/persisted'
import { Button } from '../../ui/Button'
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

/** Settings > System: replay the installed release's announcement; this never re-enables the automatic prompt. */
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
      const state = await api.fetchWhatsNew(stored !== null && stored.length <= 256 ? stored : null)
      if (state.observation !== null) writePersisted(scope, state.observation)
      return state
    },
    // One read per launch: a failure stays quiet and retries on the next launch or Settings visit, never by polling.
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  })
  return { scope, state: query.data, fetching: query.isFetching }
}

/** The What's New prompt for the installed Web release, shown once automatically and replayed from Settings. */
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
  const announcement = state?.announcement ?? null
  const acknowledgement = state?.eligible ? state.acknowledgement : null
  const unseen = announcement !== null && acknowledgement !== null && !fetching
  const navigating = useRouterState({ select: (s) => s.status === 'pending' })
  const interrupting = useSyncExternalStore(unseen && !open ? subscribeBusy : subscribeNever, busy, () => true)
  const presented = announcement !== null && (open || (unseen && !navigating && !interrupting))
  // Every dismissal (Continue, Escape, backdrop) closes this page's prompt at once, whether or not the token could be
  // saved; only a dismissed eligible prompt records it.
  const dismiss = () => {
    manual = false
    if (unseen) {
      writePersisted(scope, acknowledgement)
      qc.setQueryData(keys.whatsNew(scope), { ...state, eligible: false, acknowledgement: null })
    }
    notify()
  }
  if (!announcement) return null
  return <WhatsNewDialog announcement={announcement} open={presented} onDismiss={dismiss} />
}

/** Apple Notes-style announcement: heading, up to four icon/title/benefit rows, one Continue action. */
export function WhatsNewDialog({ announcement, open, onDismiss }: { announcement: WhatsNewAnnouncement; open: boolean; onDismiss: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss() }} title={m.whats_new_title()}
      className="max-h-[90dvh] w-[min(92vw,440px)] overflow-y-auto px-6 pt-8 pb-6 max-[480px]:px-5" titleClassName="text-center text-2xl leading-tight font-bold tracking-(--heading-tracking)">
      <div data-whats-new="">
        <ul className="mt-2 flex flex-col gap-6">
          {announcement.rows.map((row) => {
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
        <Button variant="primary" className="mt-8 min-h-11 w-full justify-center" onClick={onDismiss}>{m.whats_new_continue()}</Button>
      </div>
    </Dialog>
  )
}

/** Settings > System replay control, shown only when the installed release has an announcement. */
export function WhatsNewReplay() {
  const { state } = useWhatsNewState()
  return state?.announcement ? <Button variant="ghost" className="-ml-3 min-h-11" onClick={openWhatsNew}>{m.whats_new_open()}</Button> : null
}
