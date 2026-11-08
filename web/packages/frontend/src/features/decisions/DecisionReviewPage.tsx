import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { DecisionAnswer, DecisionAnswerInput, DecisionFilter, DecisionItem, DecisionReview } from '@maudecode/talaria-web-contracts'
import { DECISION_FILTERS } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { openSessionStream } from '../../api/sse'
import { isApiError } from '../../contracts/common'
import type { DecisionsSearch } from '../../contracts/url'
import { useLocale } from '../../i18n/useLocale'
import { m } from '../../paraglide/messages.js'
import { HubPage } from '../../shell/AppShell'
import { Badge } from '../../ui/Badge'
import { BackButton, Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Row, RowList, SectionHeader } from '../../ui/List'
import { RowContextMenu } from '../../ui/Menu'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showErrorToast } from '../toast/errorToast'
import { useResourceEffects, useResourceMutation, withEffect, withEffects } from '../sessions/useResourceMutation'
import { reviewStatusLabel } from './reviewStatus'

const outcomeLabel = (state: NonNullable<DecisionItem['outcome']>['state']) => ({ applied: m.decision_outcome_applied, kept: m.decision_outcome_kept, blocked: m.decision_outcome_blocked, reviewed: m.decision_outcome_reviewed, planned: m.decision_outcome_planned })[state]()
const filterLabel = (filter: DecisionFilter) => ({ all: m.decision_filter_all, new: m.decision_filter_new, pending: m.decision_filter_pending })[filter]()
const submitReason = (reason: DecisionReview['submit']['reason']) => reason === 'nothing_answered' ? m.decision_submit_nothing_answered() : reason === 'not_open' ? m.decision_submit_not_open() : null

/** The `data-answer` state of an item: the server's answer as one word. */
const answerState = (answer: DecisionAnswer | null) => !answer ? 'open' : answer.deferred ? 'deferred' : answer.custom ? 'custom' : 'answered'
/** Only web links become anchors; any other source (a path, a command) stays text. */
const isWebLink = (source: string) => /^https?:\/\//i.test(source)

/** What a save sends, without the review, item and versions the page adds. */
type Choice = Pick<DecisionAnswerInput, 'value' | 'notes' | 'deferred' | 'custom'>
interface Draft { value: string | null; notes: string }
interface Failure { itemId: string; kind: 'conflict' | 'changed' }

/**
 * TAL-1964: a decision review the agent opened. Decide shows one item at a time in the server's order; Answers lists every
 * item with the server's filters, Continue item and Submit. Saves show at once and roll back to the server's answer when
 * it refuses (root rule: optimistic writes).
 */
