import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCircle2, CircleAlert, Clock3, LoaderCircle, Trash2, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { UpdateNotification, UpdateNotifications } from '../../contracts'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { dismissToast, removeToast, showRichToast, showToast, type ToastAction } from '../toast/toast'

function StatusIcon({ notification }: { notification: UpdateNotification }) {
  if (notification.severity === 'critical' || notification.phase === 'failed' || notification.phase === 'unknown') return <CircleAlert className="size-5 text-error" aria-hidden="true" />
  if (notification.phase === 'succeeded') return <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
  if (notification.severity === 'warning' || notification.phase === 'blocked' || notification.phase === 'awaiting_confirmation') return <Clock3 className="size-5 text-warning" aria-hidden="true" />
  return <LoaderCircle className={cn('size-5 text-accent-text', notification.active && 'animate-spin')} aria-hidden="true" />
}

const formatTimestamp = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

interface CenterContextValue { unread: number; show: () => void }
const CenterContext = createContext<CenterContextValue | null>(null)

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
  useEffect(() => () => { for (const toastId of visibleServerToasts.current) removeToast(toastId) }, [])
  useEffect(() => {
    if (notifications.data || observedScope.current === null) return
    for (const toastId of visibleServerToasts.current) removeToast(toastId)
    primed.current = false
    observedPhases.current.clear()
    visiblePersistent.current.clear()
    visibleServerToasts.current.clear()
    persistentVersions.current.clear()
    observedScope.current = null
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
    mutationFn: ({ id, actionId }: { id: string; actionId: string }) => api.performUpdateNotificationAction(id, actionId),
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
      } else if (primed.current && (priorPhase === undefined || (row.kind === 'update' && priorPhase !== row.phase))) {
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
  }, [notifications.data, interact, performAction])

  const show = () => {
    setOpen(true)
    for (const row of rows) if (row.unread) void markRead(row)
  }

  return <CenterContext.Provider value={{ unread, show }}>
    {children}
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
  </CenterContext.Provider>
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
