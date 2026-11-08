import type { DecisionReview, DecisionReviewRef } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import type { ComposerNotice } from '../composer/ComposerNotices'

/** TAL-1964: a review's status word, on its page and its transcript card. */
export const reviewStatusLabel = (status: DecisionReview['status']) => ({ open: m.decision_review_status_open, submitted: m.decision_review_status_submitted, applied: m.decision_review_status_applied, cancelled: m.decision_review_status_cancelled })[status]()

/** TAL-1964: the composer chip for the session's open review, with Open. */
export function decisionReviewNotice(review: DecisionReviewRef, open: (reviewId: string) => void): ComposerNotice {
  return {
    id: 'decision-review', tone: 'info',
    content: <span className="truncate tabular-nums" data-decision-review={review.review_id}>{m.decision_review_chip({ answered: review.progress.answered, total: review.progress.total })}</span>,
    action: { label: m.decision_review_open(), run: () => open(review.review_id) },
  }
}
