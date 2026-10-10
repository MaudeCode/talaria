import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Trash2, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { UpdateNotification, UpdateNotifications } from '../../contracts'
import { isApiError } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { dismissToast, removeToast, showRichToast, showToast, type ToastAction } from '../toast/toast'
import { StatusIcon, UpdatingDialog, type UpdateDialogTarget } from './UpdatingDialog'
import { ServerStoppedOverlay } from '../notices/ServerStoppedOverlay'

/** Server action that asks this tab to load the build the server now serves; the server clears the notice only after verifying it. */
const RELOAD_ACTION = 'reload'

const formatTimestamp = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

interface CenterContextValue { unread: number; show: () => void }
const CenterContext = createContext<CenterContextValue | null>(null)

/**
 * Settings' handle on the Updating dialog. `begin` opens it for the clicked target before the apply
 * request settles; `settle` hands over the apply response or error; `dismiss` hides it (the Agent
 * confirmation dialog takes over). Everything shown after that comes from the server's `tab_update`.
 */
export interface UpdateProgress {
  begin: (target: UpdateDialogTarget) => void
  settle: (target: UpdateDialogTarget, outcome: { notification_id?: string | undefined; message?: string | undefined; error?: string | undefined; status?: string | undefined } | { failure: unknown }) => void
  dismiss: (notificationId?: string) => void
}
const ProgressContext = createContext<UpdateProgress | null>(null)
/** Null outside the app shell (isolated component tests). */
export const useUpdateProgress = () => useContext(ProgressContext)

/** The dialog's device-local state for the operation this tab just started, until the server's record takes over. */
interface Tracking {
  target: UpdateDialogTarget
  /** The tab's server record when the click happened; only a newer record (or `notificationId`) belongs to this start. */
  baseline: string | null
  notificationId: string | null
  /** When the apply request lost the server: the outcome is unknown until a later read answers. */
  lostAt: number | null
  /** The server's answer when it returned no operation record to follow. */
  message: string | null
  /** Closed before its record arrived: this start stays hidden, across reloads of the tab, until another start replaces it. */
  hidden: boolean
}
/** The tab's server record as of now; a rejoin of the same record changes only its join time. */
const recordKey = (row: UpdateNotification | null, joinedAt: string | null) => row ? `${row.id}@${row.updated_at}@${joinedAt ?? ''}` : null
/** A lost connection leaves the apply outcome unknown; any other answer came from the server. */
const lostServer = (error: unknown) => isApiError(error) ? error.kind === 'network' || error.kind === 'timeout' || [502, 503, 504].includes(error.status) : true
const CLOSED_KEY = 'talaria-closed-update-dialogs'
const HIDDEN_KEY = 'talaria-hidden-update-start'
const readHidden = (): Tracking | null => {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const { target, baseline, notificationId } = parsed as Record<string, unknown>
    if ((target !== 'webui' && target !== 'agent') || (baseline !== null && typeof baseline !== 'string') || (notificationId !== null && typeof notificationId !== 'string')) return null
    return { target, baseline, notificationId, lostAt: null, message: null, hidden: true }
  } catch { return null }
}
const readClosed = (): string[] => {
  try { const parsed: unknown = JSON.parse(sessionStorage.getItem(CLOSED_KEY) ?? '[]'); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [] } catch { return [] }
}

