import { createFileRoute } from '@tanstack/react-router'
import { KanbanSearchSchema } from '../contracts/url'
import { KanbanRoute } from '../features/kanban/KanbanPage'

export const Route = createFileRoute('/_app/kanban')({
  validateSearch: KanbanSearchSchema,
  component: () => <KanbanRoute />,
})
