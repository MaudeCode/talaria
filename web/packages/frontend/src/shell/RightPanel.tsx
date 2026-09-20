/**
 * The right-hand island of the layout row (legacy `.rightpanel`): edge tab,
 * drag-to-resize left edge, corner seams, a title bar and a scrolling body.
 * It renders itself into the shell's `#rightpanelSlot`, so any route can put
 * content there (the chat workspace browser, a cron run, a preview).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { readPersisted, writePersisted } from '../lib/persisted'

const WIDTH_KEY = 'hermes-webui-workspace-panel-width'

export interface RightPanelProps {
  open: boolean
  /** Edge tab that collapses/expands the panel in place; omit it for panels that simply unmount on close. */
  onToggle?: () => void
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  /** Extra icon buttons before the close button. */
  actions?: ReactNode
  label: string
  children: ReactNode
  /** Marks the content kind on the `aside` for styling/tests. */
  panelId: string
}

export function RightPanel({ open, onToggle, onClose, title, subtitle, actions, label, children, panelId }: RightPanelProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time DOM lookup after the shell has committed its slot
  useEffect(() => { setSlot(document.getElementById('rightpanelSlot')) }, [])
  // The html attribute drives the collapse CSS (workspace.css) and the seam rules (shell.css).
  useEffect(() => {
    document.documentElement.dataset.workspacePanel = open ? 'open' : 'closed'
    return () => { document.documentElement.dataset.workspacePanel = 'closed' }
  }, [open])
  // Drag the left edge to resize (legacy initResize on #rightpanelResize: 180..1200px, persisted, shared by every panel).
  const panel = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(() => Number(readPersisted(WIDTH_KEY)) || 300)
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panel.current?.getBoundingClientRect().width ?? width
    let next = startW
    const el = panel.current
    // Write the width straight to the DOM while dragging: a React render per pointer move (and the panel's width transition) lags the pointer.
    el?.setAttribute('data-resizing', '1')
    const move = (ev: PointerEvent) => { next = Math.round(Math.min(1200, Math.max(180, startW - (ev.clientX - startX)))); if (el) el.style.width = `${next}px` }
    const up = () => {
      el?.removeAttribute('data-resizing')
      setWidth(next)
      writePersisted(WIDTH_KEY, String(Math.round(next)))
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  if (!slot) return null
  return createPortal(
    <aside ref={panel} style={{ width }} className={cn('rightpanel flex w-[300px] shrink-0 flex-col p-(--island-gap) max-[768px]:p-0 max-[768px]:bg-(--sidebar-bg) max-[768px]:absolute max-[768px]:inset-y-0 max-[768px]:right-0 max-[768px]:z-[150] max-[768px]:w-[min(100vw,360px)] max-[768px]:shadow-md', open && 'mobile-open')} aria-label={label} data-panel={panelId}>
      {/* The edge tab rides on the panel's left edge, so it slides with the panel and sits flush with the screen when closed. */}
      {onToggle && (
        <button type="button" className="workspace-panel-edge-toggle has-tooltip has-tooltip--left" id="btnWorkspacePanelEdgeToggle" data-tooltip={open ? m.workspace_panel_hide() : m.workspace_panel_show()} aria-label={open ? m.workspace_panel_hide() : m.workspace_panel_show()} aria-expanded={open} onClick={onToggle}>
          <span className="edge-tab-join edge-tab-join-top" aria-hidden="true" />
          <span className="edge-tab-join edge-tab-join-bottom" aria-hidden="true" />
          {open ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronLeft size={12} aria-hidden="true" />}
        </button>
      )}
      <div className="resize-handle absolute top-0 bottom-0 w-[5px] cursor-col-resize z-10 transition-[background] duration-150 hover:bg-accent" id="rightpanelResize" role="separator" aria-orientation="vertical" aria-label={label} onPointerDown={startResize} />
      <span className="seam seam-tl" aria-hidden="true" />
      <span className="seam seam-bl" aria-hidden="true" />
      <div className="rightpanel-body flex flex-1 min-h-0 flex-col overflow-hidden">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text">{title}</div>
            {subtitle && <div className="truncate font-mono text-[10px] text-muted">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-0.5">
            {actions}
            <IconButton label={m.close_menu()} className="h-7 w-7" onClick={onClose}><X size={14} aria-hidden="true" /></IconButton>
          </div>
        </div>
        {children}
      </div>
    </aside>,
    slot,
  )
}
