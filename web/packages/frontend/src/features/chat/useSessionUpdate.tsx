import { randomHex } from '../../lib/randomHex'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ModelConfirmationRequiredSchema, type ModelChange, type OwnerAttachment, type Session } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'
import { getStreamContext } from '../../stream/connection'
import { ConfirmDialog } from '../../ui/Dialog'
import type { ComposerNotice } from '../composer/ComposerNotices'
import { showToast } from '../toast/toast'

type Update = Parameters<typeof api.updateSession>[1]
interface Pending { sessionId: string; body: Update; decision: { error: string; confirm_token: string }; scope: object; native?: boolean }

/** Session metadata updates share one confirmation flow; transcript Edit owns its separate cut-and-return operation. */
export function useSessionUpdate(sessionId: string | null, refresh: (session?: Session) => Promise<unknown>, nativeOwner?: OwnerAttachment) {
  const lifecycle = useRef<object | null>(null)
  const active = useRef<object | null>(null)
  const offered = useRef<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => {
    lifecycle.current = {}
    offered.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- navigation cannot inherit a previous model confirmation
    setPending(null)
    return () => { lifecycle.current = null; active.current = null }
  }, [sessionId])
  const presentNative = useCallback((change: ModelChange | undefined, explicitPick = false) => {
    if (change?.state === 'confirmation_required' && change.confirm && change.model && sessionId) {
      if (!explicitPick && offered.current === change.confirm) return
      offered.current = change.confirm
      setPending({ sessionId, native: true, body: { model: change.model, ...(change.provider !== undefined ? { model_provider: change.provider } : {}) },
        decision: { error: change.message ?? '', confirm_token: change.confirm }, scope: getStreamContext() })
    } else setPending((p) => p?.native ? null : p)
  }, [sessionId])
  useEffect(() => {
    // Owner events can resolve a deferred pick after the original HTTP request has ended.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize an external owner decision
    presentNative(nativeOwner?.model_change)
  }, [nativeOwner?.model_change, presentNative])
  const updateSession = useCallback(async (body: Update) => {
    if (!sessionId || active.current) return
    const owner = {}; active.current = owner
    const life = lifecycle.current
    const scope = getStreamContext()
    const current = () => life !== null && lifecycle.current === life && scope === getStreamContext()
    try {
      if (nativeOwner) {
        if (nativeOwner.revision === null || nativeOwner.execution_generation === null) return
        const result = await api.ownerAction({ session_id: sessionId, action: 'mutate', request_id: randomHex(),
          expected_revision: nativeOwner.revision, execution_generation: nativeOwner.execution_generation,
          operation: body.workspace === undefined ? 'model' : 'workspace',
          payload: body.workspace === undefined ? { model: body.model, ...(body.model_provider !== undefined ? { provider: body.model_provider } : {}), ...(body.confirm_token ? { confirm: body.confirm_token } : {}) } : { cwd: body.workspace } })
        if (current()) { presentNative(result.model_change, true); await refresh(result.session) }
        return
      } else await api.updateSession(sessionId, body)
      if (current()) { setPending(null); await refresh() }
    } catch (error) {
      if (!current()) return
      const refusal = ModelConfirmationRequiredSchema.safeParse(error instanceof ApiError && error.status === 409 ? error.body : null)
      if (refusal.success) setPending({ sessionId, body, decision: refusal.data, scope })
      else { setPending(null); showToast(error instanceof Error ? error.message : String(error), 4000, 'error') }
    } finally { if (active.current === owner) active.current = null }
  }, [sessionId, refresh, nativeOwner, presentNative])
  const shown = pending?.sessionId === sessionId && pending?.scope === getStreamContext() ? pending : null
  const dialog = <ConfirmDialog open={shown !== null} onOpenChange={(open) => { if (!open) setPending((p) => p === shown ? null : p) }}
    title={m.dialog_confirm_title()} description={shown?.decision.error} confirmLabel={m.dialog_confirm_btn()} cancelLabel={m.cancel()}
    onConfirm={() => shown ? updateSession({ ...shown.body, confirm_token: shown.decision.confirm_token }) : undefined} />
  const change = nativeOwner?.model_change
  const notice: ComposerNotice | null = change?.state === 'deferred'
    ? { id: 'model-change', tone: 'info', content: m.model_change_deferred(), announcement: m.model_change_deferred() }
    : change?.state === 'refused'
      ? { id: 'model-change', tone: 'error', content: change.message, announcement: change.message }
      : null
  return { updateSession, dialog, notice }
}
