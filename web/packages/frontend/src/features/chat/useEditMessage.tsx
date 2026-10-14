import { useCallback, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { ConfirmDialog } from '../../ui/Dialog'
import { returnToComposer } from '../composer/composerReturn'
import { showToast } from '../toast/toast'
import type { VisibleMessage } from './useTranscript'

interface Pending { sessionId: string; row: VisibleMessage; text: string; discard: number; token: string }

/**
 * Edit cuts the transcript at the row, then returns its text to the composer. TAL-929: the server refuses a cut that
 * discards more than one user turn and answers with its counts; the confirmation words them, and Discard resends the
 * cut with the refusal's token. A transcript that changed meanwhile asks again. Cancel leaves the transcript and
 * composer as they were.
 */
export function useEditMessage(sessionId: string | null, refresh: () => Promise<unknown>) {
  // The return appends to the composer, so a second Edit click while the first is pending must not return the text twice.
  const editing = useRef(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const edit = useCallback(async (sid: string, row: VisibleMessage, text: string, token?: string) => {
    if (editing.current) return
    editing.current = true
    try {
      const r = await api.truncateSession(sid, row.index, token)
      if (!r.ok) { setPending({ sessionId: sid, row, text, discard: r.discard_messages, token: r.confirm_token }); return }
      await refresh()
      returnToComposer(sid, text)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    } finally { editing.current = false }
  }, [refresh])
  const onEdit = useCallback((row: VisibleMessage, text: string) => (sessionId ? edit(sessionId, row, text) : Promise.resolve()), [sessionId, edit])
  const shown = pending?.sessionId === sessionId ? pending : null
  const dialog = (
    <ConfirmDialog
      // Closing clears only the question it showed: a Discard the server asks again about leaves the new one open.
      open={shown !== null} onOpenChange={(open) => { if (!open) setPending((p) => (p === shown ? null : p)) }}
      title={m.edit_discard_title()} description={shown ? m.edit_discard_desc({ n: shown.discard }) : undefined}
      confirmLabel={m.discard()} cancelLabel={m.cancel()} danger
      onConfirm={() => (shown ? edit(shown.sessionId, shown.row, shown.text, shown.token) : undefined)}
    />
  )
  return { onEdit, dialog }
}
