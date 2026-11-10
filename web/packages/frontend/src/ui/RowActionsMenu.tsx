import { MoreHorizontal } from 'lucide-react'
import { IconButton } from './Button'
import { Menu, rowActionItems, type RowAction } from './Menu'

/** A row's visible actions trigger: a kebab opening the same items as its `RowContextMenu`, for keyboard and assistive-technology users. */
export function RowActionsMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  if (actions.length === 0) return null
  return (
    <Menu label={label} align="end" trigger={<IconButton variant="ghost" label={label}><MoreHorizontal aria-hidden="true" /></IconButton>}>
      {rowActionItems(actions)}
    </Menu>
  )
}

/**
 * TAL-2131 (§12): a row's actions as symbol buttons, the same list its `RowContextMenu` shows with words. Each takes its
 * `icon`; a `danger` action is the `danger` variant. The label is the accessible name and the tooltip.
 */
export function RowActionButtons({ actions }: { actions: (RowAction & { icon: NonNullable<RowAction['icon']> })[] }) {
  if (actions.length === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-1">
      {actions.map(({ label, run, disabled, busy, danger, expanded, icon: Icon }) => (
        <IconButton key={label} variant={danger ? 'danger' : 'default'} label={label} onClick={run} disabled={disabled === true || busy === true} aria-busy={busy === true || undefined} aria-expanded={expanded}>
          <Icon aria-hidden="true" />
        </IconButton>
      ))}
    </div>
  )
}
