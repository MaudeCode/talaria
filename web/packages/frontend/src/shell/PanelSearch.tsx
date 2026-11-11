import { useEffect, useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { cn } from '../ui/cn'
import { PANEL_HEAD_BTN_COARSE, PanelHead, PanelHeadButton } from './PanelHead'

type FieldProps = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'ref' | 'className' | 'type' | 'onBlur' | 'title'> & { id: string; placeholder: string }

/**
 * TAL-2184: a sidebar panel's search. Closed, its head shows a magnifying glass before `actions`; open, the field and an
 * `x` button take the place of the title and the glass on the column's own surface, leaving `actions` usable. `shell.css`
 * owns the layout and the motion (`.panel-search`). The `x`, Escape, or focus leaving the empty field clears and closes it;
 * focus then returns to the glass unless the user moved it to another control. `clearLabel` adds a button that clears the
 * text and keeps the field open.
 */
export function PanelSearch({ title, actions, open, onOpenChange, value, onValueChange, clearLabel, className, onKeyDown, ...field }: {
  title: ReactNode
  actions?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  onValueChange: (value: string) => void
  clearLabel?: string
  /** Extra classes for the field's bar, for the panel's own input styles. */
  className?: string
} & FieldProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const shown = useRef(open)
  useEffect(() => {
    if (open === shown.current) return
    shown.current = open
    if (open) { input.current?.focus(); return }
    const focused = document.activeElement
    if (!focused || focused === document.body || bar.current?.contains(focused)) trigger.current?.focus()
  }, [open])
  const close = () => { onValueChange(''); onOpenChange(false) }
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    close()
  }
  return (
    <div className="panel-search" data-open={open ? '' : undefined} data-actions={actions ? '' : undefined}>
      <PanelHead
        title={title}
        actions={(
          <>
            <PanelHeadButton ref={trigger} label={m.search()} tooltipSide="left" className={cn('panel-search-trigger', PANEL_HEAD_BTN_COARSE)} aria-expanded={open} aria-controls={field.id} onClick={() => onOpenChange(true)}>
              <Search size={16} aria-hidden="true" />
            </PanelHeadButton>
            {actions}
          </>
        )}
      />
      <div ref={bar} className={cn('panel-search-bar sidebar-search', className)} inert={!open}>
        <div className="panel-search-field">
          <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
          <input
            ref={input}
            type="search"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            {...field}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={keyDown}
            onBlur={(e) => { if (open && !value && !bar.current?.contains(e.relatedTarget)) close() }}
          />
          {clearLabel && value && (
            <button type="button" className="sidebar-search-clear" aria-label={clearLabel} onClick={() => { onValueChange(''); input.current?.focus() }}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Pressing keeps focus in the field, so the press itself never counts as focus leaving it. */}
        <PanelHeadButton label={m.close()} tooltipSide="left" className={PANEL_HEAD_BTN_COARSE} onMouseDown={(e) => e.preventDefault()} onClick={close}>
          <X size={16} aria-hidden="true" />
        </PanelHeadButton>
      </div>
    </div>
  )
}
