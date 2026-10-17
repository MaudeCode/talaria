import { useCallback, useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { ConfirmDialog } from '../../ui/Dialog'
import { returnToComposer } from '../composer/composerReturn'
import { showToast } from '../toast/toast'
import { getStreamContext } from '../../stream/connection'
import { getTurnIntent } from '../../stream/store'
import type { VisibleMessage } from './useTranscript'

interface Pending { sessionId: string; row: VisibleMessage; text: string; discard: number; token: string; scope: object }

/**
 * Edit cuts the transcript at the row, then returns its text to the composer. TAL-929: the server refuses a cut that
 * discards more than one user turn and answers with its counts; the confirmation words them, and Discard resends the
 * cut with the refusal's token. A transcript that changed meanwhile asks again. Cancel leaves the transcript and
 * composer as they were.
 */
export function useEditMessage(sessionId: string | null, refresh: (accepted?: unknown) => Promise<unknown>) {
  // The return appends to the composer, so a second Edit click while the first is pending must not return the text twice.
  const active = useRef<object | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const lifecycle = useRef<object | null>(null)
  useEffect(() => {
    lifecycle.current = {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new session cannot inherit another history confirmation
    setPending(null)
    setOperation(null)
    return () => { lifecycle.current = null; active.current = null }
  }, [sessionId])
  const runHistory = useCallback(async (label: string, run: (current: () => boolean) => Promise<unknown>) => {
    if (!sessionId || active.current || getTurnIntent(sessionId).send || getTurnIntent(sessionId).stop) return false
    const owner = {}; active.current = owner
    const scope = getStreamContext()
    const life = lifecycle.current
    const current = () => active.current === owner && life !== null && lifecycle.current === life && scope === getStreamContext()
    setOperation(label)
    try { const accepted = await run(current); return current() && accepted !== false }
    catch (e) { if (current()) showToast(e instanceof Error ? e.message : String(e), 4000, 'error'); return false }
    finally { if (active.current === owner) { active.current = null; if (lifecycle.current === life) setOperation(null) } }
  }, [sessionId])
  const edit = useCallback(async (sid: string, row: VisibleMessage, text: string, token?: string) => {
    await runHistory(m.editing(), async (current) => {
      const r = await api.truncateSession(sid, row.index, token)
      if (!current()) return
      if (!r.ok) { setPending({ sessionId: sid, row, text, discard: r.discard_messages, token: r.confirm_token, scope: getStreamContext() }); return }
      returnToComposer(sid, text)
      await refresh(r.session)
    })
  }, [refresh, runHistory])
  const onEdit = useCallback((row: VisibleMessage, text: string) => (sessionId ? edit(sessionId, row, text) : Promise.resolve()), [sessionId, edit])
  const shown = pending?.sessionId === sessionId && pending.scope === getStreamContext() ? pending : null
  const dialog = (
    <ConfirmDialog
      // Closing clears only the question it showed: a Discard the server asks again about leaves the new one open.
      open={shown !== null} onOpenChange={(open) => { if (!open) setPending((p) => (p === shown ? null : p)) }}
      title={m.edit_discard_title()} description={shown ? m.edit_discard_desc({ n: shown.discard }) : undefined}
      confirmLabel={m.discard()} cancelLabel={m.cancel()} danger
      onConfirm={() => (shown ? edit(shown.sessionId, shown.row, shown.text, shown.token) : undefined)}
    />
  )
  return { onEdit, dialog, operation, runHistory }
}
