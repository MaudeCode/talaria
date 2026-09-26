import { createElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bot, BookOpen, Brain, FilePen, FileText, Globe, List, Search, Terminal, Wrench } from 'lucide-react'
import type { ToolKind } from '../../i18n/toolText'

const ICONS: Record<string, LucideIcon> = { shell: Terminal, read: FileText, list: List, search: Search, web: Globe, write: FilePen, skill: BookOpen, memory: Brain, delegate: Bot, unknown: Wrench }
export function toolIcon(kind: ToolKind): LucideIcon {
  return ICONS[kind] ?? Wrench
}

/** Icon component for a tool kind (module-level so render never creates components). */
export function ToolKindIcon({ kind }: { kind: ToolKind }) {
  const Icon = ICONS[kind] ?? Wrench
  return createElement(Icon, { size: 14, className: 'shrink-0 text-muted', 'aria-hidden': 'true' })
}