export function UpdateNotificationProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const primed = useRef(false)
  const observedPhases = useRef(new Map<string, string>())
  const observedScope = useRef<string | null>(null)
  const visiblePersistent = useRef(new Set<string>())
  const visibleServerToasts = useRef(new Set<string>())
  const persistentVersions = useRef(new Map<string, string>())
  const notifications = useQuery({ queryKey: keys.updateNotifications, queryFn: api.fetchUpdateNotifications, staleTime: 1_000, refetchInterval: 2_000 })
  const [tracking, setTracking] = useState(readHidden)
  // A start closed before its record arrived is remembered for the tab's session, so its record never reopens the dialog.
  useEffect(() => {
    try {
      if (tracking?.hidden) sessionStorage.setItem(HIDDEN_KEY, JSON.stringify({ target: tracking.target, baseline: tracking.baseline, notificationId: tracking.notificationId }))
      else sessionStorage.removeItem(HIDDEN_KEY)
    } catch { /* storage unavailable: the close lasts for this page load */ }
  }, [tracking])
  // Operations whose dialog this tab closed; sessionStorage keeps a reload from reopening them.
  const [closed, setClosed] = useState(readClosed)
  const tabUpdate = notifications.data?.tab_update ?? null
  const tabJoinedAt = notifications.data?.tab_joined_at ?? null
  const dialogRow = tracking
    ? tabUpdate?.target === tracking.target && (tabUpdate.id === tracking.notificationId || recordKey(tabUpdate, tabJoinedAt) !== tracking.baseline) ? tabUpdate : null
    : tabUpdate && !closed.includes(tabUpdate.id) ? tabUpdate : null
  const dialogRowId = dialogRow?.id ?? null
  // The dialog replaces this record's phase toasts while it shows them.
  const shownRowId = tracking?.hidden ? null : dialogRowId
  const closeDialog = useCallback((id: string | null) => {
    setTracking(null)
    if (!id) return
    setClosed((current) => {
      const next = [...current.filter((entry) => entry !== id), id].slice(-20)
      try { sessionStorage.setItem(CLOSED_KEY, JSON.stringify(next)) } catch { /* storage unavailable: closing lasts for this page load */ }
      return next
    })
  }, [])
  const progress = useMemo<UpdateProgress>(() => ({
    begin: (target) => { setTracking({ target, baseline: recordKey(tabUpdate, tabJoinedAt), notificationId: null, lostAt: null, message: null, hidden: false }) },
    settle: (target, outcome) => {
      setTracking((current) => {
        if (current?.target !== target) return current
        if ('failure' in outcome) return lostServer(outcome.failure)
          ? { ...current, lostAt: Date.now() }
          : { ...current, message: outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure) }
        return outcome.notification_id ? { ...current, notificationId: outcome.notification_id } : { ...current, message: outcome.message ?? outcome.error ?? outcome.status ?? m.update_dialog_unverified() }
      })
      void qc.invalidateQueries({ queryKey: keys.updateNotifications })
    },
    dismiss: (notificationId) => { closeDialog(notificationId ?? null) },
  }), [tabUpdate, tabJoinedAt, qc, closeDialog])
  useEffect(() => () => { for (const toastId of visibleServerToasts.current) removeToast(toastId) }, [])
  // A new service worker taking over is a signal that the server may serve a newer build: recheck now.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const recheck = () => { void qc.invalidateQueries({ queryKey: keys.updateNotifications }) }
    navigator.serviceWorker.addEventListener('controllerchange', recheck)
    return () => { navigator.serviceWorker.removeEventListener('controllerchange', recheck) }
  }, [qc])
  useEffect(() => {
    if (notifications.data || observedScope.current === null) return
    for (const toastId of visibleServerToasts.current) removeToast(toastId)
    primed.current = false
    observedPhases.current.clear()
    visiblePersistent.current.clear()
    visibleServerToasts.current.clear()
    persistentVersions.current.clear()
    observedScope.current = null
    setTracking(null)
  }, [notifications.data])
  const refresh = () => { void qc.invalidateQueries({ queryKey: keys.updateNotifications }) }
  const dismiss = useMutation({ mutationFn: api.dismissUpdateNotification, onSuccess: refresh, onError: (error) => showToast(`Couldn't dismiss the notification: ${error instanceof Error ? error.message : String(error)}`, 5_000, 'error') })
  const clear = useMutation({
    mutationFn: api.clearUpdateNotifications,
    onSuccess: (result) => {
      qc.setQueryData(keys.updateNotifications, result)
      const remaining = new Set(result.notifications.map((row) => `server-${row.id}`))
      for (const toastId of visibleServerToasts.current) if (!remaining.has(toastId)) dismissToast(toastId)
    },
    onError: (error) => showToast(`Couldn't clear notifications: ${error instanceof Error ? error.message : String(error)}`, 5_000, 'error'),
  })
  const action = useMutation({
    mutationFn: async ({ id, actionId }: { id: string; actionId: string }) => {
      const row = await api.performUpdateNotificationAction(id, actionId)
      if (actionId === RELOAD_ACTION) window.location.reload()
      return row
    },
    onSuccess: (row) => {
      qc.setQueryData<UpdateNotifications>(keys.updateNotifications, (current) => current ? { ...current, notifications: current.notifications.map((item) => item.id === row.id ? row : item) } : current)
      if (!row.requires_interaction) dismissToast(`server-${row.id}`)
      void qc.invalidateQueries({ queryKey: keys.updateNotifications })
    },
    onError: (error) => showToast(`Couldn't complete that notification action: ${error instanceof Error ? error.message : String(error)}`, 5_000, 'error'),
  })
  const unread = notifications.data?.unread_count ?? 0
  const rows = notifications.data?.notifications ?? []

  const markRead = useCallback(async (row: UpdateNotification) => {
    if (!row.unread) return
    try {
      await api.readUpdateNotification(row.id)
      void qc.invalidateQueries({ queryKey: keys.updateNotifications })
    } catch (error) {
      showToast(`Couldn't mark the notification read: ${error instanceof Error ? error.message : String(error)}`, 5_000, 'error')
    }
  }, [qc])
  const openDestination = useCallback((row: UpdateNotification) => {
    if (row.destination?.key !== 'settings.system') return
    setOpen(false)
    void navigate({ to: '/settings/$section', params: { section: 'system' } })
  }, [navigate])
  const interact = useCallback(async (row: UpdateNotification, options: { navigate?: boolean; closeToast?: boolean } = {}) => {
    if (options.closeToast) dismissToast(`server-${row.id}`)
    if (options.navigate) openDestination(row)
    await markRead(row)
  }, [markRead, openDestination])
  const performMutation = action.mutateAsync
  const performAction = useCallback((row: UpdateNotification, actionId: string) => performMutation({ id: row.id, actionId }).then(() => undefined), [performMutation])

  useEffect(() => {
    if (!notifications.data) return
    if (observedScope.current !== notifications.data.scope_id) {
      for (const toastId of visibleServerToasts.current) removeToast(toastId)
      primed.current = false
      observedPhases.current.clear()
      visiblePersistent.current.clear()
      visibleServerToasts.current.clear()
      persistentVersions.current.clear()
      if (observedScope.current !== null) setTracking(null)
      observedScope.current = notifications.data.scope_id
    }
    const destinationActions = (row: UpdateNotification): ToastAction[] => row.destination?.key === 'settings.system' ? [{
      id: 'open-destination', label: row.destination.label, style: 'default',
      onSelect: () => interact(row, { navigate: true, closeToast: !row.requires_interaction }),
    }] : []
    const unresolvedPersistent = new Set<string>()
    for (const row of notifications.data.notifications) {
      const toastId = `server-${row.id}`
      const priorPhase = observedPhases.current.get(row.id)
      const requiresInteraction = row.requires_interaction
      if (requiresInteraction) {
        unresolvedPersistent.add(toastId)
        if (!visiblePersistent.current.has(toastId) || persistentVersions.current.get(toastId) !== row.updated_at) {
          showRichToast({
            id: toastId, revision: row.updated_at, title: row.title, text: row.message, ttl: 0,
            kind: row.severity === 'critical' ? 'error' : 'warning', dismissible: false,
            actions: [...row.actions.map((item) => ({ ...item, onSelect: () => performAction(row, item.id) })), ...destinationActions(row)],
            onBodySelect: () => interact(row, { navigate: row.destination?.key === 'settings.system' }),
            bodyLabel: `${row.title}. ${row.message}`,
          })
          visibleServerToasts.current.add(toastId)
          persistentVersions.current.set(toastId, row.updated_at)
        }
      } else if (primed.current && row.id !== shownRowId && (priorPhase === undefined || (row.kind === 'update' && priorPhase !== row.phase))) {
        showRichToast({
          id: toastId,
          revision: row.updated_at,
          title: row.title,
          text: row.message,
          ttl: 4_500,
          kind: row.severity === 'critical' ? 'error' : row.severity === 'warning' ? 'warning' : 'info',
          dismissible: true,
          actions: [...row.actions.map((item) => ({ ...item, onSelect: () => performAction(row, item.id) })), ...destinationActions(row)],
          onDismiss: () => interact(row),
          onBodySelect: () => interact(row, { navigate: row.destination?.key === 'settings.system', closeToast: true }),
          bodyLabel: `${row.title}. ${row.message}`,
        })
        visibleServerToasts.current.add(toastId)
      }
      observedPhases.current.set(row.id, row.phase)
    }
    for (const toastId of visiblePersistent.current) if (!unresolvedPersistent.has(toastId)) dismissToast(toastId)
    const current = new Set(notifications.data.notifications.map((row) => `server-${row.id}`))
    for (const toastId of visibleServerToasts.current) if (!current.has(toastId)) dismissToast(toastId)
    visiblePersistent.current = unresolvedPersistent
    primed.current = true
  }, [notifications.data, interact, performAction, shownRowId])

  const show = () => {
    setOpen(true)
    for (const row of rows) if (row.unread) void markRead(row)
  }

  // The read endpoint is the dialog's connection probe: a failing or paused poll, or a lost apply not yet answered by a later read.
  const reconnecting = notifications.isError || notifications.failureCount > 0 || notifications.fetchStatus === 'paused'
    || (tracking?.lostAt != null && notifications.dataUpdatedAt <= tracking.lostAt)
  const dialogTarget = dialogRow?.target ?? tracking?.target ?? null

  return <CenterContext.Provider value={{ unread, show }}><ProgressContext.Provider value={progress}>
    {children}
    {dialogTarget && !tracking?.hidden && <UpdatingDialog
      target={dialogTarget}
      row={dialogRow}
      message={tracking?.message ?? null}
      lost={tracking?.lostAt != null}
      reconnecting={reconnecting}
      checking={notifications.isFetching}
      onCheckAgain={() => { void notifications.refetch() }}
      onClose={() => { if (tracking && !dialogRowId) setTracking({ ...tracking, hidden: true }); else closeDialog(dialogRowId) }}
    />}
    <ServerStoppedOverlay suppressed={(dialogTarget !== null && !tracking?.hidden) || notifications.data?.notifications.some((row) => row.active && row.target === 'webui') === true} />
    <BaseDialog.Root open={open} onOpenChange={setOpen}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[1300] bg-black/45" />
        <BaseDialog.Popup className="fixed right-4 top-4 z-[1301] flex max-h-[calc(100dvh-2rem)] w-[min(94vw,420px)] flex-col overflow-hidden rounded-2xl border border-border bg-surface text-text shadow-md outline-none max-[641px]:inset-x-2 max-[641px]:top-auto max-[641px]:bottom-[calc(8px+env(safe-area-inset-bottom,0px))] max-[641px]:w-auto max-[641px]:max-h-[78dvh]">
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="flex-1 min-w-0"><BaseDialog.Title className="text-base font-semibold text-strong">{m.update_notifications()}</BaseDialog.Title><BaseDialog.Description className="mt-0.5 text-sm text-muted">{m.update_notifications_description()}</BaseDialog.Description></div>
            <button type="button" className="min-h-9 rounded-lg border-0 bg-transparent px-2 text-xs font-semibold text-accent-text transition-[transform,opacity] active:scale-[.97] disabled:cursor-default disabled:opacity-40" disabled={clear.isPending || notifications.data?.can_clear !== true} onClick={() => clear.mutate()}>{m.update_notifications_clear_all()}</button>
            <BaseDialog.Close className="flex size-9 items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-hover hover:text-text" aria-label={m.close()}><X size={18} aria-hidden="true" /></BaseDialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {notifications.isPending ? <p className="px-3 py-10 text-center text-sm text-muted">{m.loading()}</p>
              : notifications.isError ? <p className="px-3 py-10 text-center text-sm text-error">{m.update_notifications_unavailable()}</p>
                : rows.length === 0 ? <div className="px-5 py-12 text-center"><Bell className="mx-auto mb-3 size-7 text-muted" aria-hidden="true" /><p className="text-sm font-medium text-text">{m.update_notifications_empty()}</p></div>
                  : <ul className="flex flex-col gap-1">{rows.map((row) => {
                    const requiresAction = row.requires_interaction
                    const actionPending = action.isPending && action.variables?.id === row.id
                    return <li key={row.id} className={cn('group flex gap-3 rounded-xl px-3 py-3', row.unread && 'bg-accent-bg', requiresAction && 'ring-1 ring-error/35')}>
                      <div className="mt-0.5 shrink-0"><StatusIcon notification={row} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2"><p className="flex-1 text-sm font-semibold text-text">{row.title}</p>{row.unread && <span className="mt-1 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}</div>
                        <p className="mt-1 text-sm leading-5 text-muted">{row.message}</p>
                        {row.detail && <p className="mt-1 whitespace-pre-line break-words text-xs leading-5 text-muted">{row.detail}</p>}
                        {(row.actions.length > 0 || row.destination?.key === 'settings.system') && <div className="mt-3 flex flex-wrap gap-2">
                          {row.actions.map((item) => <button key={item.id} type="button" disabled={actionPending} className={cn('inline-flex min-w-24 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-[transform,background,color,opacity] active:scale-[.97] disabled:cursor-wait disabled:opacity-75', item.style === 'primary' ? 'border-accent bg-accent text-accent-fg' : item.style === 'destructive' ? 'border-error bg-error text-white' : 'border-border text-text hover:bg-hover')} onClick={() => action.mutate({ id: row.id, actionId: item.id })}>{item.label}</button>)}
                          {row.destination?.key === 'settings.system' && <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text transition-transform active:scale-[.97] hover:bg-hover" onClick={() => { void interact(row, { navigate: true }) }}>{row.destination.label}</button>}
                        </div>}
                        <time className="mt-2 block text-[11px] text-muted" dateTime={row.updated_at}>{formatTimestamp(row.updated_at)}</time>
                      </div>
                      {row.can_dismiss && <button type="button" className="flex size-9 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-muted opacity-70 hover:bg-hover hover:text-error group-hover:opacity-100" aria-label={m.dismiss()} onClick={() => dismiss.mutate(row.id)}><Trash2 size={16} aria-hidden="true" /></button>}
                    </li>
                  })}</ul>}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  </ProgressContext.Provider></CenterContext.Provider>
}

