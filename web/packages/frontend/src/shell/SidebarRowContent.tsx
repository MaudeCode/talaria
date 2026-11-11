import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../ui/cn'

export const SIDEBAR_ICON_PROPS = { size: 18, strokeWidth: 1.5, 'aria-hidden': true } as const

/**
 * A sidebar row's icon, its label beside it, and the caption under it on the rail (`shell.css` shows one or the other).
 * The caption is the label unless the row passes a short form that fits the rail (TAL-2183).
 */
export function SidebarRowContent({ icon: Icon, label, caption = label }: { icon: LucideIcon; label: string; caption?: string | undefined }) {
  return <><Icon {...SIDEBAR_ICON_PROPS} /><span className="sidebar-row-label min-w-0 truncate">{label}</span><span className="sidebar-row-caption" data-caption={caption} aria-hidden="true" /></>
}

/** Content only the expanded column shows: `shell.css` folds it to no height on the rail, where it is inert. */
export function SidebarFold({ rail, className, children }: { rail: boolean; className?: string; children: ReactNode }) {
  return <div className={cn('sidebar-fold grid flex-none', className)} inert={rail}><div className="min-h-0 overflow-hidden">{children}</div></div>
}
