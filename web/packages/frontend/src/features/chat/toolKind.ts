import { createElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AudioLines, Bot, BookOpen, Brain, FilePen, FileText, Globe, Image, List, Search, Terminal, Video, Wrench } from 'lucide-react'
import type { ToolKind } from '../../i18n/toolText'
import { Brandmark } from '../../shell/Brandmark'

const ICONS: Record<string, LucideIcon> = { shell: Terminal, read: FileText, list: List, search: Search, web: Globe, write: FilePen, skill: BookOpen, memory: Brain, delegate: Bot, image: Image, audio: AudioLines, video: Video, image_analysis: Image, video_analysis: Video, unknown: Wrench }
export function toolIcon(kind: ToolKind): LucideIcon {
  return ICONS[kind] ?? Wrench
}

/** Icon component for a tool kind (module-level so render never creates components). TAL-2317: Talaria's own tools carry its mark. */
export function ToolKindIcon({ kind }: { kind: ToolKind }) {
  if (kind === 'talaria') return createElement(Brandmark, { size: 14, className: 'shrink-0 text-muted', 'data-tool-brandmark': '' })
  const Icon = ICONS[kind] ?? Wrench
  return createElement(Icon, { size: 14, className: 'shrink-0 text-muted', 'aria-hidden': 'true' })
}
