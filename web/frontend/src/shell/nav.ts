import { CalendarCheck, Columns3, FileText, GraduationCap, LayoutDashboard, ListChecks, MessageSquare, Settings, TrendingUp, UserRound, FolderOpen, Brain, type LucideIcon } from 'lucide-react'
import { m } from '../paraglide/messages.js'

export type PanelId = 'chat' | 'tasks' | 'kanban' | 'skills' | 'memory' | 'workspaces' | 'profiles' | 'todos' | 'insights' | 'logs' | 'settings'

export interface NavItem {
  id: PanelId
  to: string
  icon: LucideIcon
  label: () => string
}

/** Rail and mobile nav entries in legacy order. `chat` and `settings` are fixed; the rest can be reordered or hidden. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'chat', to: '/', icon: MessageSquare, label: () => m.tab_chat() },
  { id: 'tasks', to: '/tasks', icon: CalendarCheck, label: () => m.tab_tasks() },
  { id: 'kanban', to: '/kanban', icon: Columns3, label: () => m.tab_kanban() },
  { id: 'skills', to: '/skills', icon: GraduationCap, label: () => m.tab_skills() },
  { id: 'memory', to: '/memory', icon: Brain, label: () => m.tab_memory() },
  { id: 'workspaces', to: '/workspaces', icon: FolderOpen, label: () => m.tab_workspaces() },
  { id: 'profiles', to: '/profiles', icon: UserRound, label: () => m.tab_profiles() },
  { id: 'todos', to: '/todos', icon: ListChecks, label: () => m.tab_todos() },
  { id: 'insights', to: '/insights', icon: TrendingUp, label: () => m.tab_insights() },
  { id: 'logs', to: '/logs', icon: FileText, label: () => m.tab_logs() },
  { id: 'settings', to: '/settings', icon: Settings, label: () => m.tab_settings() },
]
export const DASHBOARD_ICON = LayoutDashboard
export const FIXED_TABS: ReadonlySet<PanelId> = new Set(['chat', 'settings'])

/** Apply persisted order and hidden set the way the legacy boot script did: fixed tabs stay, unknown ids are dropped, missing ids append. */
export function orderedNav(order: string[] | null, hidden: string[] | null): { visible: NavItem[]; hiddenIds: Set<PanelId> } {
  const byId = new Map(NAV_ITEMS.map((n) => [n.id, n]))
  const movable = NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map((n) => n.id)
  const cleanOrder = (order ?? []).map((s) => s.trim()).filter((id): id is PanelId => byId.has(id as PanelId) && !FIXED_TABS.has(id as PanelId))
  const final: PanelId[] = []
  for (const id of cleanOrder) if (!final.includes(id)) final.push(id)
  for (const id of movable) if (!final.includes(id)) final.push(id)
  const hiddenIds = new Set((hidden ?? []).map((s) => s.trim()).filter((id): id is PanelId => byId.has(id as PanelId) && !FIXED_TABS.has(id as PanelId)))
  const chat = byId.get('chat')
  const settings = byId.get('settings')
  const visible: NavItem[] = []
  if (chat) visible.push(chat)
  for (const id of final) {
    const item = byId.get(id)
    if (item && !hiddenIds.has(id)) visible.push(item)
  }
  if (settings) visible.push(settings)
  return { visible, hiddenIds }
}

export function panelForPath(pathname: string): PanelId {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/' || p.startsWith('/session/')) return 'chat'
  const seg = p.split('/')[1] ?? ''
  const hit = NAV_ITEMS.find((n) => n.id === seg)
  return hit ? hit.id : 'chat'
}
