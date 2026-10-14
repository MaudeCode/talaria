import { useCallback, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { ConfirmDialog } from '../../ui/Dialog'
import { returnToComposer } from '../composer/composerReturn'
import type { VisibleMessage } from './useTranscript'

interface Pending { sessionId: string; row: VisibleMessage; text: string; discard: number }

/**
 * Edit cuts the transcript at the row, then returns its text to the composer. TAL-929: the server refuses a cut that
 * discards more than one user turn and answers with its counts; the confirmation words them, and Discard resends the
 * cut with `confirm_deep_truncate`. Cancel leaves the transcript and composer as they were.
 */
export function useEditMessage(sessionId: string | null, refresh: () => Promise<unknown>) {
  // The return appends to the composer, so a second Edit click while the first is pending must not return the text twice.
  const editing = useRef(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const edit = useCallback(async (sid: string, row: VisibleMessage, text: string, confirm: boolean) => {
    if (editing.current) return
    editing.current = true
    try {
      const r = await api.truncateSession(sid, row.index, confirm)
      if (!r.ok) { setPending({ sessionId: sid, row, text, discard: r.discard_messages }); return }
      await refresh()
      returnToComposer(sid, text)
    } finally { editing.current = false }
  }, [refresh])
  const onEdit = useCallback((row: VisibleMessage, text: string) => (sessionId ? edit(sessionId, row, text, false) : Promise.resolve()), [sessionId, edit])
  const shown = pending?.sessionId === sessionId ? pending : null
  const dialog = (
    <ConfirmDialog
      open={shown !== null} onOpenChange={(open) => { if (!open) setPending(null) }}
      title={m.edit_discard_title()} description={shown ? m.edit_discard_desc({ n: shown.discard }) : undefined}
      confirmLabel={m.discard()} cancelLabel={m.cancel()} danger
      onConfirm={() => (shown ? edit(shown.sessionId, shown.row, shown.text, true) : undefined)}
    />
  )
  return { onEdit, dialog }
}
