import { createElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bot, BookOpen, Brain, FilePen, FileText, Globe, List, Search, Terminal, Wrench } from 'lucide-react'
import type { ToolKind } from '../../i18n/toolText'

/** Ported from the legacy `_toolActionKind`: classify a tool by its name for verbs and icons. */
export function toolKind(name: string | undefined): ToolKind {
  const n = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
  if (!n) return 'unknown'
  if (n === 'subagent_progress' || n === 'delegate_task') return 'delegate'
  if (n.includes('skill')) return 'skill'
  if (n.includes('memory')) return 'memory'
  if (n.includes('terminal') || n.includes('shell') || n.includes('command') || n.includes('process') || n === 'execute_code') return 'shell'
  if (n.includes('read') || n.includes('view') || n.includes('open') || n === 'vision_analyze') return 'read'
  if (n.includes('list') || n === 'todo') return 'list'
  if (n.includes('web') || n.includes('fetch') || n.includes('curl') || n.includes('extract') || n.includes('browse') || n.includes('navigate')) return 'web'
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'search'
  if (n.includes('write') || n.includes('patch') || n.includes('edit')) return 'write'
  return 'unknown'
}

const ICONS: Record<string, LucideIcon> = { shell: Terminal, read: FileText, list: List, search: Search, web: Globe, write: FilePen, skill: BookOpen, memory: Brain, delegate: Bot, unknown: Wrench }
export function toolIcon(kind: ToolKind): LucideIcon {
  return ICONS[kind] ?? Wrench
}

/** Icon component for a tool kind (module-level so render never creates components). */
export function ToolKindIcon({ kind }: { kind: ToolKind }) {
  const Icon = ICONS[kind] ?? Wrench
  return createElement(Icon, { size: 14, className: 'shrink-0 text-muted', 'aria-hidden': 'true' })
}

/** First-line target label from the call arguments (path, command, query...), redacting obvious secrets. */
export function toolTarget(name: string | undefined, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const kind = toolKind(name)
  const pick = (...keys: string[]) => { for (const k of keys) { const v = a[k]; if (typeof v === 'string' && v.trim()) return v } return '' }
  let raw = ''
  if (kind === 'shell') raw = pick('cmd', 'command')
  else if (kind === 'skill') raw = pick('name', 'skill')
  else if (kind === 'memory') raw = pick('target', 'name', 'action')
  else if (kind === 'read' || kind === 'write') raw = pick('path', 'file_path', 'file', 'target', 'name')
  else if (kind === 'search' || kind === 'web') raw = pick('query', 'pattern', 'url', 'uri')
  else raw = pick('cmd', 'command', 'path', 'file_path', 'file', 'uri', 'url', 'query', 'pattern', 'dir', 'task', 'name')
  const first = raw.split('\n')[0]?.trim() ?? ''
  return first.replace(/(api[_-]?key|token|secret|password)(["'=:\s]+)[^\s"']+/gi, '$1$2••••').slice(0, 200)
}
