import type { ReactNode } from 'react'
import { cn } from '../ui/cn'

export function PanelHead({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="panel-head flex items-center justify-between gap-2 min-h-11 px-3.5 py-2 border-b border-border text-[13px] font-semibold text-text normal-case tracking-[-.01em] shrink-0">
      <span className="min-w-0 truncate" title={typeof title === 'string' ? title : undefined}>{title}</span>
      {actions && <div className="panel-head-actions flex items-center gap-1 normal-case tracking-normal">{actions}</div>}
      {children}
    </div>
  )
}

/** Legacy `.panel-head-btn`: a 24px icon button whose label doubles as the CSS tooltip. Toolbar (`.main-view-actions`) and mobile-close variants keep their legacy rules. */
export const PANEL_HEAD_BTN = 'panel-head-btn has-tooltip inline-flex size-6 p-0 items-center justify-center border-0 bg-transparent rounded-(--btn-radius) text-muted cursor-pointer shrink-0 disabled:cursor-not-allowed disabled:opacity-50 transition-[background,color] duration-(--dur) ease-(--ease) hover:bg-(--panel-btn-hover-bg) hover:text-(--panel-btn-hover-fg) [&_svg]:block [&_svg]:size-3.5'

export function PanelHeadButton({ label, onClick, id, active, children, tooltipSide = 'bottom', className, disabled }: { label: string; onClick?: () => void; id?: string; active?: boolean; children: ReactNode; tooltipSide?: 'bottom' | 'bottom-right' | 'left'; className?: string; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} id={id} className={cn(PANEL_HEAD_BTN, `has-tooltip--${tooltipSide}`, active && 'active', className)} data-tooltip={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}
