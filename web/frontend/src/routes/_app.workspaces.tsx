import { createFileRoute } from '@tanstack/react-router'
import { HubRoute } from '../features/hub/HubRoute'

export const Route = createFileRoute('/_app/workspaces')({
  component: () => <HubRoute panel="workspaces" />,
})
