import { createFileRoute } from '@tanstack/react-router'
import { HubRoute } from '../features/hub/HubRoute'

export const Route = createFileRoute('/_app/logs')({
  component: () => <HubRoute panel="logs" />,
})
