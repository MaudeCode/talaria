import { MoreHorizontal } from 'lucide-react'
import { IconButton } from './Button'
import { Menu, rowActionItems, type RowAction } from './Menu'

/** A row's visible actions trigger: a kebab opening the same items as its `RowContextMenu`, for keyboard and assistive-technology users. */
export function RowActionsMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  if (actions.length === 0) return null
  return (
    <Menu label={label} align="end" trigger={<IconButton label={label} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"><MoreHorizontal size={16} aria-hidden="true" /></IconButton>}>
      {rowActionItems(actions)}
    </Menu>
  )
}