export function UpdateNotificationCenterButton({ placement }: { placement: 'rail' | 'titlebar' }) {
  const center = useContext(CenterContext)
  if (!center) throw new Error('UpdateNotificationCenterButton requires UpdateNotificationProvider')
  const buttonClass = placement === 'rail'
    ? 'rail-btn has-tooltip relative flex w-[54px] min-h-12 flex-none flex-col items-center justify-center gap-[3px] rounded-(--rail-btn-radius) border-0 bg-transparent text-muted cursor-pointer p-0 hover:text-text hover:bg-hover'
    : 'app-titlebar-notifications relative inline-flex size-11 shrink-0 items-center justify-center bg-transparent border-0 text-muted rounded-lg cursor-pointer [-webkit-app-region:no-drag] hover:bg-hover hover:text-text'
  return <button type="button" className={buttonClass} data-panel={placement === 'rail' ? 'update-notifications' : undefined} data-tooltip={m.update_notifications()} aria-label={m.update_notifications()} onClick={center.show}>
    <Bell size={18} strokeWidth={1.5} aria-hidden="true" />
    {center.unread > 0 && <span className="absolute right-1.5 top-1.5 min-w-4 h-4 rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-fg text-center" aria-label={m.update_notifications_unread({ count: center.unread })}>{center.unread > 9 ? '9+' : center.unread}</span>}
  </button>
}
