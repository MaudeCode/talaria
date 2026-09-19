/** Minimal toast store (legacy `showToast`). Rendered by <Toaster /> into a polite live region. */
import { useSyncExternalStore } from 'react'

export interface Toast { id: number; text: string; ttl: number; kind: 'info' | 'error' }
let toasts: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

export function showToast(text: string, ttl = 2500, kind: 'info' | 'error' = 'info'): void {
  const id = ++seq
  toasts = [...toasts, { id, text, ttl, kind }]
  emit()
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    emit()
  }, ttl)
}

export function useToasts(): Toast[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => toasts, () => toasts)
}
