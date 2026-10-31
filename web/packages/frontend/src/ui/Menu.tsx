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
}

/** Menus share the Select popup layer above dialogs (z 1300/1301), so a menu opened inside a dialog takes clicks (TAL-1639). */
const POSITIONER = 'z-[1400] outline-none'
const POPUP = 'min-w-44 max-w-[min(92vw,360px)] overflow-y-auto rounded-lg border border-border bg-surface p-1 text-sm text-text shadow-md outline-none'

/** Base UI menu with token styling: keyboard navigation, typeahead, focus return, and escape are provided by Base UI. */
export function Menu({ trigger, children, side = 'bottom', align = 'start', open, onOpenChange, className, label, initialFocus }: MenuProps) {
  return (
    <BaseMenu.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className={POSITIONER}>
          <BaseMenu.Popup aria-label={label} onFocus={(event) => { if (event.target === event.currentTarget) initialFocus?.current?.focus() }} className={cn(POPUP, className)}>
            {children}
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
          <BaseContextMenu.Popup aria-label={label} className={cn(POPUP, className)}>
            {children}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  )
}

export function MenuItem({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) {
  return <BaseMenu.Item {...props} className={cn('flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-50', className as string | undefined)} />
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
