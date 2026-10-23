import type { PointerEvent, ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'

/** The existing terminal chrome, shared with its lazy-loading fallback without importing xterm. */
export function TerminalPanelFrame({ workspace, title, status, onClose, onResize, actions, children }: {
  title?: string | undefined
  workspace: string | undefined
  status: 'loading' | 'starting' | 'running' | 'closed' | 'error'
  onClose: () => void
  onResize?: (event: PointerEvent<HTMLDivElement>) => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="composer-terminal-panel mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-border bg-surface" id="composerTerminalPanel" data-status={status} aria-busy={status === 'loading'}>
      <div className="composer-terminal-resize-handle h-1.5 cursor-row-resize rounded-t-xl hover:bg-accent-bg-strong" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" aria-disabled={!onResize} tabIndex={onResize ? 0 : -1} onPointerDown={onResize} />
      <div className="composer-terminal-header flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs">
        <div className="composer-terminal-title flex min-w-0 flex-1 basis-52 items-center gap-2 text-text"><span>{title ?? m.terminal_title()}</span><span className="text-muted">·</span><span className="truncate font-mono text-muted" id="terminalWorkspaceLabel">{workspace ?? ''}</span>{status === 'error' && <span className="text-error">{m.terminal_unavailable()}</span>}</div>
        <div className="composer-terminal-actions flex items-center gap-1">
          {actions}
          <Button variant="ghost" onClick={onClose}>{m.terminal_close()}</Button>
        </div>
      </div>
      {children}
    </div>
  )
}
