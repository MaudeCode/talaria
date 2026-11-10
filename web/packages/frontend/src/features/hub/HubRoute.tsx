import type { ReactNode } from 'react'
import type { PanelId } from '../../shell/nav'
import { useLocale } from '../../i18n/useLocale'
import { KanbanPage } from '../kanban/KanbanPage'
import { SkillsPage } from '../skills/SkillsPage'
import { MemoryPage } from '../memory/MemoryPage'
import { TodosPage } from '../todos/TodosPage'
import { DecisionsPage } from '../decisions/DecisionsPage'
import { InsightsPage } from '../insights/InsightsPage'

export type HubPanel = Exclude<PanelId, 'chat' | 'settings' | 'tasks' | 'groups'>

const PAGES: Record<HubPanel, () => ReactNode> = {
  kanban: () => <KanbanPage />,
  skills: () => <SkillsPage />,
  memory: () => <MemoryPage />,
  todos: () => <TodosPage />,
  decisions: () => <DecisionsPage />,
  insights: () => <InsightsPage />,
}

/** Hub page: the collection is the main view. */
export function HubRoute({ panel }: { panel: HubPanel }) {
  useLocale()
  return PAGES[panel]()
}
