import { useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { GripVertical, Pencil, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { QueuedTurn } from './queue'

/** `list` with the item at `from` moved to `to`. */
function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

// Clicks on the row's buttons keep the composer's focus.
const keepFocus = (e: PointerEvent) => { e.preventDefault() }

/**
 * TAL-562: the queued messages in the composer tab, sent top to bottom when the turn ends. A row is edited in place,
 * removed, or moved by dragging its handle (Arrow Up/Down on the focused handle moves it too).
 */
export function QueueCard({ queued, onChange }: { queued: QueuedTurn[]; onChange: (queued: QueuedTurn[]) => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const discard = useRef(false)
  const dragging = useRef<string | null>(null)
  const label = m.queued_count({ n: queued.length })

  const move = (id: string, to: number) => {
    const from = queued.findIndex((q) => q.id === id)
    if (from < 0 || to < 0 || to >= queued.length || to === from) return
    onChange(moveItem(queued, from, to))
  }
  // Enter and a click away save; Escape keeps the old text. A message never empties: one with no files keeps its text.
  const finishEdit = (id: string, e: FocusEvent<HTMLInputElement>) => {
    setEditing(null)
    const text = e.currentTarget.value.trim()
    if (discard.current) { discard.current = false; return }
    onChange(queued.map((q) => (q.id === id && (text || q.attachments.length) ? { ...q, text } : q)))
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
      <span className="queue-card-title" aria-live="polite">{label}</span>
      <ol className="queue-card-list flex flex-col">
        {queued.map((q, i) => (
          <li key={q.id} className="queue-card-row" data-queue-index={i}>
            <button
              type="button" className="steer-action queue-card-handle" aria-label={m.queued_reorder()} title={m.queued_reorder()}
              onPointerDown={(e) => { keepFocus(e); e.currentTarget.setPointerCapture(e.pointerId); dragging.current = q.id }}
              onPointerMove={(e) => { onHandleMove(q.id, e) }}
              onPointerUp={() => { dragging.current = null }}
              onPointerCancel={() => { dragging.current = null }}
              onKeyDown={(e) => { onHandleKey(q.id, i, e) }}
            ><GripVertical size={14} aria-hidden="true" /></button>
            {editing === q.id
              ? <input className="queue-card-input" aria-label={m.queued_edit()} defaultValue={q.text} autoFocus onBlur={(e) => { finishEdit(q.id, e) }} onKeyDown={onEditKey} />
              : <span className="queue-card-text truncate">{q.text}{q.attachments.length ? ` (+${String(q.attachments.length)})` : ''}</span>}
            {editing !== q.id && <button type="button" className="steer-action" aria-label={m.queued_edit()} title={m.queued_edit()} onPointerDown={keepFocus} onClick={() => { setEditing(q.id) }}><Pencil size={14} aria-hidden="true" /></button>}
            <button type="button" className="steer-action" aria-label={m.queued_cancel()} title={m.queued_cancel()} onPointerDown={keepFocus} onClick={() => { onChange(queued.filter((x) => x.id !== q.id)) }}><X size={14} aria-hidden="true" /></button>
          </li>
        ))}
      </ol>
    </div>
  )
}