export function DecisionReviewPage({ reviewId, search }: { reviewId: string; search: DecisionsSearch }) {
  useLocale()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const queryKey = keys.decisionReview(reviewId)
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.fetchDecisionReview(reviewId, signal), retry: false })
  const sessionId = query.data?.session_id
  // The review lives in its session: the agent's revisions and outcomes arrive as that session's `decision_review` events.
  useEffect(() => {
    if (!sessionId) return
    const stream = openSessionStream(sessionId, { onEvent: ({ event, data }) => {
      if (event === 'decision_review' && data.review_id === reviewId) void qc.invalidateQueries({ queryKey: keys.decisionReview(reviewId) })
    } })
    return () => stream.close()
  }, [qc, sessionId, reviewId])

  const effects = useResourceEffects()
  const reviewResource = `decision-review:${reviewId}`
  const itemResource = (itemId: string) => `decision-review:${reviewId}:${itemId}`
  const base = query.data ? withEffect(query.data, effects[reviewResource]) : null
  const review = base ? { ...base, items: withEffects(base.items, (item) => itemResource(item.id), effects) } : null

  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const go = (next: { view?: 'answers' | undefined; item?: string | undefined; filter?: DecisionFilter | undefined }) => { void navigate({ to: '/decisions/$reviewId', params: { reviewId }, search: next }) }

  const save = useResourceMutation({
    resource: (input: DecisionAnswerInput) => itemResource(input.item_id), queryKey,
    effect: (input: DecisionAnswerInput) => {
      const item = review?.items.find((candidate) => candidate.id === input.item_id)
      const choice = item?.choices.find((candidate) => candidate.value === input.value) ?? null
      const cleared = input.value === null && !input.deferred && !input.custom
      const answer: DecisionAnswer | null = cleared ? null : {
        value: choice?.value ?? null, label: choice?.label ?? null, effect: choice?.effect ?? null, notes: input.notes.trim(),
        // The server stamps the save; the shown answer keeps the old time until it does.
        deferred: input.deferred, custom: input.custom, version: input.expected_version + 1, updated_at: item?.answer?.updated_at ?? 0,
      }
      return { fields: { answer, answer_version: input.expected_version + 1, needs_review: false, outcome: null } }
    },
    mutationFn: api.answerDecision,
    onSuccess: (result) => qc.setQueryData(queryKey, result),
  })
  const submit = useResourceMutation({
    resource: () => reviewResource, queryKey, exclusive: true,
    effect: () => ({ fields: { status: 'submitted', submit: { allowed: false, reason: 'not_open' } } }),
    // Answers still being saved belong in the handoff: the submit waits for them and their reconciliation.
    mutationFn: async () => { await Promise.allSettled([...saving.current]); return api.submitDecisionReview(reviewId) },
    onSuccess: (result) => qc.setQueryData(queryKey, result), onError: showErrorToast,
  })

  const saving = useRef(new Set<Promise<unknown>>())
  /** Drop `item`'s draft once the save of `shown` settles, so the server's answer shows; a later edit stays. */
  const retire = (itemId: string, shown: Draft | undefined) => setDrafts((all) => shown && all[itemId] === shown ? Object.fromEntries(Object.entries(all).filter(([id]) => id !== itemId)) : all)

  /** Save `choice` for `item` as shown; a refusal brings the item back with the typed notes and names the refusal. */
  const answer = (item: DecisionItem, choice: Choice, shown?: Draft) => {
    setFailure(null)
    const write = save.mutateAsync({ review_id: reviewId, item_id: item.id, ...choice, expected_version: item.answer_version, content_hash: item.content_hash }).then(() => retire(item.id, shown), (error: unknown) => {
      const code = isApiError(error) ? error.code : undefined
      if (code !== 'answer_conflict' && code !== 'item_changed') { showErrorToast(error); retire(item.id, shown); return }
      // The 409 carries the stored answer: show it at once, behind the refetch the rollback starts.
      const held = isApiError(error) ? error.body as { answer?: DecisionAnswer | null; answer_version?: number } | undefined : undefined
      const stored = held?.answer ?? null
      qc.setQueryData<DecisionReview>(queryKey, (old) => old && { ...old, items: old.items.map((candidate) => candidate.id === item.id ? { ...candidate, answer: stored, answer_version: held?.answer_version ?? candidate.answer_version } : candidate) })
      setDrafts((all) => ({ ...all, [item.id]: { value: stored?.value ?? null, notes: choice.notes } }))
      setFailure({ itemId: item.id, kind: code === 'answer_conflict' ? 'conflict' : 'changed' })
      go({ item: item.id })
    })
    saving.current.add(write)
    void write.finally(() => saving.current.delete(write))
  }

  const title = review?.title ?? query.data?.title ?? m.decision_review_heading()
  const view = search.view === 'answers' ? 'answers' : 'decide'
  return (
    <HubPage
      title={title}
      actions={sessionId ? <BackButton label={m.decision_review_back()} onClick={() => { void navigate({ to: '/session/$sessionId', params: { sessionId } }) }} /> : undefined}
      toolbar={review && (
        <>
          <div role="tablist" aria-label={m.decision_review_views()} className="flex gap-1">
            {(['decide', 'answers'] as const).map((id) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} aria-controls={`decisions-${id}`} onClick={() => go(id === 'answers' ? { view: 'answers', filter: search.filter } : { item: search.item })} className={cn('rounded-md px-3 py-1.5 text-sm', view === id ? 'bg-accent-bg text-accent-text' : 'text-muted hover:bg-hover hover:text-text')}>
                {id === 'answers' ? m.decision_view_answers() : m.decision_view_decide()}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted tabular-nums" role="status" data-review-status={review.status}>{reviewStatusLabel(review.status)} · {m.decision_review_progress({ answered: review.progress.answered, total: review.progress.total })}</span>
        </>
      )}
    >
      {query.isPending && <LoadingState />}
      {query.isError && <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />}
      {review && (view === 'answers'
        ? <AnswersView review={review} filter={search.filter ?? 'all'} onFilter={(filter) => go({ view: 'answers', filter })} onOpen={(item) => go({ item })} onClear={(item) => { retire(item.id, drafts[item.id]); answer(item, { value: null, notes: '', deferred: false, custom: false }) }} onSubmit={() => submit.mutate(undefined)} />
        : <DecideView
          key={search.item ?? ''} review={review} itemId={search.item} draft={drafts} failure={failure}
          onDraft={(itemId, draft) => setDrafts((all) => ({ ...all, [itemId]: draft }))}
          onAnswer={(item, choice, next) => { if (choice) answer(item, choice, drafts[item.id]); go(next ? { item: next } : { view: 'answers' }) }}
          onOpen={(item) => go({ item })}
        />)}
    </HubPage>
  )
}

