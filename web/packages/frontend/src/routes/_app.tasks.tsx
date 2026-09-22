import { createFileRoute } from '@tanstack/react-router'
import { TasksSearchSchema } from '../contracts/url'
import { TasksRoute } from '../features/tasks/TasksPage'

export const Route = createFileRoute('/_app/tasks')({
  validateSearch: TasksSearchSchema,
  component: () => <TasksRoute />,
})
