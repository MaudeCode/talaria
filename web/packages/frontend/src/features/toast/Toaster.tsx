import { X } from 'lucide-react'
import { useState } from 'react'
import { dismissToast, useToasts, type ToastAction } from './toast'
import { cn } from '../../ui/cn'

export function Toaster() {
  const toasts = useToasts()
  return (
    <div className="pointer-events-none fixed left-1/2 top-[max(18px,env(safe-area-inset-top,0px))] z-[1400] flex w-[min(92vw,460px)] -translate-x-1/2 flex-col items-center gap-2 max-[641px]:top-[calc(60px+env(safe-area-inset-top,0px))]" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'notification-toast pointer-events-auto w-full rounded-xl border bg-surface px-4 py-3 text-sm text-text shadow-md',
            t.kind === 'error' ? 'border-error/60' : t.kind === 'warning' ? 'border-warning/60' : 'border-border',
          )}
          data-visible={String(t.visible)}
          role={t.kind === 'error' ? 'alert' : undefined}
        >
          <div className="flex items-start gap-3">
            {t.onBodySelect ? <button type="button" className="min-w-0 flex-1 rounded-md border-0 bg-transparent p-0 text-left transition-transform active:scale-[.995]" aria-label={t.bodyLabel ?? t.title ?? t.text} onClick={() => { void t.onBodySelect?.() }}>
              {t.title && <p className="font-semibold text-strong">{t.title}</p>}
              <p className={cn('leading-5 text-text', t.title && 'mt-0.5 text-muted')}>{t.text}</p>
            </button> : <div className="min-w-0 flex-1">
              {t.title && <p className="font-semibold text-strong">{t.title}</p>}
              <p className={cn('leading-5 text-text', t.title && 'mt-0.5 text-muted')}>{t.text}</p>
            </div>}
            {t.dismissible && <button type="button" className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-hover hover:text-text" aria-label="Dismiss" onClick={() => dismissToast(t.id, 'manual')}><X size={16} aria-hidden="true" /></button>}
          </div>
          {t.actions.length > 0 && <div className="mt-3 flex justify-end gap-2">{t.actions.map((action) => <ToastActionButton key={action.id} action={action} />)}</div>}
        </div>
      ))}
    </div>
  )
}

function ToastActionButton({ action }: { action: ToastAction }) {
  const [pending, setPending] = useState(false)
  return <button
    type="button"
    className={cn('inline-flex min-w-24 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-[transform,background,color] active:scale-[.97] disabled:cursor-wait disabled:opacity-75', action.style === 'primary' ? 'border-accent bg-accent text-accent-fg' : action.style === 'destructive' ? 'border-error bg-error text-white' : 'border-border bg-transparent text-text hover:bg-hover')}
    disabled={pending}
    onClick={() => { setPending(true); void Promise.resolve(action.onSelect()).finally(() => setPending(false)) }}
  >
    {action.label}
  </button>
}
