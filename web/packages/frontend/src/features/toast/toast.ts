/** Minimal toast store (legacy `showToast`). Rendered by <Toaster /> into a polite live region. */
import { useSyncExternalStore } from 'react'

export interface ToastAction { id: string; label: string; style: 'default' | 'primary' | 'destructive'; onSelect: () => void | Promise<void> }
export interface Toast {
  id: string
  revision?: string | undefined
  text: string
  title?: string | undefined
  ttl: number
  kind: 'info' | 'warning' | 'error'
  visible: boolean
  dismissible: boolean
  actions: ToastAction[]
  onDismiss?: (() => void | Promise<void>) | undefined
  onBodySelect?: (() => void | Promise<void>) | undefined
  bodyLabel?: string | undefined
}
let toasts: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const emit = () => { for (const l of listeners) l() }

const clearTimer = (timers: Map<string, ReturnType<typeof setTimeout>>, id: string) => {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
}

const remove = (id: string) => {
  clearTimer(removalTimers, id)
  clearTimer(expiryTimers, id)
  toasts = toasts.filter((toast) => toast.id !== id)
  emit()
}
export const removeToast = (id: string): void => { remove(id) }

export function dismissToast(id: string, reason: 'programmatic' | 'manual' | 'timeout' = 'programmatic'): void {
  const toast = toasts.find((item) => item.id === id)
  if (!toast || (!toast.visible && reason === 'manual')) return
  if (!toast.visible) { remove(id); return }
  if (reason === 'manual') void toast?.onDismiss?.()
  toasts = toasts.map((toast) => toast.id === id ? { ...toast, visible: false } : toast)
  emit()
  clearTimer(removalTimers, id)
  const revision = toast?.revision
  removalTimers.set(id, setTimeout(() => {
    const current = toasts.find((item) => item.id === id)
    if (current && !current.visible && current.revision === revision) remove(id)
  }, 220))
}

export function showToast(text: string, ttl = 2500, kind: 'info' | 'error' = 'info'): void {
  showRichToast({ id: `local-${String(++seq)}`, text, ttl, kind, dismissible: false, actions: [] })
}

export function showRichToast(input: Omit<Toast, 'visible'>): void {
  const existing = toasts.find((toast) => toast.id === input.id)
  if (existing) {
    if (existing.revision === input.revision) {
      toasts = toasts.map((toast) => toast.id === input.id ? { ...input, visible: toast.visible } : toast)
      emit()
      return
    }
    clearTimer(removalTimers, input.id)
    clearTimer(expiryTimers, input.id)
    toasts = toasts.map((toast) => toast.id === input.id ? { ...input, visible: false } : toast)
  } else {
    toasts = [...toasts, { ...input, visible: false }]
  }
  emit()
  const revision = input.revision
  requestAnimationFrame(() => {
    toasts = toasts.map((toast) => toast.id === input.id && toast.revision === revision ? { ...toast, visible: true } : toast)
    emit()
  })
  if (input.ttl > 0) expiryTimers.set(input.id, setTimeout(() => {
    if (toasts.some((toast) => toast.id === input.id && toast.revision === revision)) dismissToast(input.id, 'timeout')
  }, input.ttl))
}

export function useToasts(): Toast[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => toasts, () => toasts)
}
