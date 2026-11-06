import type { LucideIcon } from 'lucide-react'

export const SIDEBAR_ICON_PROPS = { size: 18, strokeWidth: 1.5, 'aria-hidden': true } as const

/** A sidebar row's icon, its label beside it, and the caption under it on the rail (`shell.css` shows one or the other). */
export function SidebarRowContent({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return <><Icon {...SIDEBAR_ICON_PROPS} /><span className="sidebar-row-label min-w-0 truncate">{label}</span><span className="sidebar-row-caption" data-caption={label} aria-hidden="true" /></>
}
