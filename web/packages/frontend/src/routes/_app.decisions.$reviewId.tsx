import { createFileRoute } from '@tanstack/react-router'
import { DecisionsSearchSchema } from '../contracts/url'
import { DecisionReviewPage } from '../features/decisions/DecisionReviewPage'

export const Route = createFileRoute('/_app/decisions/$reviewId')({
  validateSearch: DecisionsSearchSchema,
  component: DecisionsRoute,
})

function DecisionsRoute() {
  const { reviewId } = Route.useParams()
  return <DecisionReviewPage reviewId={reviewId} search={Route.useSearch()} />
}
