/**
 * TAL-1963: decision reviews. One document per review in the `decision-reviews` namespace holds the items in the
 * agent's order, each answer with the choice text as the user saw it, and the history of every answer and removed item.
 * The server decides display order, freshness, `needs_review`, progress, `submit` and outcomes; clients render them.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  DECISION_LIMITS, DecisionReviewIdSchema,
  type DecisionAnswer, type DecisionAnswerInput, type DecisionItem, type DecisionReviewList, type DecisionReviewRef, type DecisionItemInput, type DecisionProgress, type DecisionReview,
  type SidecarServerParams, type SidecarServerResultInput,
} from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import { HttpFailure } from './service.js'
import { sendSessionMessage } from './admission.js'

const NAMESPACE = 'decision-reviews'

/** An answer as stored: the contract fields, the item's content and question it answered. */
interface StoredAnswer extends DecisionAnswer { content_hash: string; question: string }
type ItemContent = Omit<DecisionItem, 'content_hash' | 'fresh' | 'needs_review' | 'answer' | 'answer_version' | 'outcome'>
/** `answer_version` (TAL-1964) counts saves and clears; a document written before it reads its answer's version. */
interface StoredItem extends ItemContent { content_hash: string; fresh: DecisionItem['fresh']; answer: StoredAnswer | null; answer_version?: number; outcome: DecisionItem['outcome'] }
type HistoryEntry = { kind: 'answer' | 'cleared'; at: number; item_id: string; answer: StoredAnswer } | { kind: 'removed'; at: number; item: StoredItem }
export interface StoredReview {
  review_id: string; session_id: string; profile: string; title: string; intro: string | null; status: DecisionReview['status']
  created_at: number; updated_at: number; submitted_at: number | null; items: StoredItem[]; history: HistoryEntry[]
}
/** The session a call acts for: the caller's own (agent tools) or the session a review belongs to. */
export interface DecisionCaller { session_id: string; profile?: string | null }

const refuse = (status: number, condition: string, message: string, extra: Record<string, unknown> = {}): HttpFailure => new HttpFailure(status, message, { code: condition, ...extra })
const notFound = (id: string) => refuse(404, 'review_unknown', `no decision review ${id}`)

function capped(value: unknown, limit: number, field: string, required = true): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (required && !text) throw refuse(400, 'field_required', `${field} is required`)
  if (text.length > limit) throw refuse(400, 'field_too_long', `${field} is longer than ${limit} characters`)
  return text
}

/** The agent's items checked and normalized; the first failure names its condition and nothing is written. */
export function validateItems(items: DecisionItemInput[]): ItemContent[] {
  if (items.length < 1 || items.length > DECISION_LIMITS.items) throw refuse(400, 'items_count', `a review has 1 to ${DECISION_LIMITS.items} items, not ${items.length}`)
  const ids = new Set<string>()
  return items.map((raw, index) => {
    const at = `items[${index}]`
    const id = capped(raw.id, DECISION_LIMITS.id, `${at}.id`)
    if (ids.has(id)) throw refuse(400, 'duplicate_item_id', `item id ${id} is used twice`)
    ids.add(id)
    if (raw.choices.length < DECISION_LIMITS.choicesMin || raw.choices.length > DECISION_LIMITS.choicesMax) throw refuse(400, 'choices_count', `item ${id} has ${raw.choices.length} choices; each item has ${DECISION_LIMITS.choicesMin} to ${DECISION_LIMITS.choicesMax}`)
    const values = new Set<string>()
    const choices = raw.choices.map((choice, c) => {
      const value = capped(choice.value, DECISION_LIMITS.id, `${at}.choices[${c}].value`)
      if (values.has(value)) throw refuse(400, 'duplicate_choice_value', `item ${id} uses choice value ${value} twice`)
      values.add(value)
      return { value, label: capped(choice.label, DECISION_LIMITS.label, `${at}.choices[${c}].label`), effect: capped(choice.effect, DECISION_LIMITS.effect, `${at}.choices[${c}].effect`) }
    })
    const recommended = capped(raw.recommended_choice, DECISION_LIMITS.id, `${at}.recommended_choice`)
    if (!values.has(recommended)) throw refuse(400, 'recommended_choice_unknown', `item ${id} recommends ${recommended}, which is not one of its choices`)
    const sources = raw.technical?.sources ?? []
    if (sources.length > DECISION_LIMITS.sources) throw refuse(400, 'field_too_long', `${at}.technical.sources has more than ${DECISION_LIMITS.sources} entries`)
    return {
      id, title: capped(raw.title, DECISION_LIMITS.title, `${at}.title`), question: capped(raw.question, DECISION_LIMITS.question, `${at}.question`),
      explanation: capped(raw.explanation, DECISION_LIMITS.explanation, `${at}.explanation`), example: capped(raw.example, DECISION_LIMITS.example, `${at}.example`, false) || null,
      current: capped(raw.current, DECISION_LIMITS.current, `${at}.current`), recommendation: capped(raw.recommendation, DECISION_LIMITS.recommendation, `${at}.recommendation`),
      recommended_choice: recommended, choices,
      technical: { detail: capped(raw.technical?.detail, DECISION_LIMITS.detail, `${at}.technical.detail`, false) || null, sources: sources.map((s, i) => capped(s, DECISION_LIMITS.source, `${at}.technical.sources[${i}]`)) },
    }
  })
}

