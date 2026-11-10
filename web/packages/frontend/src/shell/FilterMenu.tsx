// Thin wrappers over Menu rows, in the layout bundle: rerendering them costs less than the compiler's memo code.
'use no memo'
import type { ComponentProps, ReactNode } from 'react'
import { Check, ListFilter } from 'lucide-react'
import { cn } from '../ui/cn'
import { MENU_CHOICE, Menu, MenuCheckboxItem, MenuRadioItem } from '../ui/Menu'
import { PANEL_HEAD_BTN } from './PanelHead'

const CHECK = <Check size={14} className="hidden shrink-0 group-data-[checked]:block" aria-hidden="true" />

/**
 * A page's one filter control (Chats TAL-1869, Kanban TAL-2087): an icon trigger that takes the accent state while any
 * filter differs from its default, with `label` saying so, over the caller's filter rows.
 */
export function FilterMenu({ label, filtered, className, children }: { label: string; filtered: boolean; className?: string; children: ReactNode }) {
  return (
    <Menu
      align="end"
      // A phone's heading sits mid-drawer: moving over the trigger shows every row, where a flip would scroll half of them away.
      collisionAvoidance={{ side: 'shift' }}
      trigger={<button type="button" className={cn(PANEL_HEAD_BTN, 'has-tooltip--bottom-right data-[popup-open]:after:hidden pointer-coarse:-my-2 pointer-coarse:size-11 data-[filtered]:bg-accent-bg data-[filtered]:text-accent-text data-[filtered]:hover:bg-accent-bg data-[filtered]:hover:text-accent-text', className)} data-filtered={filtered ? '' : undefined} data-tooltip={label} aria-label={label}><ListFilter size={16} aria-hidden="true" /></button>}
    >
      {children}
    </Menu>
  )
}

/** One choice of a filter's radio group, checked when chosen. */
export function FilterRadioItem({ value, disabled, title, children }: { value: string; disabled?: boolean; title?: string; children: ReactNode }) {
  return <MenuRadioItem value={value} disabled={!!disabled} closeOnClick title={title} className={cn(MENU_CHOICE, 'group data-[disabled]:opacity-50')}>{children}<span className="flex-1" />{CHECK}</MenuRadioItem>
}

/** An on/off filter row, checked while on; toggling keeps the menu open (design system §13). */
export function FilterCheckboxItem({ children, ...props }: Omit<ComponentProps<typeof MenuCheckboxItem>, 'className' | 'closeOnClick'>) {
  return <MenuCheckboxItem {...props} className={cn(MENU_CHOICE, 'group data-[disabled]:opacity-50')}>{children}<span className="flex-1" />{CHECK}</MenuCheckboxItem>
}
