import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { DecisionReviewList } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { HubPage } from '../../shell/AppShell'
import { Badge } from '../../ui/Badge'
import { Row, RowList } from '../../ui/List'
import { RowContextMenu } from '../../ui/Menu'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { reviewStatusLabel } from './reviewStatus'

const emptyLabel = (reason: NonNullable<DecisionReviewList['empty']>) => reason === 'closed' ? m.decisions_empty_closed() : m.decisions_empty_none()

/** TAL-1966: the profile's decision reviews in the server's order; a row opens its review, its session title the chat. */
export function DecisionsPage() {
  const navigate = useNavigate()
  const query = useQuery({ queryKey: keys.decisionReviews, queryFn: ({ signal }) => api.fetchDecisionReviews(signal) })
  const reviews = query.data?.reviews ?? []
  const openReview = (reviewId: string) => { void navigate({ to: '/decisions/$reviewId', params: { reviewId }, search: {} }) }
  const openChat = (sessionId: string) => { void navigate({ to: '/session/$sessionId', params: { sessionId } }) }
  return (
    <HubPage title={m.tab_decisions()}>
      {query.isPending && <LoadingState />}
      {query.isError && <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />}
      {query.data?.empty && <EmptyState>{emptyLabel(query.data.empty)}</EmptyState>}
      {reviews.length > 0 && (
        <section data-section="decisions">
          <RowList aria-label={m.decisions_list()}>
            {reviews.map((review) => (
              <RowContextMenu key={review.review_id} label={m.decisions_row_menu()} actions={[{ label: m.decision_review_open(), run: () => openReview(review.review_id) }, { label: m.decisions_open_chat(), run: () => openChat(review.session_id) }]} trigger={
                <Row data-decision-review={review.review_id} data-review-status={review.status}>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <Link to="/decisions/$reviewId" params={{ reviewId: review.review_id }} search={{}} className="min-w-0 truncate text-sm font-semibold text-text no-underline hover:underline">{review.title}</Link>
                      <Badge tone="border-border text-muted">{reviewStatusLabel(review.status)}</Badge>
                      <span className="ml-auto text-xs tabular-nums text-muted">{m.decision_review_progress({ answered: review.progress.answered, total: review.progress.total })}</span>
                    </div>
                    <Link to="/session/$sessionId" params={{ sessionId: review.session_id }} className="min-w-0 truncate text-xs text-muted no-underline hover:text-text" aria-label={`${m.decisions_open_chat()}: ${review.session_title ?? m.untitled()}`}>{review.session_title ?? m.untitled()}</Link>
                  </div>
                </Row>} />
            ))}
          </RowList>
        </section>
      )}
    </HubPage>
  )
}
