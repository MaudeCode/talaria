import { useCallback, useEffect, useRef, useState } from 'react'
import { ModelConfirmationRequiredSchema, type ModelConfirmationRequired } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'
import { getStreamContext } from '../../stream/connection'
import { ConfirmDialog } from '../../ui/Dialog'
import { showToast } from '../toast/toast'

type Update = Parameters<typeof api.updateSession>[1]
interface Pending { sessionId: string; body: Update; decision: ModelConfirmationRequired; scope: object }

/** Session metadata updates share one confirmation flow; transcript Edit owns its separate cut-and-return operation. */
export function useSessionUpdate(sessionId: string | null, refresh: () => Promise<unknown>) {
  const lifecycle = useRef<object | null>(null)
  const active = useRef<object | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => {
    lifecycle.current = {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- navigation cannot inherit a previous model confirmation
    setPending(null)
    return () => { lifecycle.current = null; active.current = null }
  }, [sessionId])
  const updateSession = useCallback(async (body: Update) => {
    if (!sessionId || active.current) return
    const owner = {}; active.current = owner
    const life = lifecycle.current
    const scope = getStreamContext()
    const current = () => life !== null && lifecycle.current === life && scope === getStreamContext()
    try {
      await api.updateSession(sessionId, body)
      if (current()) { setPending(null); await refresh() }
    } catch (error) {
      if (!current()) return
      const refusal = ModelConfirmationRequiredSchema.safeParse(error instanceof ApiError && error.status === 409 ? error.body : null)
      if (refusal.success) setPending({ sessionId, body, decision: refusal.data, scope })
      else { setPending(null); showToast(error instanceof Error ? error.message : String(error), 4000, 'error') }
    } finally { if (active.current === owner) active.current = null }
  }, [sessionId, refresh])
  const shown = pending?.sessionId === sessionId && pending?.scope === getStreamContext() ? pending : null
  const dialog = <ConfirmDialog open={shown !== null} onOpenChange={(open) => { if (!open) setPending((p) => p === shown ? null : p) }}
    title={m.dialog_confirm_title()} description={shown?.decision.error} confirmLabel={m.dialog_confirm_btn()} cancelLabel={m.cancel()}
    onConfirm={() => shown ? updateSession({ ...shown.body, confirm_token: shown.decision.confirm_token }) : undefined} />
  return { updateSession, dialog }
}
