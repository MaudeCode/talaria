import { useToasts } from './toast'

export function Toaster() {
  const toasts = useToasts()
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[1400] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={t.kind === 'error' ? 'rounded-lg border border-error bg-surface px-3 py-2 text-sm text-text shadow-md' : 'rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text shadow-md'}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
