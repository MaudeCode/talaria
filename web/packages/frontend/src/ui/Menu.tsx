import { Menu as BaseMenu } from '@base-ui/react/menu'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { useRef, useState, type ComponentProps, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
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
  /**
   * A search menu's input, inside `header` (TAL-1625). A keyboard or mouse opening focuses it; a touch or pen opening
   * focuses the list, so no software keyboard covers it, and a printable key typed there then goes to the input.
   */
  search?: RefObject<HTMLElement | null>
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

/**
 * TAL-1625: the opening focus of a menu with a search field. `pointer` is the last trigger press's pointer type, read
 * once per opening. Base UI's rule decides what opened it: a click with no click count came from the keyboard. A
 * keyboard or mouse opening focuses search (`search`); a keyboard opening also redirects Base UI's one first-row focus
 * (`row`). A touch or pen opening focuses the popup, so no software keyboard covers the list.
 */
interface OpeningFocus { pointer: string; search: boolean; row: boolean; popup: HTMLElement | null }

function openingFocus(s: OpeningFocus, search: RefObject<HTMLElement | null> | undefined, onOpenChange: MenuProps['onOpenChange']) {
  return {
    onTriggerPointerDown: (event: PointerEvent) => { s.pointer = event.pointerType },
    onOpenChange: (next: boolean, { event }: { event: Event }) => {
      const keyboard = next && (event instanceof KeyboardEvent || (event.type === 'click' && (event as MouseEvent).detail === 0))
      s.search = keyboard || (next && s.pointer === 'mouse')
      s.row = keyboard
      s.pointer = ''
      onOpenChange?.(next)
    },
    // Base UI's queued opening focus goes to the first tabbable element, the search field, and stands down once focus is
    // already inside, so the opening's own target is focused as the popup mounts. A re-render hands the same node to a
    // new callback, which leaves focus where the user put it.
    ref: (popup: HTMLElement | null) => {
      const input = search?.current
      if (!popup || popup === s.popup) return
      s.popup = popup
      if (input) (s.search ? input : popup).focus({ preventScroll: true })
    },
    // A later focus of the popup itself, or Base UI's first-row focus on a keyboard opening, goes back to search.
    onFocus: ({ target, currentTarget }: FocusEvent<HTMLElement>) => {
      const input = search?.current
      if (!input || !s.search || target === input) return
      if (target === currentTarget || s.row) input.focus()
      s.row = false
    },
    onKeyDown: (event: BaseUIEvent<KeyboardEvent<HTMLElement>>) => {
      s.row = false
      const input = search?.current
      const { key } = event
      if (!input || event.nativeEvent.isComposing) return
      if (event.target === input) {
        // From search, ArrowDown and ArrowUp reach the first and last row; a row's focus moves Base UI's highlight with it.
        const rows = event.currentTarget.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])')
        const row = key === 'ArrowDown' ? rows[0] : key === 'ArrowUp' ? rows[rows.length - 1] : null
        if (!row) return
        event.preventBaseUIHandler()
        event.preventDefault()
        row.focus()
      } else if (key.length === 1 && key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // A typed character (Space activates the row) moves focus before its input, so it lands in search, not typeahead.
        event.preventBaseUIHandler()
        input.focus()
      }
    },
  }
}

/** Base UI menu with token styling: keyboard navigation, typeahead, focus return, and escape are provided by Base UI. */
export function Menu({ trigger, children, side = 'bottom', align = 'start', open, onOpenChange, className, label, search, header }: MenuProps) {
  // One stable container for the opening's mutable focus state, read and written only by the handlers.
  const [state] = useState<OpeningFocus>(() => ({ pointer: '', search: false, row: false, popup: null }))
  const focus = openingFocus(state, search, onOpenChange)
  return (
    <BaseMenu.Root {...(open !== undefined ? { open } : {})} onOpenChange={focus.onOpenChange}>
      <BaseMenu.Trigger render={trigger} onPointerDown={focus.onTriggerPointerDown} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className={POSITIONER}>
          <BaseMenu.Popup ref={header ? focus.ref : revealRows} aria-label={label} onFocus={focus.onFocus} onKeyDown={focus.onKeyDown} className={cn(POPUP, header ? 'flex flex-col' : 'overflow-y-auto', className)}>
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
 * sets `-webkit-touch-callout: none`, so a long-press on a link trigger does not also open the browser's link callout;
 * `data-context-menu` restores the callout on links nested in it, which keep the browser's menu (base.css, TAL-1154).
 */
export function ContextMenu({ trigger, children, className, label }: Pick<MenuProps, 'trigger' | 'children' | 'className' | 'label'>) {
  // A browser may send a click when the long-press finger lifts; while that menu is open it must not also activate the trigger.
  const pressed = useRef(false)
  return (
    <BaseContextMenu.Root onOpenChange={(open, details) => { pressed.current = open && details.event.type === 'touchstart' }}>
      <BaseContextMenu.Trigger
        render={trigger}
        data-context-menu=""
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
