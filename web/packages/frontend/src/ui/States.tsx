import type { ReactNode } from 'react'
import { m } from '../paraglide/messages.js'
import { isApiError } from '../contracts/common'
import { Button } from './Button'
import { cn } from './cn'

/** Centered live-status line; the pulsing accent dot is the app's "working" idiom (see LiveTurnView). */
export function LoadingState({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 p-6 text-[13px] text-muted', className)} role="status" aria-live="polite">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      {label ?? m.loading()}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>
}

/** Typed error surface: never a blank pane. Malformed payloads and HTTP errors both land here with a retry. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const detail = isApiError(error) ? error.message : error instanceof Error ? error.message : String(error)
  const kind = isApiError(error) ? error.kind : 'unknown'
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-error/40 bg-surface p-3 text-sm">
      <div className="font-medium text-text">{m.error_generic()}</div>
      <div className="break-words text-xs text-muted" data-error-kind={kind}>{detail}</div>
      {onRetry && <div><Button onClick={onRetry}>{m.retry()}</Button></div>}
    </div>
  )
}

export function formatDate(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return ''
  const n = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts)
  if (!Number.isFinite(n)) return String(ts)
  return new Date(n).toLocaleString()
}

export function formatBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
