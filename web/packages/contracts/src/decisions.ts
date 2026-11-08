import { z } from 'zod'

/**
 * TAL-1963: a decision review an agent hands the user. The server owns the order, progress, freshness, `needs_review`,
 * `submit` and every outcome; clients render these fields. The agent writes a review with the `harness` toolset's
 * `decision_review_put`, the user answers on `/decisions/<review_id>`, and the agent reads the answers back.
 */
export const DECISION_LIMITS = {
  items: 100, choicesMin: 2, choicesMax: 4, sources: 20,
  id: 64, title: 200, intro: 4000, question: 2000, explanation: 8000, example: 4000, current: 4000, recommendation: 4000,
  label: 200, effect: 1000, detail: 8000, source: 2000, notes: 8000, outcomeNote: 2000,
} as const

export const DecisionReviewIdSchema = z.string().regex(/^dr_[0-9a-f]{8}$/)
export const DecisionReviewStatusSchema = z.enum(['open', 'submitted', 'applied', 'cancelled'])
export const DecisionOutcomeStateSchema = z.enum(['applied', 'kept', 'blocked', 'reviewed', 'planned'])

export const DecisionChoiceSchema = z.object({ value: z.string(), label: z.string(), effect: z.string() })
export const DecisionTechnicalSchema = z.object({ detail: z.string().nullable(), sources: z.array(z.string()) })

/** What the agent writes for one item; the server validates counts, uniqueness and lengths and names the failed condition. */
export const DecisionItemInputSchema = z.object({
  id: z.string(), title: z.string(), question: z.string(), explanation: z.string(), example: z.string().nullable().optional(),
  current: z.string(), recommendation: z.string(), recommended_choice: z.string(), choices: z.array(DecisionChoiceSchema),
  technical: z.object({ detail: z.string().nullable().optional(), sources: z.array(z.string()).optional() }).nullable().optional(),
})
export type DecisionItemInput = z.infer<typeof DecisionItemInputSchema>

/**
 * The user's answer exactly as it was shown: `label` and `effect` are the chosen choice's at the time of answering, so a
 * later revision of the item never changes them. A deferred or custom answer has no choice (`value`, `label` and
 * `effect` null); a custom answer's text is `notes`. `version` starts at 1 and grows with every save.
 */
export const DecisionAnswerSchema = z.object({
  value: z.string().nullable(), label: z.string().nullable(), effect: z.string().nullable(), notes: z.string(),
  deferred: z.boolean(), custom: z.boolean(), version: z.number().int().positive(), updated_at: z.number(),
})
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>

export const DecisionOutcomeSchema = z.object({ state: DecisionOutcomeStateSchema, note: z.string().nullable() })

/**
 * One decision. `fresh` compares this item with the review's previous revision: `new` (not in it), `changed` (its
 * `content_hash` differs) or `carried`. `needs_review` is an answer given to different content than the item now has.
 * `answer_version` (TAL-1964) counts every save and clear of the item's answer, 0 before the first; it never goes back,
 * so a cleared answer's version is not reused.
 */
export const DecisionItemSchema = z.object({
  id: z.string(), title: z.string(), question: z.string(), explanation: z.string(), example: z.string().nullable(),
  current: z.string(), recommendation: z.string(), recommended_choice: z.string(), choices: z.array(DecisionChoiceSchema).min(2).max(4),
  technical: DecisionTechnicalSchema, content_hash: z.string(), fresh: z.enum(['new', 'changed', 'carried']), needs_review: z.boolean(),
  answer: DecisionAnswerSchema.nullable(), answer_version: z.number().int().nonnegative(), outcome: DecisionOutcomeSchema.nullable(),
})
export type DecisionItem = z.infer<typeof DecisionItemSchema>

/** `answered` counts chosen and custom answers, `deferred` deferred ones; an answered or deferred item may also need review. */
export const DecisionProgressSchema = z.object({
  total: z.number().int().nonnegative(), answered: z.number().int().nonnegative(), deferred: z.number().int().nonnegative(), needs_review: z.number().int().nonnegative(),
})
export type DecisionProgress = z.infer<typeof DecisionProgressSchema>

/** Submit is allowed on an open review with at least one answered item; otherwise `reason` says why. */
export const DecisionSubmitSchema = z.object({ allowed: z.boolean(), reason: z.enum(['nothing_answered', 'not_open']).nullable() })

/**
 * TAL-1964: the answers view's filters, item ids in display order. `new` holds the new and changed items, `pending` the
 * items with no answer; the view's `all` filter is `items`.
 */
export const DecisionFiltersSchema = z.object({ new: z.array(z.string()), pending: z.array(z.string()) })
export const DECISION_FILTERS = ['all', 'new', 'pending'] as const
export type DecisionFilter = (typeof DECISION_FILTERS)[number]

/**
 * `items` are in display order: new and changed items first, each group in the agent's order. `next_item_id` (TAL-1964)
 * is the item Continue opens: the first one with no answer, a deferred answer or an answer that needs review; null when
 * none is left.
 */
export const DecisionReviewSchema = z.object({
  review_id: DecisionReviewIdSchema, session_id: z.string(), profile: z.string(), title: z.string(), intro: z.string().nullable(),
  status: DecisionReviewStatusSchema, created_at: z.number(), updated_at: z.number(), submitted_at: z.number().nullable(),
  progress: DecisionProgressSchema, submit: DecisionSubmitSchema, items: z.array(DecisionItemSchema),
  filters: DecisionFiltersSchema, next_item_id: z.string().nullable(),
})
export type DecisionReview = z.infer<typeof DecisionReviewSchema>

export const DecisionReviewsSchema = z.object({ reviews: z.array(DecisionReviewSchema) })

/**
 * `PUT /api/decisions/{review_id}/answers/{item_id}`: `expected_version` is the item's `answer_version` as loaded;
 * `content_hash` is the item's as the user saw it, so an answer to content the agent has since revised is refused.
 * TAL-1964: no choice, not deferred and not custom clears the stored answer (and its outcome).
 */
export const DecisionAnswerInputSchema = z.object({
  review_id: z.string(), item_id: z.string(), value: z.string().nullable(), notes: z.string().max(DECISION_LIMITS.notes),
  deferred: z.boolean(), custom: z.boolean(), expected_version: z.number().int().nonnegative(), content_hash: z.string(),
})
export type DecisionAnswerInput = z.infer<typeof DecisionAnswerInputSchema>

/** The `decision_review` session stream event and the transcript card's reference, both set by the server; a session's `decision_review` (TAL-1964) is its newest open review. */
export const DecisionReviewEventSchema = z.object({ session_id: z.string(), review_id: DecisionReviewIdSchema, status: DecisionReviewStatusSchema, progress: DecisionProgressSchema })
export const DecisionReviewRefSchema = z.object({ review_id: DecisionReviewIdSchema, title: z.string(), progress: DecisionProgressSchema })
export type DecisionReviewRef = z.infer<typeof DecisionReviewRefSchema>
