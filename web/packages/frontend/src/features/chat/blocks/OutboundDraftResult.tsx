import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { OutboundDraft, OutboundDraftAction, OutboundDraftRef } from '@maudecode/talaria-web-contracts'
import * as api from '../../../api/endpoints'
import { Button } from '../../../ui/Button'
import { FieldRow, TextInput } from '../../../ui/Field'
import { m } from '../../../paraglide/messages.js'
import { useResourceEffects, useResourceMutation, withEffect } from '../../sessions/useResourceMutation'
import { showErrorToast } from '../../toast/errorToast'

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
  return <section aria-label={m.outbound_draft_heading()} className="tool-card-result [&_button]:min-h-11 border-t border-border-subtle px-2.5 py-3 text-[13px]">
    {draft ? <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong>{draft.fields.subject || m.outbound_draft_heading()}</strong>
        <span className="text-xs text-muted" role="status">{stateLabel(draft.state)} · {m.outbound_draft_version({ version: String(draft.version) })}</span>
      </div>
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
  </section>
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
