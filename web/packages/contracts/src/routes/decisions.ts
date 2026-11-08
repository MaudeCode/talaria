import { oc } from '@orpc/contract'
import { z } from 'zod'
import { DecisionAnswerInputSchema, DecisionReviewSchema, DecisionReviewsSchema } from '../decisions.js'

const tags = ['decisions']
const ReviewId = z.object({ review_id: z.string() })

/** TAL-1963: decision reviews of the request's profile. Another profile's review, or one in a session the requester may not see, is 404. */
export const decisionsContract = { decisions: {
  list: oc.route({ method: 'GET', path: '/api/decisions', tags, summary: 'Open and submitted reviews, newest first.' }).output(DecisionReviewsSchema),
  get: oc.route({ method: 'GET', path: '/api/decisions/{review_id}', tags }).input(ReviewId).output(DecisionReviewSchema),
  answer: oc.route({ method: 'PUT', path: '/api/decisions/{review_id}/answers/{item_id}', tags, summary: 'Save one answer. A stale `expected_version` is 409 `answer_conflict`, and a `content_hash` the item no longer has is 409 `item_changed`, each with the stored `answer`; a closed review is 409 `review_closed`.' })
    .input(DecisionAnswerInputSchema).output(DecisionReviewSchema),
  submit: oc.route({ method: 'POST', path: '/api/decisions/{review_id}/submit', tags, summary: 'Hand the answers to the owning session as a one-line message. 400 `nothing_answered` when no item is answered.' })
    .input(ReviewId).output(DecisionReviewSchema),
  cancel: oc.route({ method: 'POST', path: '/api/decisions/{review_id}/cancel', tags }).input(ReviewId).output(DecisionReviewSchema),
} }
