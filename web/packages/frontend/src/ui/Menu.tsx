import { Menu as BaseMenu } from '@base-ui/react/menu'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import type { ComponentProps, ReactElement, ReactNode, RefObject } from 'react'
import { cn } from './cn'

export interface MenuProps {
  trigger: ReactElement
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  label?: string
  /** A search menu keeps its input focused when the opening popup receives delayed focus. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Stays pinned above the scrolling rows, such as a search field (TAL-1131). */
  header?: ReactNode
}

/** Menus share the Select popup layer above dialogs (z 1300/1301), so a menu opened inside a dialog takes clicks (TAL-1639). */
const POSITIONER = 'z-[1400] outline-none'
// Base UI's available height keeps a long menu inside a short viewport, where it scrolls; a caller lowers it with --menu-max-height.
const POPUP = 'min-w-44 max-w-[min(92vw,360px)] max-h-[min(var(--menu-max-height,100vh),var(--available-height))] rounded-lg border border-border bg-surface p-1 text-sm text-text shadow-md outline-none'

/** Scrolls `row` into `scroller` unless it is already fully inside; `center` places it mid-list. */
function revealRow(scroller: HTMLElement, row: HTMLElement, center: boolean) {
  const box = scroller.getBoundingClientRect()
  const r = row.getBoundingClientRect()
  if (r.top >= box.top && r.bottom <= box.bottom) return
  scroller.scrollTop += center ? r.top - box.top - (box.height - r.height) / 2 : r.top < box.top ? r.top - box.top : r.bottom - box.bottom
}

/**
 * TAL-1131: whenever the open menu's scrolling area takes or changes its size, the highlighted row stays in view, or
 * else the checked choice is centred, so a deep selection is visible on open and after a resize.
 */
function revealRows(scroller: HTMLElement | null) {
  if (!scroller || typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(() => {
    const highlighted = scroller.querySelector<HTMLElement>('[data-highlighted]')
    const row = highlighted ?? scroller.querySelector<HTMLElement>('[aria-checked="true"]')
    if (row) revealRow(scroller, row, !highlighted)
  })
  observer.observe(scroller)
  return () => { observer.disconnect() }
}

/** Base UI menu with token styling: keyboard navigation, typeahead, focus return, and escape are provided by Base UI. */
export function Menu({ trigger, children, side = 'bottom', align = 'start', open, onOpenChange, className, label, initialFocus, header }: MenuProps) {
  return (
    <BaseMenu.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className={POSITIONER}>
          <BaseMenu.Popup ref={header ? undefined : revealRows} aria-label={label} onFocus={(event) => { if (event.target === event.currentTarget) initialFocus?.current?.focus() }} className={cn(POPUP, header ? 'flex flex-col' : 'overflow-y-auto', className)}>
            {header ? <>{header}<div ref={revealRows} className="min-h-0 overflow-y-auto">{children}</div></> : children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

/** The same menu opened by right-click or long-press on `trigger`, which keeps its own click behaviour. */
export function ContextMenu({ trigger, children, className, label }: Pick<MenuProps, 'trigger' | 'children' | 'className' | 'label'>) {
  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger render={trigger} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner className={POSITIONER}>
          <BaseContextMenu.Popup aria-label={label} className={cn(POPUP, 'overflow-y-auto', className)}>
            {children}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  )
}

/** One row look for action and choice items: compact under a mouse, a 44 px target under a coarse pointer (TAL-1626). */
export const MENU_ROW = 'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-hover pointer-coarse:min-h-11'

export function MenuItem({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) {
  return <BaseMenu.Item {...props} className={cn(MENU_ROW, 'data-[disabled]:opacity-50', className as string | undefined)} />
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="my-1 h-px bg-border" />
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return <BaseMenu.GroupLabel className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</BaseMenu.GroupLabel>
}

export const MenuGroup = BaseMenu.Group
export const MenuCheckboxItem = BaseMenu.CheckboxItem
export const MenuRadioGroup = BaseMenu.RadioGroup
export const MenuRadioItem = BaseMenu.RadioItem
