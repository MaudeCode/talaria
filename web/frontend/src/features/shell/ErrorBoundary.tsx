import type { ErrorComponentProps } from '@tanstack/react-router'
import { useRouter } from '@tanstack/react-router'
import { isApiError } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'

function describe(error: unknown): { title: string; detail: string; reloadOnly: boolean } {
  if (isApiError(error)) {
    if (error.kind === 'unauthorized') return { title: m.login_title(), detail: error.message, reloadOnly: true }
    if (error.kind === 'invalid_payload') return { title: m.error_generic(), detail: error.message, reloadOnly: false }
    return { title: m.error_generic(), detail: error.message, reloadOnly: false }
  }
  const message = error instanceof Error ? error.message : String(error)
  // A failed lazy chunk (deploy while the tab was open) needs a reload, not a retry.
  const chunk = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(message)
  return { title: chunk ? m.update_hard_refresh_now() : m.error_generic(), detail: message, reloadOnly: chunk }
}

/** Route-level error boundary with actionable retry and reload. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const { title, detail, reloadOnly } = describe(error)
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col gap-3 p-6 text-text">
      <h2 className="text-base font-semibold text-strong">{title}</h2>
      <p className="break-words text-sm text-muted">{detail}</p>
      <div className="flex gap-2">
        {!reloadOnly && (
          <button type="button" className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-hover" onClick={() => { reset(); void router.invalidate() }}>
            {m.retry()}
          </button>
        )}
        <button type="button" className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-hover" onClick={() => window.location.reload()}>
          {m.reload()}
        </button>
      </div>
    </div>
  )
}

/** Root fallback used when the shell itself fails before the router can render. */
export function FatalError({ error }: { error: unknown }) {
  const { title, detail } = describe(error)
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-text">
      <h1 className="text-lg font-semibold text-strong">{title}</h1>
      <p className="max-w-xl break-words text-center text-sm text-muted">{detail}</p>
      <button type="button" className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-hover" onClick={() => window.location.reload()}>
        {m.reload()}
      </button>
    </div>
  )
}

export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-text">
      <h1 className="text-lg font-semibold text-strong">404</h1>
      <p className="text-sm text-muted">{m.not_found_page()}</p>
      <a href="./" className="text-sm text-accent-text underline">Hermes</a>
    </div>
  )
}

export function PendingView() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted" role="status" aria-live="polite">
      {m.loading()}
    </div>
  )
}
