import { useId, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { DecisionReviewRef, OutboundDraft, OutboundDraftAction, OutboundDraftRef, Proposal, ProposalRef } from '@maudecode/talaria-web-contracts'
import * as api from '../../../api/endpoints'
import { keys } from '../../../api/queryKeys'
import { reviewStatusLabel } from '../../decisions/reviewStatus'
import { Button } from '../../../ui/Button'
import { FieldRow, TextInput } from '../../../ui/Field'
import { m } from '../../../paraglide/messages.js'
import { useResourceEffects, useResourceMutation, withEffect } from '../../sessions/useResourceMutation'
import { showErrorToast } from '../../toast/errorToast'
import { cn } from '../../../ui/cn'
import { RowContextMenu, type RowAction } from '../../../ui/Menu'

const stateLabel = (state: OutboundDraft['state']) => ({ draft: m.outbound_draft_status_draft, approved: m.outbound_draft_status_approved, sent: m.outbound_draft_status_sent, saved: m.outbound_draft_status_saved, failed: m.outbound_draft_status_failed, discarded: m.outbound_draft_status_discarded, superseded: m.outbound_draft_status_superseded, unavailable: m.outbound_draft_status_unavailable })[state]()

/** A typed body in the existing tool shell. Plain result text cannot express version-bound recipient/body review. */
export function OutboundDraftResult({ sessionId, callId, reference }: { sessionId: string; callId: string; reference: OutboundDraftRef }) {
  const qc = useQueryClient()
  const input = { session_id: sessionId, tool_call_id: callId, ...reference }
  const queryKey = ['outbound-draft', sessionId, callId, reference.draft_id, reference.card] as const
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.fetchOutboundDraft(input, signal), retry: false, staleTime: 0 })
  const resource = `outbound-draft:${sessionId}:${reference.draft_id}:${reference.card}`
  const effect = useResourceEffects()[resource]
  const draft = query.data?.draft ? withEffect(query.data.draft, effect) : null
  const [editing, setEditing] = useState<OutboundDraft | null>(null)
  const write = useResourceMutation({
    resource: () => resource, queryKey, exclusive: true,
    effect: (action: OutboundDraftAction) => ({ fields: action.action === 'edit' ? { fields: action.fields, can_edit: false, can_approve: false } : { state: 'approved', can_edit: false, can_approve: false } }),
    mutationFn: api.actOnOutboundDraft,
    onSuccess: (result) => qc.setQueryData(queryKey, result), onError: showErrorToast,
  })
  const act = (action: 'edit' | 'approve', shown: OutboundDraft) => {
    setEditing(null)
    write.mutate({ ...input, action, version: shown.version, revision: shown.revision, ...(action === 'edit' ? { fields: shown.fields } : {}) })
  }
  return <ResultSection label={m.outbound_draft_heading()}>
    {draft ? <>
      <ResultHeader title={draft.fields.subject || m.outbound_draft_heading()} status={<>{stateLabel(draft.state)} · {m.outbound_draft_version({ version: String(draft.version) })}</>} />
      <div className="mt-1 text-xs text-muted">{draft.producer} · {draft.producer_revision.slice(0, 7)}</div>
      {editing ? <DraftEditor key={`${editing.draft_id}:${editing.revision}`} draft={editing} onSave={(fields) => act('edit', { ...editing, fields })} onCancel={() => setEditing(null)} /> : <>
        <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {(['from', 'to', 'cc', 'bcc'] as const).map((key) => {
            const value = draft.fields[key]
            return value.length > 0 ? <div key={key} className="contents"><dt className="text-muted">{fieldLabel(key)}</dt><dd className="min-w-0 break-words">{Array.isArray(value) ? value.join(', ') : value}</dd></div> : null
          })}
        </dl>
        <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{draft.fields.body}</div>
        {draft.masked && <p className="mt-2 text-warning">{m.outbound_draft_masked()}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {draft.can_edit && <Button onClick={() => setEditing(draft)}>{m.edit()}</Button>}
          {draft.can_approve && <Button variant="primary" onClick={() => act('approve', draft)}>{m.outbound_draft_approve()}</Button>}
          <Button variant="ghost" onClick={() => { void query.refetch() }}>{m.refresh()}</Button>
        </div>
      </>}
    </> : <div className="flex items-center gap-2 text-muted"><span role="status">{query.isPending ? m.loading() : m.outbound_draft_status_unavailable()}</span>{!query.isPending && <Button variant="ghost" onClick={() => { void query.refetch() }}>{m.refresh()}</Button>}</div>}
  </ResultSection>
}

