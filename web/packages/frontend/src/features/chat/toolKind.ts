import { createElement, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AppWindow, AudioLines, Bot, BookOpen, Brain, Cable, CalendarClock, FilePen, FileText, Globe, Image, List, MessageCircleQuestion, MessagesSquare, Monitor, Plug, Search, Server, SquareKanban, Terminal, Video, Wrench } from 'lucide-react'
import type { ToolKind } from '../../i18n/toolText'
import { Brandmark } from '../../shell/Brandmark'

const ICONS: Record<string, LucideIcon> = { shell: Terminal, read: FileText, list: List, search: Search, web: Globe, write: FilePen, skill: BookOpen, memory: Brain, delegate: Bot, image: Image, audio: AudioLines, video: Video, image_analysis: Image, video_analysis: Video, session: MessagesSquare, schedule: CalendarClock, connection: Plug, question: MessageCircleQuestion, kanban: SquareKanban, browser: AppWindow, computer: Monitor, mcp: Server, connector: Cable, unknown: Wrench }
export function toolIcon(kind: ToolKind): LucideIcon {
  return ICONS[kind] ?? Wrench
}

/**
 * Icon component for a tool kind (module-level so render never creates components). TAL-2317: Talaria's own tools carry its
 * mark. TAL-2330: a connector call draws its app's catalog logo, rounded like Settings › Connectors, and its kind's icon when
 * there is none or it fails to load.
 */
export function ToolKindIcon({ kind, logoUrl }: { kind: ToolKind; logoUrl?: string | null | undefined }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (kind === 'talaria') return createElement(Brandmark, { size: 14, className: 'shrink-0 text-muted', 'data-tool-brandmark': '' })
  if (logoUrl && failed !== logoUrl) return createElement('img', { src: logoUrl, alt: '', className: 'size-4 shrink-0 rounded', 'data-tool-logo': '', onError: () => { setFailed(logoUrl) } })
  const Icon = ICONS[kind] ?? Wrench
  return createElement(Icon, { size: 14, className: 'shrink-0 text-muted', 'aria-hidden': 'true' })
}