function DecideView({ review, itemId, draft: drafts, failure, onDraft, onAnswer, onOpen }: {
  review: DecisionReview; itemId: string | undefined; draft: Record<string, Draft>; failure: Failure | null
  onDraft: (itemId: string, draft: Draft) => void; onAnswer: (item: DecisionItem, choice: Choice | null, next: string | undefined) => void; onOpen: (itemId: string) => void
}) {
  const id = useId()
  const index = Math.max(0, review.items.findIndex((item) => item.id === itemId))
  const item = review.items[index]
  if (!item) return <EmptyState>{m.decision_filter_empty()}</EmptyState>
  const draft = drafts[item.id] ?? { value: item.answer?.value ?? null, notes: item.answer?.notes ?? '' }
  const closed = review.status !== 'open'
  const next = review.items[index + 1]?.id
  const previous = review.items[index - 1]?.id
  const notes = draft.notes.trim()
  // A kept answer moves on without another save.
  const unchanged = !!item.answer && !item.needs_review && !item.answer.deferred && !item.answer.custom && item.answer.value === draft.value && item.answer.notes === notes
  const saveNext = () => onAnswer(item, unchanged ? null : { value: draft.value, notes: draft.notes, deferred: false, custom: false }, next)
  const failed = failure?.itemId === item.id ? failure.kind : null
  return (
    <section role="tabpanel" id="decisions-decide" data-section="decisions" data-decision-item={item.id} data-answer={answerState(item.answer)} data-needs-review={item.needs_review || undefined} className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted tabular-nums">{m.decision_position({ index: index + 1, total: review.items.length })}</span>
        <h2 className="text-base font-semibold text-text">{item.title}</h2>
        {(!!item.answer || item.needs_review) && <p role="status" className={cn('text-xs', item.needs_review ? 'text-warning' : 'text-muted')}>{item.needs_review ? m.decision_needs_review() : m.decision_answer_kept()}</p>}
      </div>
      {failed && <ErrorState><div className="font-medium text-text">{failed === 'conflict' ? m.decision_conflict() : m.decision_item_changed()}</div><div className="text-xs text-muted">{failed === 'conflict' ? m.decision_conflict_detail() : m.decision_item_changed_detail()}</div></ErrorState>}
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text">{item.question}</p>
        <p className="whitespace-pre-wrap text-sm text-text">{item.explanation}</p>
      </div>
      {item.example && <Block heading={m.decision_example()}>{item.example}</Block>}
      <Block heading={m.decision_current()}>{item.current}</Block>
      <Block heading={m.decision_recommendation()}>{item.recommendation}</Block>
      <fieldset className="flex flex-col" disabled={closed}>
        <legend className="mb-1"><SectionHeader>{m.decision_choices()}</SectionHeader></legend>
        <RowList role="radiogroup" aria-label={item.question}>
          {item.choices.map((choice) => {
            const recommended = choice.value === item.recommended_choice
            return (
              <li key={choice.value} className="border-t border-border-subtle first:border-t-0" data-choice={choice.value} data-recommended={recommended || undefined}>
                <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5">
                  <input type="radio" name={`${id}-choice`} value={choice.value} checked={draft.value === choice.value} onChange={() => onDraft(item.id, { ...draft, value: choice.value })} className="mt-1 accent-(--accent)" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className={cn('text-sm font-medium', recommended ? 'text-accent-text' : 'text-text')}>{choice.label}</span>
                      {recommended && <Badge tone="border-accent text-accent-text">{m.decision_recommended()}</Badge>}
                    </span>
                    <span className="text-xs text-muted">{choice.effect}</span>
                  </span>
                </label>
              </li>
            )
          })}
        </RowList>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-notes`}><SectionHeader>{m.decision_notes()}</SectionHeader></label>
        <textarea id={`${id}-notes`} className="min-h-20 w-full rounded-md border border-border bg-input p-2 text-sm text-text" value={draft.notes} maxLength={8000} disabled={closed} onChange={(event) => onDraft(item.id, { ...draft, notes: event.target.value })} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={closed} onClick={() => onAnswer(item, { value: null, notes: draft.notes, deferred: true, custom: false }, next)}>{m.decision_defer()}</Button>
          <Button disabled={closed || !notes} onClick={() => onAnswer(item, { value: null, notes: draft.notes, deferred: false, custom: true }, next)}>{m.decision_use_notes()}</Button>
        </div>
      </div>
      {(item.technical.detail || item.technical.sources.length > 0) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted">{m.decision_technical()}</summary>
          <div className="mt-2 flex flex-col gap-2">
            {item.technical.detail && <p className="whitespace-pre-wrap text-text">{item.technical.detail}</p>}
            {item.technical.sources.length > 0 && <ul className="flex flex-col gap-1 text-xs">
              {item.technical.sources.map((source) => <li key={source} className="break-all">{isWebLink(source) ? <a href={source} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">{source}</a> : <code>{source}</code>}</li>)}
            </ul>}
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button disabled={!previous} onClick={() => { if (previous) onOpen(previous) }}>{m.back()}</Button>
        {/* A closed review stays readable: Next only moves on. */}
        {closed
          ? <Button className="ml-auto" disabled={!next} onClick={() => { if (next) onOpen(next) }}>{m.decision_next()}</Button>
          : <Button variant="primary" className="ml-auto" disabled={draft.value === null} onClick={saveNext}>{m.decision_save_next()}</Button>}
      </div>
    </section>
  )
}

function Block({ heading, children }: { heading: string; children: string }) {
  return <div className="flex flex-col gap-1.5"><SectionHeader>{heading}</SectionHeader><p className="whitespace-pre-wrap text-sm text-text">{children}</p></div>
}

function AnswersView({ review, filter, onFilter, onOpen, onClear, onSubmit }: {
  review: DecisionReview; filter: DecisionFilter; onFilter: (filter: DecisionFilter) => void
  onOpen: (itemId: string) => void; onClear: (item: DecisionItem) => void; onSubmit: () => void
}) {
  const shown = filter === 'all' ? review.items : review.items.filter((item) => review.filters[filter].includes(item.id))
  const open = review.status === 'open'
  const next = review.next_item_id
  const reason = submitReason(review.submit.reason)
  return (
    <section role="tabpanel" id="decisions-answers" data-section="decisions" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted">{m.decision_filter()} <Select value={filter} aria-label={m.decision_filter()} onValueChange={(value) => onFilter(value as DecisionFilter)}>{DECISION_FILTERS.map((id) => <option key={id} value={id}>{filterLabel(id)}</option>)}</Select></label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {next && open && <Button onClick={() => onOpen(next)}>{m.decision_continue()}</Button>}
          <Button variant="primary" disabled={!review.submit.allowed} onClick={onSubmit}>{m.decision_submit()}</Button>
        </div>
      </div>
      {reason && open && <p role="status" className="text-xs text-muted">{reason}</p>}
      {shown.length === 0 ? <EmptyState>{m.decision_filter_empty()}</EmptyState> : (
        <RowList>
          {shown.map((item) => (
            <RowContextMenu key={item.id} label={m.decision_row_menu()} actions={[{ label: m.decision_review_open(), run: () => onOpen(item.id) }, { label: m.decision_clear(), run: () => onClear(item), disabled: !open || !item.answer }]} trigger={
              <Row data-decision-item={item.id} data-answer={answerState(item.answer)} data-needs-review={item.needs_review || undefined} data-outcome={item.outcome?.state}>
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Link to="/decisions/$reviewId" params={{ reviewId: review.review_id }} search={{ item: item.id }} className="text-sm font-semibold text-text hover:underline">{item.title}</Link>
                    {item.answer?.deferred && <Badge tone="border-border text-muted">{m.decision_deferred()}</Badge>}
                    {item.answer?.custom && <Badge tone="border-border text-muted">{m.decision_custom()}</Badge>}
                    {item.needs_review && <Badge tone="border-warning text-warning">{m.decision_changed()}</Badge>}
                    {item.outcome && <span className="ml-auto text-xs text-muted">{outcomeLabel(item.outcome.state)}</span>}
                  </div>
                  <span className={cn('text-sm', item.answer?.label ? 'text-text' : 'text-muted')}>{item.answer?.label ?? (item.answer?.custom ? item.answer.notes : m.decision_no_answer())}</span>
                  {item.outcome?.note && <span className="text-xs text-muted">{item.outcome.note}</span>}
                </div>
              </Row>
            } />
          ))}
        </RowList>
      )}
    </section>
  )
}