/** A typed result body under a tool card's header: outbound drafts, decision reviews, proposals and (TAL-1968) shown blocks. */
export function ResultSection({ label, children }: { label: string; children: ReactNode }) {
  return <section aria-label={label} className="tool-card-result [&_button]:min-h-11 border-t border-border-subtle px-2.5 py-3 text-[13px]">{children}</section>
}

function ResultHeader({ title, status }: { title: string; status: ReactNode }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{title}</strong><span className="text-xs text-muted tabular-nums" role="status">{status}</span></div>
}

/**
 * TAL-1964: the review a `decision_review_put` made, with its current status and progress (its session's
 * `decision_review` events refresh it) and a link to answer it on its page; nothing is answered inline.
 */
export function DecisionReviewResult({ reference }: { reference: DecisionReviewRef }) {
  const query = useQuery({ queryKey: keys.decisionReview(reference.review_id), queryFn: ({ signal }) => api.fetchDecisionReview(reference.review_id, signal), retry: false })
  const review = query.data
  const progress = review?.progress ?? reference.progress
  const answered = m.decision_review_progress({ answered: progress.answered, total: progress.total })
  return <ResultSection label={m.decision_review_heading()}>
    <div data-decision-review={reference.review_id} data-review-status={review?.status}>
      <ResultHeader title={review?.title ?? reference.title} status={review ? `${reviewStatusLabel(review.status)} · ${answered}` : answered} />
      <Link to="/decisions/$reviewId" params={{ reviewId: reference.review_id }} className="mt-2 inline-flex min-h-11 items-center text-accent-text underline">{m.decision_review_open()}</Link>
    </div>
  </ResultSection>
}

const proposalStatus = (status: Proposal['status']) => ({ pending: m.proposal_status_pending, approved: m.proposal_status_approved, rejected: m.proposal_status_rejected, applied: m.proposal_status_applied, failed: m.proposal_status_failed, expired: m.proposal_status_expired })[status]()
interface ProposalDecision { approve: boolean; shown: Proposal }
const DIFF_TONE = { addition: 'text-success', deletion: 'text-error', context: 'text-pre-text' } as const

/**
 * TAL-1967: a change the agent proposed, as the server shows it: summary and status, the diff or field list, the risk
 * notes, the outcome, and Approve and Reject for the server owner. A decision shows at once and rolls back if the
 * server refuses it; the session's `proposal` events refresh the rest.
 */