/** A stable hash of everything the user reads about an item; an answer given to another hash needs review. */
export function contentHash(item: ItemContent): string {
  const { id, title, question, explanation, example, current, recommendation, recommended_choice, choices, technical } = item
  return createHash('sha256').update(JSON.stringify([id, title, question, explanation, example, current, recommendation, recommended_choice, choices.map((c) => [c.value, c.label, c.effect]), technical.detail, technical.sources])).digest('hex').slice(0, 16)
}

const isAnswered = (answer: StoredAnswer | null): boolean => !!answer && !answer.deferred
const answerVersion = (item: StoredItem): number => item.answer_version ?? item.answer?.version ?? 0
const needsReview = (item: StoredItem): boolean => !!item.answer && item.answer.content_hash !== item.content_hash

export function progressOf(review: StoredReview): DecisionProgress {
  return {
    total: review.items.length,
    answered: review.items.filter((item) => isAnswered(item.answer)).length,
    deferred: review.items.filter((item) => item.answer?.deferred).length,
    needs_review: review.items.filter(needsReview).length,
  }
}

const publicAnswer = (answer: StoredAnswer | null): DecisionAnswer | null => answer && {
  value: answer.value, label: answer.label, effect: answer.effect, notes: answer.notes, deferred: answer.deferred, custom: answer.custom, version: answer.version, updated_at: answer.updated_at,
}

/** The review as clients and the agent read it: new and changed items first, each group in the agent's order. */
export function reviewView(review: StoredReview): DecisionReview {
  const progress = progressOf(review)
  const ordered = [...review.items.filter((item) => item.fresh !== 'carried'), ...review.items.filter((item) => item.fresh === 'carried')]
  return {
    review_id: review.review_id, session_id: review.session_id, profile: review.profile, title: review.title, intro: review.intro, status: review.status,
    created_at: review.created_at, updated_at: review.updated_at, submitted_at: review.submitted_at, progress,
    submit: review.status !== 'open' ? { allowed: false, reason: 'not_open' } : progress.answered ? { allowed: true, reason: null } : { allowed: false, reason: 'nothing_answered' },
    items: ordered.map((item) => ({
      id: item.id, title: item.title, question: item.question, explanation: item.explanation, example: item.example, current: item.current,
      recommendation: item.recommendation, recommended_choice: item.recommended_choice, choices: item.choices, technical: item.technical,
      content_hash: item.content_hash, fresh: item.fresh, needs_review: needsReview(item), answer: publicAnswer(item.answer), answer_version: answerVersion(item), outcome: item.outcome,
    })),
    // TAL-1964: the answers view's filters and the item Continue opens.
    filters: { new: ordered.filter((item) => item.fresh !== 'carried').map((item) => item.id), pending: ordered.filter((item) => !item.answer).map((item) => item.id) },
    next_item_id: ordered.find((item) => !isAnswered(item.answer) || needsReview(item))?.id ?? null,
  }
}

/** The one-line message a submit sends the owning session; the answers stay in the review. */
export function submitMessage(review: Pick<StoredReview, 'review_id' | 'title'>): string {
  const title = review.title.replace(/\s+/g, ' ').trim()
  return `The decision review "${title}" (${review.review_id}) was submitted. Call decision_review_read with review_id ${review.review_id} for the answers.`
}

export class DecisionReviews {
  /** Open reviews by id, with their session, for the synchronous sidebar attention summary. */
  private readonly open = new Map<string, string>()
  /**
   * TAL-1966: each session's newest review by creation, open or not. Its push alert fires when this changes, so closing
   * a newer review never re-announces an older one that is still open.
   */
  private readonly latest = new Map<string, Pick<StoredReview, 'review_id' | 'title' | 'created_at'>>()
  constructor(private readonly documents: DocumentBackend, private readonly deps: () => AppDeps, private readonly now: () => number) {}

