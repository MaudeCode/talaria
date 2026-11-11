import type { PointerEvent, ReactNode } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { IconButton } from '../../ui/Button'
import { StatusDot, type DotState } from '../../ui/Badge'

/** The existing terminal chrome, shared with its lazy-loading fallback without importing xterm. */
export function TerminalPanelFrame({ workspace, title, status, onClose, onResize, collapse, actions, children }: {
  title?: string | undefined
  workspace: string | undefined
  status: 'loading' | 'starting' | 'running' | 'closed' | 'error'
  onClose: () => void
  onResize?: (event: PointerEvent<HTMLDivElement>) => void
  /** TAL-2156: collapsed, the panel keeps its children mounted but shows only this header, its state as a dot. */
  collapse?: { collapsed: boolean; onToggle: () => void; dot: DotState; words: string } | undefined
  actions?: ReactNode
  children: ReactNode
}) {
  const collapsed = collapse?.collapsed === true
  return (
    <div className="composer-terminal-panel mx-auto mb-2 w-full max-w-[var(--msg-max)] rounded-xl border border-border bg-surface" id="composerTerminalPanel" data-status={status} data-collapsed={collapsed || undefined} aria-busy={status === 'loading'}>
      <div hidden={collapsed} className="composer-terminal-resize-handle h-1.5 cursor-row-resize rounded-t-xl hover:bg-accent-bg-strong" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" aria-disabled={!onResize} tabIndex={onResize ? 0 : -1} onPointerDown={onResize} />
      <div className="composer-terminal-header flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs">
        <div className="composer-terminal-title flex min-w-0 flex-1 basis-52 items-center gap-2 text-text">
          <span>{title ?? m.terminal_title()}</span><span className="text-muted">·</span><span className="truncate font-mono text-muted" id="terminalWorkspaceLabel">{workspace ?? ''}</span>{status === 'error' && <span className="text-error">{m.terminal_unavailable()}</span>}
          {/* Mounted with the collapsed header, so only later changes (new output) are announced. */}
          {collapse?.collapsed && <span role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 font-normal normal-case tracking-normal"><StatusDot state={collapse.dot}>{collapse.words}</StatusDot></span>}
        </div>
        <div className="composer-terminal-actions flex items-center gap-1">
          {collapsed ? null : actions}
          {/* One button in one place, so focus stays on it when it flips between collapse and expand. */}
          {collapse && <IconButton variant="ghost" label={collapsed ? m.terminal_expand() : m.terminal_collapse()} aria-expanded={!collapsed} aria-controls="composerTerminalBody" onClick={collapse.onToggle}>{collapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</IconButton>}
          <IconButton variant="ghost" label={m.terminal_close()} onClick={onClose}><X aria-hidden="true" /></IconButton>
        </div>
      </div>
      <div id="composerTerminalBody" className="composer-terminal-body" hidden={collapsed}>{children}</div>
    </div>
  )
}
