import { Menu as BaseMenu } from '@base-ui/react/menu'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { useRef, type ComponentProps, type ReactElement, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
import type { BaseUIEvent } from '@base-ui/react/types'
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

/**
 * Links nested in a trigger, including Markdown links and code-block controls that Streamdown renders as buttons
 * (TAL-1154).
 */
const NESTED_NATIVE = 'a[href], [data-streamdown="link"], [data-streamdown="code-block-actions"], [data-streamdown="mermaid-block-actions"]'

/** TAL-699: text fields, a selection reaching into the trigger, and links nested in it keep the browser's own menu. */
function wantsNativeMenu(trigger: Element, target: Element): boolean {
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true
  const link = target.closest(NESTED_NATIVE)
  if (link && link !== trigger && trigger.contains(link)) return true
  const selection = trigger.ownerDocument.getSelection()
  return !!selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(trigger)
}

/** Runs before Base UI's trigger handlers and skips them when the event belongs to the browser or to another surface. */
function passThrough(event: BaseUIEvent<SyntheticEvent>) {
  const trigger = event.currentTarget
  const target = event.target
  // A portalled popup inside the trigger's React tree, such as a nested kebab menu, bubbles here without being inside it.
  if (!(target instanceof Element) || !trigger.contains(target)) { event.preventBaseUIHandler(); return }
  if (!wantsNativeMenu(trigger, target)) return
  event.preventBaseUIHandler()
  // Base UI also cancels the native menu from a document listener; stop the event before it gets there.
  if (event.type === 'contextmenu') event.nativeEvent.stopPropagation()
}

/**
 * The same menu opened by right-click or long-press on `trigger`, which keeps its own click behaviour. Base UI's trigger
 * sets `-webkit-touch-callout: none`, so a long-press on a link trigger does not also open the browser's link callout.
 */
export function ContextMenu({ trigger, children, className, label }: Pick<MenuProps, 'trigger' | 'children' | 'className' | 'label'>) {
  // A browser may send a click when the long-press finger lifts; while that menu is open it must not also activate the trigger.
  const pressed = useRef(false)
  return (
    <BaseContextMenu.Root onOpenChange={(open, details) => { pressed.current = open && details.event.type === 'touchstart' }}>
      <BaseContextMenu.Trigger
        render={trigger}
        onContextMenu={passThrough}
        onTouchStart={passThrough}
        onClickCapture={(event) => { if (pressed.current) { pressed.current = false; event.preventDefault(); event.stopPropagation() } }}
      />
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
