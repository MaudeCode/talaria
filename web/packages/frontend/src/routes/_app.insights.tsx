import { createFileRoute } from '@tanstack/react-router'
import { InsightsSearchSchema } from '../contracts/url'
import { HubRoute } from '../features/hub/HubRoute'

export const Route = createFileRoute('/_app/insights')({
  validateSearch: InsightsSearchSchema,
  component: () => <HubRoute panel="insights" />,
})