  async initialize(): Promise<void> {
    for (const { key } of await this.documents.list(NAMESPACE)) {
      try {
        const review = (await this.documents.get(NAMESPACE, key))?.value as StoredReview | undefined
        if (review?.status === 'open') this.open.set(review.review_id, review.session_id)
        if (review) this.track(review)
      } catch { /* an unreadable review shows no attention */ }
    }
  }

  /** How many open reviews `sid` holds. */
  openCount(sid: string): number {
    let count = 0
    for (const owner of this.open.values()) if (owner === sid) count += 1
    return count
  }

  private track(review: StoredReview): void {
    const held = this.latest.get(review.session_id)
    if (!held || held.review_id === review.review_id || review.created_at > held.created_at) {
      this.latest.set(review.session_id, { review_id: review.review_id, title: review.title, created_at: review.created_at })
    }
  }

  /** TAL-1966: the session's newest review by creation, which its push alert announces once. */
  latestRef(sid: string): { review_id: string; title: string } | null {
    const held = this.latest.get(sid)
    return held ? { review_id: held.review_id, title: held.title } : null
  }

  /** TAL-1964: the session's newest open review, for its composer chip. */
  async openRef(sid: string): Promise<DecisionReviewRef | null> {
    let newest: StoredReview | null = null
    for (const [id, owner] of this.open) {
      if (owner !== sid) continue
      const review = await this.load(id)
      if (review?.status === 'open' && (!newest || review.created_at > newest.created_at)) newest = review
    }
    return newest && { review_id: newest.review_id, title: newest.title, progress: progressOf(newest) }
  }

  private profileName(profile: string | null | undefined): string {
    const name = profile || 'default'
    return this.deps().isRootProfile(name) ? 'default' : name
  }

  private async load(id: string): Promise<StoredReview | null> {
    if (!DecisionReviewIdSchema.safeParse(id).success) return null
    try { return ((await this.documents.get(NAMESPACE, id))?.value as StoredReview | undefined) ?? null } catch { return null }
  }

  /** A review the current request may see: the request's profile, and a session its person may see. */
  private async visible(review: StoredReview | null): Promise<boolean> {
    const deps = this.deps()
    return !!review && deps.profilesMatch(review.profile, deps.activeProfile()) && await deps.sessions.personMaySeeSessionId(review.session_id)
  }

  /** Change one review under its document lock; `edit` throws to refuse and write nothing. */
  private async edit<T>(id: string, edit: (review: StoredReview) => T, check?: (review: StoredReview) => Promise<void>): Promise<{ review: StoredReview; result: T }> {
    const before = await this.load(id)
    if (!before) throw notFound(id)
    await check?.(before)
    const done = await updateDocument(this.documents, NAMESPACE, id, (raw) => {
      const review = structuredClone(raw) as StoredReview | null
      if (!review) throw notFound(id)
      const wasOpen = review.status === 'open'
      const result = edit(review)
      review.updated_at = this.now()
      return { value: review, result: { review, result, wasOpen } }
    })
    this.changed(done.review, done.wasOpen)
    return done
  }

  /** Every change: the open index, the session's `decision_review` event and, when attention moved, `sessions_changed`. */
  private changed(review: StoredReview, wasOpen: boolean): void {
    const deps = this.deps()
    if (review.status === 'open') this.open.set(review.review_id, review.session_id)
    else this.open.delete(review.review_id)
    this.track(review)
    deps.channels.emit(review.session_id, 'decision_review', { session_id: review.session_id, review_id: review.review_id, status: review.status, progress: progressOf(review) }, review.profile)
    if (wasOpen !== (review.status === 'open')) deps.events.publish('decision_review', { profile: review.profile, sessionId: review.session_id })
  }

  private async own(caller: DecisionCaller, id: string): Promise<StoredReview> {
    const review = await this.load(id)
    if (!review || review.session_id !== caller.session_id || review.profile !== this.profileName(caller.profile)) throw notFound(id)
    return review
  }

  /** A deleted session takes its reviews and their answers with it. */
  async deleteForSession(sid: string): Promise<void> {
    for (const { key } of await this.documents.list(NAMESPACE)) {
      const review = await this.load(key)
      if (review?.session_id !== sid) continue
      await this.documents.delete(NAMESPACE, key)
      this.open.delete(key)
    }
    this.latest.delete(sid)
  }

  // ── agent tools ─────────────────────────────────────────────────────────