export function ProposalResult({ reference }: { reference: ProposalRef }) {
  const qc = useQueryClient()
  const queryKey = keys.proposal(reference.proposal_id)
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.fetchProposal(reference.proposal_id, signal), retry: false })
  const resource = `proposal:${reference.proposal_id}`
  const effect = useResourceEffects()[resource]
  const proposal = query.data ? withEffect(query.data, effect) : null
  const decide = useResourceMutation({
    resource: () => resource, queryKey, exclusive: true,
    effect: ({ approve }: ProposalDecision) => ({ fields: { status: approve ? 'approved' : 'rejected', actions: { can_approve: false, can_reject: false, reason: 'closed' } } }),
    // Approval names the version the owner was shown.
    mutationFn: ({ approve, shown }: ProposalDecision) => approve ? api.approveProposal({ proposal_id: shown.proposal_id, payload_hash: shown.payload_hash }) : api.rejectProposal({ proposal_id: shown.proposal_id }),
    onSuccess: (result) => qc.setQueryData(queryKey, result), onError: showErrorToast,
  })
  // One list for the inline buttons and the right-click and long-press menu, as the server permits them.
  const actions: (RowAction & { primary?: boolean })[] = !proposal ? [] : [
    ...(proposal.actions.can_approve ? [{ label: m.proposal_approve(), primary: true, run: () => { decide.mutate({ approve: true, shown: proposal }) } }] : []),
    ...(proposal.actions.can_reject ? [{ label: m.proposal_reject(), run: () => { decide.mutate({ approve: false, shown: proposal }) } }] : []),
  ]
  return <ResultSection label={m.proposal_heading()}>
    <RowContextMenu label={proposal?.summary ?? reference.summary} actions={actions} trigger={<div data-proposal={reference.proposal_id} data-proposal-status={proposal?.status}>
      <ResultHeader title={proposal?.summary ?? reference.summary} status={proposal ? proposalStatus(proposal.status) : m.loading()} />
      {proposal && <>
        {proposal.diff.length > 0 && <pre aria-label={m.proposal_change()} className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-code-bg p-2 font-mono text-[12px]">
          {proposal.diff.map((line, index) => <div key={index} className={DIFF_TONE[line.kind]}>{line.text}</div>)}
        </pre>}
        {proposal.fields.length > 0 && <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {proposal.fields.map((field) => <div key={field.label} className="contents"><dt className="text-muted">{field.label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{field.value}</dd></div>)}
        </dl>}
        {proposal.risk_notes.length > 0 && <ul aria-label={m.proposal_risks()} className="mt-2 list-disc space-y-0.5 pl-5 text-muted">
          {proposal.risk_notes.map((note, index) => <li key={index} className="break-words">{note}</li>)}
        </ul>}
        {(proposal.outcome.text ?? proposal.outcome.error) && <p className={cn('mt-2 break-words', proposal.outcome.error ? 'text-error' : 'text-success')}>{proposal.outcome.error ?? proposal.outcome.text}</p>}
        {actions.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action) => <Button key={action.label} {...(action.primary ? { variant: 'primary' as const } : {})} onClick={action.run}>{action.label}</Button>)}
        </div>}
      </>}
    </div>} />
  </ResultSection>
}

const fieldLabel = (key: keyof OutboundDraft['fields']) => ({ from: m.outbound_draft_from, to: m.outbound_draft_to, cc: m.outbound_draft_cc, bcc: m.outbound_draft_bcc, subject: m.outbound_draft_subject, body: m.outbound_draft_body })[key]()

function DraftEditor({ draft, onSave, onCancel }: { draft: OutboundDraft; onSave: (fields: OutboundDraft['fields']) => void; onCancel: () => void }) {
  const [fields, setFields] = useState(draft.fields)
  const id = useId()
  return <form onSubmit={(event) => { event.preventDefault(); onSave(fields) }}>
    {(['from', 'to', 'cc', 'bcc', 'subject', 'body'] as const).map((key) => <FieldRow key={key} label={fieldLabel(key)} htmlFor={`${id}-${key}`}>
      {key === 'body' ? <textarea id={`${id}-${key}`} className="min-h-32 w-full rounded-md border border-border bg-input p-2 text-text" value={fields.body} maxLength={20_000} required onChange={(event) => setFields({ ...fields, body: event.target.value })} />
        : key === 'from' || key === 'subject' ? <TextInput id={`${id}-${key}`} value={fields[key]} maxLength={key === 'from' ? 320 : 300} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} />
          : <div className="space-y-1">{fields[key].map((value, index) => <div key={index} className="flex gap-1">
            <TextInput id={index === 0 ? `${id}-${key}` : undefined} aria-label={`${fieldLabel(key)} ${index + 1}`} value={value} maxLength={320} onChange={(event) => setFields({ ...fields, [key]: fields[key].map((v, i) => i === index ? event.target.value : v) })} />
            <Button aria-label={m.outbound_draft_remove_recipient({ field: fieldLabel(key), index: String(index + 1) })} onClick={() => setFields({ ...fields, [key]: fields[key].filter((_, i) => i !== index) })}>{m.remove()}</Button>
          </div>)}<Button disabled={fields[key].length >= 50} onClick={() => setFields({ ...fields, [key]: [...fields[key], ''] })}>{m.outbound_draft_add_recipient({ field: fieldLabel(key) })}</Button></div>}
    </FieldRow>)}
    <div className="mt-3 flex gap-2"><Button type="submit" variant="primary">{m.save()}</Button><Button onClick={onCancel}>{m.cancel()}</Button></div>
  </form>
}
