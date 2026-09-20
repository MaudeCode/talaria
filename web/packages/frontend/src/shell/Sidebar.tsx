import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { cn } from '../ui/cn'
import { MobileNav } from './MobileNav'
import { closeMobileSidebar, setSidebarWidth, toggleSidebarCollapsed, useIsDesktop, useShellState } from './useShellState'

/**
 * Left column: on desktop a resizable panel next to the rail; on mobile a
 * full-width drawer with its own nav column. `panel` is the route's sidebar
 * content (session list, section menu, filters).
 */
export function Sidebar({ panel }: { panel: ReactNode }) {
  const { collapsed, mobileOpen, sidebarWidth } = useShellState()
  const isDesktop = useIsDesktop()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMobileSidebar() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  // Drag the right edge to resize (180..480px, persisted on release). The width is written straight to the DOM while
  // dragging: a React render per pointer move (and the panel's width transition) lags the pointer.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const el = ref.current
    const startW = el?.getBoundingClientRect().width ?? sidebarWidth
    const dir = document.documentElement.dir === 'rtl' ? -1 : 1
    let next = startW
    el?.setAttribute('data-resizing', '1')
    const move = (ev: PointerEvent) => { next = Math.min(480, Math.max(180, Math.round(startW + (ev.clientX - startX) * dir))); if (el) el.style.width = `${next}px` }
    const up = () => {
      el?.removeAttribute('data-resizing')
      setSidebarWidth(next)
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      {mobileOpen && !isDesktop && <div className="fixed inset-0 z-[190] bg-black/40 min-[641px]:hidden" aria-hidden="true" onClick={closeMobileSidebar} />}
      <aside
        ref={ref}
        className={cn('sidebar flex w-[300px] shrink-0 flex-col overflow-visible bg-transparent max-[641px]:bg-(--sidebar-bg) border-0 shadow-(--sidebar-shadow) min-[641px]:p-(--island-gap) min-[641px]:relative min-[901px]:shrink min-[901px]:min-w-[180px] max-[769px]:border-r max-[769px]:border-r-border max-[641px]:fixed max-[641px]:inset-y-0 max-[641px]:left-0 max-[641px]:w-screen max-[641px]:max-w-none max-[641px]:z-[200] max-[641px]:box-border max-[641px]:[transform:translateX(-100%)] max-[641px]:will-change-transform max-[641px]:pb-[calc(56px+env(safe-area-inset-bottom,0px))] max-[641px]:[&.mobile-open]:[transform:translateX(0)]', mobileOpen && !isDesktop && 'mobile-open')}
        style={isDesktop && !collapsed ? { width: sidebarWidth } : undefined}
        aria-hidden={!isDesktop && !mobileOpen ? true : undefined}
        data-mobile-open={mobileOpen ? '1' : undefined}
      >
        {!isDesktop && (
          <>
            <button type="button" className={cn(PANEL_HEAD_BTN, 'mobile-sidebar-close has-tooltip--bottom-right')} data-tooltip={m.close_menu()} aria-label={m.close_menu()} onClick={closeMobileSidebar}>
              <X size={18} aria-hidden="true" />
            </button>
            <MobileNav />
          </>
        )}
        {panel}
        <span className="seam seam-tr" aria-hidden="true" />
        <span className="seam seam-br" aria-hidden="true" />
        {isDesktop && !collapsed && (
          <div className="resize-handle absolute top-0 bottom-0 w-[5px] cursor-col-resize z-10 transition-[background] duration-150 hover:bg-accent" id="sidebarResize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={startResize} />
        )}
        {/* Edge tab on the sidebar's right edge (the mirror of the right panel's), reachable while collapsed. */}
        {isDesktop && (
          <button type="button" className="workspace-panel-edge-toggle has-tooltip" id="btnSidebarEdgeToggle" data-tooltip={collapsed ? m.sidebar_show() : m.sidebar_hide()} aria-label={collapsed ? m.sidebar_show() : m.sidebar_hide()} aria-expanded={!collapsed} onClick={() => toggleSidebarCollapsed()}>
            <span className="edge-tab-join edge-tab-join-top" aria-hidden="true" />
            <span className="edge-tab-join edge-tab-join-bottom" aria-hidden="true" />
            {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronLeft size={12} aria-hidden="true" />}
          </button>
        )}
      </aside>
    </>
  )
}

export function PanelHead({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="panel-head flex items-center justify-between gap-2 min-h-11 px-3.5 py-2 border-b border-border text-[13px] font-semibold text-text normal-case tracking-[-.01em] shrink-0">
      <span>{title}</span>
      {actions && <div className="panel-head-actions flex items-center gap-1 normal-case tracking-normal">{actions}</div>}
      {children}
    </div>
  )
}

/** Legacy `.panel-head-btn`: a 24px icon button whose label doubles as the CSS tooltip. Toolbar (`.main-view-actions`) and mobile-close variants keep their legacy rules. */
export const PANEL_HEAD_BTN = 'panel-head-btn has-tooltip inline-flex size-6 p-0 items-center justify-center border-0 bg-transparent rounded-(--btn-radius) text-muted cursor-pointer shrink-0 transition-[background,color] duration-(--dur) ease-(--ease) hover:bg-(--panel-btn-hover-bg) hover:text-(--panel-btn-hover-fg) [&_svg]:block [&_svg]:size-3.5'

export function PanelHeadButton({ label, onClick, id, active, children, tooltipSide = 'bottom', className }: { label: string; onClick?: () => void; id?: string; active?: boolean; children: ReactNode; tooltipSide?: 'bottom' | 'bottom-right' | 'left'; className?: string }) {
  return (
    <button type="button" id={id} className={cn(PANEL_HEAD_BTN, `has-tooltip--${tooltipSide}`, active && 'active', className)} data-tooltip={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}
