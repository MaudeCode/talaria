import { useRef, useState, type ReactNode, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowUp, GripVertical, Pencil, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { QueuedTurn } from './queue'
import type { OwnerActionRequest, OwnerAttachment } from '@maudecode/talaria-web-contracts'
import { randomHex } from '../../lib/randomHex'
import { Button } from '../../ui/Button'

/** `list` with the item at `from` moved to `to`. */
function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

// The handle and Remove keep the composer's focus.
const keepFocus = (e: PointerEvent) => { e.preventDefault() }

/** Extracted from QueueCard's local cancel control so owner rows use the same icon and wording. */
function QueueCancelButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} className="steer-action min-h-11 min-w-11 shrink-0" aria-label={m.queued_cancel()} title={m.queued_cancel()} onPointerDown={keepFocus} onClick={onClick}><X size={14} aria-hidden="true" /></button>
}

/**
 * TAL-562: the queued messages behind the composer's queue chip (TAL-1078), sent top to bottom when the turn ends. A row is edited in place,
 * removed, or moved by dragging its handle (Arrow Up/Down on the focused handle moves it too).
 */
export function QueueCard({ sessionId, queued, onChange, pendingId, admissions = [], onAdmissionAction, readOnly = false, rowLabel, rowStatus, ariaLabel }: { sessionId: string; ariaLabel?: string; readOnly?: boolean; rowLabel?: (id: string) => ReactNode; rowStatus?: (id: string) => ReactNode; queued: QueuedTurn[]; onChange: (queued: QueuedTurn[]) => void; pendingId?: string | undefined; admissions?: OwnerAttachment['admissions'] | undefined; onAdmissionAction?: ((request: OwnerActionRequest) => Promise<void>) | undefined }) {
  const [editing, setEditing] = useState<string | null>(null)
  // Retry is executed by the server, so its own button stays busy until the server answers.
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set())
  const replacements = useRef(new Map<string, { text: string; submission_id: string }>())
  const discard = useRef(false)
  const dragging = useRef<string | null>(null)
  const label = ariaLabel ?? (admissions.length ? m.owner_inputs() : m.queued_count({ n: queued.length }))

  const move = (id: string, to: number) => {
    const from = queued.findIndex((q) => q.id === id)
    if (from < 0 || to < 0 || to >= queued.length || to === from) return
    onChange(moveItem(queued, from, to))
  }
  // The owner shows each action's result at once; ChatView reports a refusal and the row comes back.
  const runAdmission = async (request: OwnerActionRequest): Promise<boolean> => {
    if (!onAdmissionAction) return false
    try { await onAdmissionAction(request); return true }
    catch { return false }
  }
  // Enter and a click away save; Escape keeps the old text. An unconfirmed native edit keeps its draft and identity.
  const finishEdit = (id: string, e: FocusEvent<HTMLInputElement>, native: boolean) => {
    const text = e.currentTarget.value.trim()
    if (discard.current) { discard.current = false; setEditing(null); return }
    if (native && text) {
      let replacement = replacements.current.get(id)
      if (replacement?.text !== text) {
        replacement = { text, submission_id: randomHex() }
        replacements.current.set(id, replacement)
      }
      // The edit shows at once; an unconfirmed one keeps its request identity so a later save is the same submission.
      const sent = replacement
      void runAdmission({ session_id: sessionId, action: 'replace_queued', admission_id: id, ...sent }).then((ok) => { if (ok && replacements.current.get(id) === sent) replacements.current.delete(id) })
    } else if (!native) onChange(queued.map((q) => (q.id === id && (text || q.attachments.length) ? { ...q, text } : q)))
    setEditing((current) => current === id ? null : current)
  }
  // Native and local rows share their editor, icon, focus behavior and accessible wording.
  const editableText = (id: string, text: string, disabled: boolean, native = false, canEdit = true, suffix = '') => <>
    <div className={rowLabel ? 'flex min-w-0 flex-1 flex-col gap-0.5' : 'contents'}>
    {rowLabel?.(id)}
    {editing === id && !readOnly
      ? <input className="queue-card-input" disabled={disabled} aria-label={m.queued_edit()} defaultValue={text} autoFocus onBlur={(e) => { finishEdit(id, e, native) }} onKeyDown={onEditKey} />
      : <span className="queue-card-text truncate" title={text}>{text}{suffix}</span>}
    </div>
    {canEdit && editing !== id && <button type="button" disabled={disabled} className="steer-action min-h-11 min-w-11 shrink-0" aria-label={m.queued_edit()} title={m.queued_edit()} onClick={() => { setEditing(id) }}><Pencil size={14} aria-hidden="true" /></button>}
  </>
  // A removed message's files are discarded on the server too, like a file taken off the composer.
  const remove = (q: QueuedTurn) => {
    onChange(queued.filter((x) => x.id !== q.id))
    const tokens = q.attachments.flatMap((a) => (a.rollback_token ? [a.rollback_token] : []))
    if (tokens.length) void api.rollbackUpload(sessionId, tokens).catch(() => undefined)
  }
  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return
    e.preventDefault()
    discard.current = e.key === 'Escape'
    e.currentTarget.blur()
  }
  const onHandleKey = (id: string, index: number, e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    move(id, e.key === 'ArrowUp' ? index - 1 : index + 1)
  }
  // The handle captures the pointer, so the row under it, wherever it is, says where the message goes.
  const onHandleMove = (id: string, e: PointerEvent) => {
    if (dragging.current !== id) return
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-queue-index]')
    if (over) move(id, Number(over.dataset.queueIndex))
  }



  return (
    <div className="queue-card flex min-w-0 flex-1 flex-col gap-0.5" role="region" aria-label={label}>
      <ol className="queue-card-list flex flex-col">
        {admissions.map((q) => (
          <li key={q.admission_id} className="queue-card-row">
            {editableText(q.admission_id, q.text ?? '', false, true, q.actions.includes('edit'))}
            {q.status === 'unknown' && <span className="text-muted text-xs">{m.owner_outcome_unknown()}</span>}
            {q.actions.includes('steer') && <button type="button" className="steer-action min-h-11 min-w-11 shrink-0" aria-label={m.composer_steer()} title={m.composer_steer()} onClick={() => { void runAdmission({ session_id: sessionId, action: 'steer_queued', admission_id: q.admission_id }) }}><ArrowUp size={14} aria-hidden="true" /></button>}
            {q.actions.includes('cancel') && <QueueCancelButton disabled={false} onClick={() => { void runAdmission({ session_id: sessionId, action: 'cancel', admission_id: q.admission_id }) }} />}
            {q.actions.map((action) => action === 'edit' || action === 'steer' || action === 'cancel' ? null : <Button key={action} variant="ghost" className="min-h-11 min-w-11 shrink-0" title={action === 'retry' ? m.owner_retry_help() : undefined} disabled={action === 'retry' && retrying.has(q.admission_id)} aria-busy={action === 'retry' && retrying.has(q.admission_id) || undefined} onClick={() => {
              if (q.execution_generation === null) return
              const request = { session_id: sessionId, action, admission_id: q.admission_id, execution_generation: q.execution_generation }
              if (action !== 'retry') { void runAdmission(request); return }
              const id = q.admission_id
              setRetrying((ids) => new Set(ids).add(id))
              void runAdmission(request).finally(() => { setRetrying((ids) => { const next = new Set(ids); next.delete(id); return next }) })
            }}>{action === 'retry' ? m.retry() : m.discard()}</Button>)}
          </li>
        ))}
        {queued.map((q, i) => (
          <li key={q.id} className="queue-card-row" data-queue-index={i}>
            {!readOnly && <button
              type="button" disabled={q.id === pendingId} className="steer-action queue-card-handle min-h-11 min-w-11 shrink-0" aria-label={m.queued_reorder()} title={m.queued_reorder()}
              onPointerDown={(e) => { keepFocus(e); e.currentTarget.setPointerCapture(e.pointerId); dragging.current = q.id }}
              onPointerMove={(e) => { onHandleMove(q.id, e) }}
              onPointerUp={() => { dragging.current = null }}
              onPointerCancel={() => { dragging.current = null }}
              onKeyDown={(e) => { onHandleKey(q.id, i, e) }}
            ><GripVertical size={14} aria-hidden="true" /></button>}
            {editableText(q.id, q.text, q.id === pendingId, false, !readOnly, q.attachments.length ? ` (+${String(q.attachments.length)})` : '')}
            {rowStatus?.(q.id)}
            {!readOnly && <QueueCancelButton disabled={q.id === pendingId} onClick={() => { remove(q) }} />}
          </li>
        ))}
      </ol>
    </div>
  )
}
