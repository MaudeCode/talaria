import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { ConfirmDialog } from '../../ui/Dialog'
import { returnToComposer } from '../composer/composerReturn'
import { showErrorToast } from '../toast/errorToast'
import { getStreamContext, useStreamContext } from '../../stream/connection'
import { getTurnIntent } from '../../stream/store'
import type { VisibleMessage } from './useTranscript'
import { keys } from '../../api/queryKeys'
import { useResourceMutation } from '../sessions/useResourceMutation'

/** The transcript as a history cut leaves it: rows from `value` (a message index) on are gone until the reread. */
export const transcriptCut = (sessionId: string) => `transcript:${sessionId}`
/** The server asked to confirm a cut: it was not made, so the transcript comes back while the question shows. */
class ConfirmationAsked extends Error {}

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
  const context = useStreamContext()
  const lifecycle = useRef<object | null>(null)
  useEffect(() => {
    lifecycle.current = {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new session cannot inherit another history confirmation
    setPending(null)
    setOperation(null)
    return () => { lifecycle.current = null; active.current = null }
  }, [sessionId])
  // Edit, /clear and /undo cut the transcript at once and the session's reread confirms it; a refusal puts it back.
  const cut = useResourceMutation({
    resource: ({ sid }: { sid: string; from: number; run: () => Promise<unknown> }) => transcriptCut(sid), exclusive: true,
    queryKey: keys.sessions.all, readKeys: ({ sid }) => [{ queryKey: keys.sessions.detail(sid), exact: true }],
    effect: ({ from }) => ({ value: from }),
    mutationFn: ({ run }) => run(),
  })
  const sendCut = cut.mutateAsync
  /** `cutFrom` shows the history change at once; without it (retry) the server produces the result and a status shows. */
  const runHistory = async (label: string, run: (current: () => boolean) => Promise<unknown>, cutFrom?: number) => {
    if (!sessionId || active.current || getTurnIntent(sessionId).send || getTurnIntent(sessionId).stop) return false
    const owner = {}; active.current = owner
    const scope = getStreamContext()
    const life = lifecycle.current
    const current = () => active.current === owner && life !== null && lifecycle.current === life && scope === getStreamContext()
    if (cutFrom === undefined) setOperation(label)
    let accepted = false
    try { const result = cutFrom === undefined ? await run(current) : await sendCut({ sid: sessionId, from: cutFrom, run: () => run(current) }); accepted = current() && result !== false }
    catch (e) { if (current() && !(e instanceof ConfirmationAsked)) showErrorToast(e) }
    if (active.current === owner) { active.current = null; if (lifecycle.current === life) setOperation(null) }
    return accepted
  }
  const edit = async (sid: string, row: VisibleMessage, text: string, token?: string) => {
    await runHistory(m.editing(), async (current) => {
      const r = await api.truncateSession(sid, row.index, token)
      if (!current()) return
      // A cut the server asks to confirm is not made: the transcript comes back while the question shows.
      if (!r.ok) { setPending({ sessionId: sid, row, text, discard: r.discard_messages, token: r.confirm_token, scope: getStreamContext() }); throw new ConfirmationAsked() }
      returnToComposer(sid, text)
      await refresh(r.session)
    }, row.index)
  }
  const onEdit = (row: VisibleMessage, text: string) => (sessionId ? edit(sessionId, row, text) : Promise.resolve())
  const shown = pending?.sessionId === sessionId && pending.scope === context ? pending : null
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