  /** `decision_review_put`: create a review, or revise one of the caller's. */
  async put(caller: DecisionCaller, params: Omit<SidecarServerParams<'server.decision_review_put'>, 'caller_session_id'>): Promise<SidecarServerResultInput<'server.decision_review_put'>> {
    const title = capped(params.title, DECISION_LIMITS.title, 'title')
    const intro = capped(params.intro, DECISION_LIMITS.intro, 'intro', false) || null
    const items = validateItems(params.items)
    const hashed = items.map((item) => ({ ...item, content_hash: contentHash(item) }))
    let review: StoredReview
    if (params.review_id) {
      await this.own(caller, params.review_id)
      ;({ review } = await this.edit(params.review_id, (stored) => {
        if (stored.status === 'cancelled') throw refuse(409, 'review_closed', `decision review ${stored.review_id} was cancelled`)
        const previous = new Map(stored.items.map((item) => [item.id, item]))
        const next = hashed.map((item): StoredItem => {
          const prior = previous.get(item.id)
          const fresh = !prior ? 'new' : prior.content_hash === item.content_hash ? 'carried' : 'changed'
          return { ...item, fresh, answer: prior?.answer ?? null, answer_version: prior ? answerVersion(prior) : 0, outcome: fresh === 'carried' ? prior!.outcome : null }
        })
        const kept = new Set(next.map((item) => item.id))
        const at = this.now()
        for (const item of stored.items) if (!kept.has(item.id)) stored.history.push({ kind: 'removed', at, item })
        const revised = next.some((item) => item.fresh !== 'carried') || stored.items.length !== next.length
        stored.items = next
        stored.title = title
        stored.intro = intro
        // New or changed decisions need the user again.
        if (revised && stored.status !== 'open') { stored.status = 'open'; stored.submitted_at = null }
      }))
    } else {
      const newId = (): string => `dr_${randomBytes(4).toString('hex')}`
      let id = newId()
      while (await this.documents.get(NAMESPACE, id)) id = newId()
      const at = this.now()
      review = {
        review_id: id, session_id: caller.session_id, profile: this.profileName(caller.profile), title, intro, status: 'open',
        created_at: at, updated_at: at, submitted_at: null, items: hashed.map((item) => ({ ...item, fresh: 'new', answer: null, answer_version: 0, outcome: null })), history: [],
      }
      await this.documents.put(NAMESPACE, id, review, null)
      this.changed(review, false)
    }
    return { review_id: review.review_id, url: `/decisions/${review.review_id}`, title: review.title, status: review.status, progress: progressOf(review) }
  }

  /** `decision_review_read`: the caller's review with answers exactly as stored. */
  async read(caller: DecisionCaller, id: string): Promise<DecisionReview> {
    return reviewView(await this.own(caller, id))
  }

  /** `decision_review_record`: every outcome or none; a submitted review whose answered items all have one is applied. */
  async record(caller: DecisionCaller, id: string, outcomes: SidecarServerParams<'server.decision_review_record'>['outcomes']): Promise<DecisionReview> {
    await this.own(caller, id)
    const { review } = await this.edit(id, (stored) => {
      if (stored.status === 'cancelled') throw refuse(409, 'review_closed', `decision review ${stored.review_id} was cancelled`)
      const items = new Map(stored.items.map((item) => [item.id, item]))
      const unknown = outcomes.filter((outcome) => !items.has(outcome.id)).map((outcome) => outcome.id)
      if (unknown.length) throw refuse(400, 'unknown_item', `decision review ${stored.review_id} has no item ${unknown.join(', ')}`)
      for (const outcome of outcomes) items.get(outcome.id)!.outcome = { state: outcome.state, note: capped(outcome.note, DECISION_LIMITS.outcomeNote, 'note', false) || null }
      const answered = stored.items.filter((item) => isAnswered(item.answer))
      if (stored.status === 'submitted' && answered.length && answered.every((item) => item.outcome)) stored.status = 'applied'
    })
    return reviewView(review)
  }

  // ── routes ──────────────────────────────────────────────────────────────

  /** `GET /api/decisions`: the request profile's open and submitted reviews, newest first, and why none are listed. */
  // ponytail: reads every stored review per call; index by profile and status when the Decisions hub lists many.
  async list(): Promise<DecisionReviewList> {
    const reviews: StoredReview[] = []
    let closed = false
    for (const { key } of await this.documents.list(NAMESPACE)) {
      const review = await this.load(key)
      if (!review || !(await this.visible(review))) continue
      if (review.status === 'open' || review.status === 'submitted') reviews.push(review)
      else closed = true
    }
    const rows = await Promise.all(reviews.sort((a, b) => b.created_at - a.created_at).map(async (review) => ({
      review_id: review.review_id, session_id: review.session_id, session_title: await this.sessionTitle(review.session_id),
      title: review.title, status: review.status, created_at: review.created_at, progress: progressOf(review),
    })))
    return { reviews: rows, empty: rows.length ? null : closed ? 'closed' : 'none' }
  }

