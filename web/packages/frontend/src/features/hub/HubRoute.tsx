import type { ReactNode } from 'react'
import type { PanelId } from '../../shell/nav'
import { useLocale } from '../../i18n/useLocale'
import { KanbanPage } from '../kanban/KanbanPage'
import { SkillsPage } from '../skills/SkillsPage'
import { MemoryPage } from '../memory/MemoryPage'
import { WorkspacesPage } from '../workspaces/WorkspacesPage'
import { ProfilesPage } from '../profiles/ProfilesPage'
import { TodosPage } from '../todos/TodosPage'
import { InsightsPage } from '../insights/InsightsPage'
import { LogsPage } from '../logs/LogsPage'

export type HubPanel = Exclude<PanelId, 'chat' | 'settings' | 'tasks' | 'groups'>

const PAGES: Record<HubPanel, () => ReactNode> = {
  kanban: () => <KanbanPage />,
  skills: () => <SkillsPage />,
  memory: () => <MemoryPage />,
  workspaces: () => <WorkspacesPage />,
  profiles: () => <ProfilesPage />,
  todos: () => <TodosPage />,
  insights: () => <InsightsPage />,
  logs: () => <LogsPage />,
}

/** Hub page: the collection is the main view. */
export function HubRoute({ panel }: { panel: HubPanel }) {
  useLocale()
  return PAGES[panel]()
}
