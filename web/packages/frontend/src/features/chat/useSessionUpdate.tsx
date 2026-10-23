import { randomHex } from '../../lib/randomHex'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ModelConfirmationRequiredSchema, type ModelChange, type OwnerAttachment, type Session } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'
import { getStreamContext } from '../../stream/connection'
import { ConfirmDialog } from '../../ui/Dialog'
import type { ComposerNotice } from '../composer/ComposerNotices'
import { showErrorToast } from '../toast/errorToast'
import { keys } from '../../api/queryKeys'
import { useResourceMutation } from '../sessions/useResourceMutation'

type Update = Parameters<typeof api.updateSession>[1]
interface Pending { sessionId: string; body: Update; decision: { error: string; confirm_token: string }; scope: object; native?: boolean }
type OwnerResult = Awaited<ReturnType<typeof api.ownerAction>>

/** The chip shows the chosen model or workspace at once, and while its confirmation is open; Cancel or a refusal rolls it back. */
export function chosenFields(body: Update): Record<string, unknown> {
  return body.workspace !== undefined ? { workspace: body.workspace, workspace_name: null } : { model: body.model, model_option_id: body.model, model_provider: body.model_provider ?? null }
}

/** Session metadata updates share one confirmation flow; transcript Edit owns its separate cut-and-return operation. */
export function useSessionUpdate(sessionId: string | null, refresh: (session?: Session) => Promise<unknown>, nativeOwner?: OwnerAttachment) {
  const lifecycle = useRef<object | null>(null)
  const offered = useRef<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => {
    lifecycle.current = {}
    offered.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- navigation cannot inherit a previous model confirmation
    setPending(null)
    return () => { lifecycle.current = null }
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
  const write = useResourceMutation({
    resource: ({ sid }: { sid: string; body: Update; owner: OwnerAttachment | undefined }) => `session:${sid}`,
    queryKey: keys.sessions.all, readKeys: ({ sid }) => [{ queryKey: keys.sessions.detail(sid), exact: true }],
    effect: ({ body }) => ({ fields: chosenFields(body) }),
    mutationFn: async ({ sid, body, owner }): Promise<{ native: OwnerResult | null; session: unknown }> => {
      if (!owner) return { native: null, session: (await api.updateSession(sid, body)).session }
      if (owner.revision === null || owner.execution_generation === null) throw new Error(m.error_generic())
      const modelPick = body.workspace === undefined
      const native = await api.ownerAction({ session_id: sid, action: 'mutate', request_id: randomHex(),
        expected_revision: owner.revision, execution_generation: owner.execution_generation,
        operation: modelPick ? 'model' : 'workspace',
        payload: modelPick ? { model: body.model, ...(body.model_provider !== undefined ? { provider: body.model_provider } : {}), ...(body.confirm_token ? { confirm: body.confirm_token } : {}) } : { cwd: body.workspace } })
      return { native, session: native.session }
    },
  })
  const send = write.mutate
  const updateSession = useCallback((body: Update) => {
    if (!sessionId) return
    if (nativeOwner && (nativeOwner.revision === null || nativeOwner.execution_generation === null)) return
    const life = lifecycle.current
    const scope = getStreamContext()
    const current = () => life !== null && lifecycle.current === life && scope === getStreamContext()
    send({ sid: sessionId, body, owner: nativeOwner }, {
      onSuccess: (result) => {
        if (!current()) return
        // The server's returned session replaces the shown choice at once; the reread converges the rest.
        if (result.native) presentNative(result.native.model_change, body.workspace === undefined)
        else setPending(null)
        void refresh(result.session as Session | undefined)
      },
      onError: (error) => {
        if (!current()) return
        const refusal = ModelConfirmationRequiredSchema.safeParse(error instanceof ApiError && error.status === 409 ? error.body : null)
        if (refusal.success) setPending({ sessionId, body, decision: refusal.data, scope })
        else { setPending(null); showErrorToast(error) }
      },
    })
  }, [sessionId, refresh, nativeOwner, presentNative, send])
  const shown = pending?.sessionId === sessionId && pending?.scope === getStreamContext() ? pending : null
  const dialog = <ConfirmDialog open={shown !== null} onOpenChange={(open) => { if (!open) setPending((p) => p === shown ? null : p) }}
    title={m.dialog_confirm_title()} description={shown?.decision.error} confirmLabel={m.dialog_confirm_btn()} cancelLabel={m.cancel()}
    onConfirm={() => shown ? updateSession({ ...shown.body, confirm_token: shown.decision.confirm_token }) : undefined} />
  const change = nativeOwner?.model_change
  const deferredMessage = m.model_change_deferred()
  const notice = useMemo<ComposerNotice | null>(() => change?.state === 'deferred'
    ? { id: 'model-change', tone: 'info', content: deferredMessage, announcement: deferredMessage }
    : change?.state === 'refused'
      ? { id: 'model-change', tone: 'error', content: change.message, announcement: change.message }
      : null, [change, deferredMessage])
  return { updateSession, dialog, notice, confirming: shown?.body ?? null }
}