  /** The owning session's title, or null when it has none or cannot be read. */
  private async sessionTitle(sid: string): Promise<string | null> {
    try { return (await this.deps().sessionStore.get(sid, { metadataOnly: true, promote: false })).title.trim() || null } catch { return null }
  }

  async get(id: string): Promise<DecisionReview> {
    const review = await this.load(id)
    if (!(await this.visible(review))) throw notFound(id)
    return reviewView(review!)
  }

  private readonly visibleCheck = async (review: StoredReview): Promise<void> => { if (!(await this.visible(review))) throw notFound(review.review_id) }

  /** `PUT …/answers/{item_id}`: one answer, refused on a stale `expected_version` with the stored answer. */
  async answer(input: DecisionAnswerInput): Promise<DecisionReview> {
    const { review } = await this.edit(input.review_id, (stored) => {
      const item = stored.items.find((candidate) => candidate.id === input.item_id)
      if (!item) throw refuse(404, 'item_unknown', `decision review ${stored.review_id} has no item ${input.item_id}`)
      if (stored.status !== 'open') throw refuse(409, 'review_closed', `decision review ${stored.review_id} is ${stored.status}`)
      const version = answerVersion(item)
      const held = { answer: publicAnswer(item.answer), answer_version: version }
      if (input.expected_version !== version) throw refuse(409, 'answer_conflict', 'This answer changed since it was loaded.', held)
      if (input.content_hash !== item.content_hash) throw refuse(409, 'item_changed', 'This decision changed since it was loaded.', held)
      // TAL-1964: no choice, not deferred and not custom clears the answer; the cleared one stays in history.
      if (input.value === null && !input.deferred && !input.custom) {
        if (item.answer) stored.history.push({ kind: 'cleared', at: this.now(), item_id: item.id, answer: item.answer })
        item.answer = null
        item.answer_version = version + 1
        item.outcome = null
        return
      }
      const notes = input.notes.trim()
      let choice: StoredItem['choices'][number] | null = null
      if (input.deferred || input.custom) {
        if (input.value !== null) throw refuse(400, 'invalid_answer', 'a deferred or custom answer has no choice')
        if (input.deferred && input.custom) throw refuse(400, 'invalid_answer', 'an answer is deferred or custom, not both')
        if (input.custom && !notes) throw refuse(400, 'invalid_answer', 'a custom answer needs notes')
      } else {
        choice = item.choices.find((candidate) => candidate.value === input.value) ?? null
        if (!choice) throw refuse(400, 'invalid_answer', `item ${item.id} has no choice ${String(input.value)}`)
      }
      const answer: StoredAnswer = {
        value: choice?.value ?? null, label: choice?.label ?? null, effect: choice?.effect ?? null, notes, deferred: input.deferred, custom: input.custom,
        version: version + 1, updated_at: this.now(), content_hash: item.content_hash, question: item.question,
      }
      item.answer = answer
      item.answer_version = answer.version
      // An outcome answers the previous answer; the agent records the new one again.
      item.outcome = null
      stored.history.push({ kind: 'answer', at: answer.updated_at, item_id: item.id, answer })
    }, this.visibleCheck)
    return reviewView(review)
  }

  /** `POST …/submit`: mark it submitted, then message the owning session; a refused message reopens the review. */
  async submit(id: string): Promise<DecisionReview> {
    const { review } = await this.edit(id, (stored) => {
      if (stored.status !== 'open') throw refuse(409, 'review_closed', `decision review ${stored.review_id} is ${stored.status}`)
      if (!progressOf(stored).answered) throw refuse(400, 'nothing_answered', 'Answer at least one decision before submitting.')
      stored.status = 'submitted'
      stored.submitted_at = this.now()
    }, this.visibleCheck)
    try {
      await sendSessionMessage(this.deps(), review.session_id, submitMessage(review))
    } catch (error) {
      await this.edit(id, (stored) => { if (stored.status === 'submitted' && stored.submitted_at === review.submitted_at) { stored.status = 'open'; stored.submitted_at = null } })
      throw error
    }
    return reviewView(review)
  }

  async cancel(id: string): Promise<DecisionReview> {
    const { review } = await this.edit(id, (stored) => {
      if (stored.status !== 'open' && stored.status !== 'submitted') throw refuse(409, 'review_closed', `decision review ${stored.review_id} is ${stored.status}`)
      stored.status = 'cancelled'
    }, this.visibleCheck)
    return reviewView(review)
  }
}
