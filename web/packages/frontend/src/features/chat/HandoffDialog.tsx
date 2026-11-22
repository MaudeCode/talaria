import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionHandoff } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Dialog, DialogFooter } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { LoadingState } from '../../ui/States'
import { showErrorToast } from '../toast/errorToast'

/** How often an open dialog rereads a handoff the gateway has yet to settle, or whose state it could not read. */
const FOLLOW_MS = 2000
const FOLLOWED = new Set<SessionHandoff['state']>(['pending', 'running', 'unknown'])

const UNAVAILABLE: Record<NonNullable<SessionHandoff['unavailable_reason']>, () => string> = {
  not_owned: m.handoff_unavailable_not_owned, unsupported: m.handoff_unavailable_unsupported,
  owner_unavailable: m.handoff_unavailable_owner, no_destination: m.handoff_unavailable_no_destination,
}
const REFUSED: Partial<Record<NonNullable<SessionHandoff['refusal']>, () => string>> = {
  session_busy: m.handoff_refused_busy, handoff_in_flight: m.handoff_refused_in_flight, unknown_execution: m.handoff_refused_unknown_execution,
  destination_unavailable: m.handoff_refused_destination, permission_denied: m.handoff_refused_permission,
}

/** The one status line: the latest write's verdict, else the handoff's state, else why none can be sent. */
function statusLine(view: SessionHandoff): string | null {
  if (view.outcome === 'refused') return ((view.refusal ? REFUSED[view.refusal] : undefined) ?? m.handoff_refused)()
  if (view.outcome === 'unknown') return m.handoff_outcome_unknown()
  const platform = view.platform ?? ''
  switch (view.state) {
    case 'pending': return m.handoff_state_pending()
    case 'running': return m.handoff_state_running({ platform })
    case 'completed': return m.handoff_state_completed({ platform })
    case 'failed': return view.error ? m.handoff_state_failed_reason({ error: view.error }) : m.handoff_state_failed()
    case 'unknown': return m.handoff_state_unknown()
    default: return view.unavailable_reason ? UNAVAILABLE[view.unavailable_reason]() : null
  }
}

/**
 * TAL-2641: `/handoff`. Shows where the chat's own owner would hand it off, sends the request only on the user's
 * explicit action and follows the gateway until it settles. Every field is the server's; a request shows as queued at
 * once and converges on the server's answer. A write whose outcome is unknown, or a state the owner could not read, offers
 * no request and is read again until the owner answers, never resent.
 */
export function HandoffDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const key = keys.sessions.handoff(sessionId)
  const read = useQuery({
    queryKey: key, queryFn: () => api.nativeHandoff({ session_id: sessionId, action: 'read' }),
    refetchInterval: (query) => query.state.data && FOLLOWED.has(query.state.data.state) ? FOLLOW_MS : false,
  })
  const [picked, setPicked] = useState<string | null>(null)
  const write = useMutation({
    mutationFn: (input: { action: 'request'; platform: string } | { action: 'cancel' }) => api.nativeHandoff({ session_id: sessionId, ...input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<SessionHandoff>(key)
      if (before) qc.setQueryData<SessionHandoff>(key, input.action === 'request'
        ? { ...before, state: 'pending', platform: input.platform, error: null, outcome: null, refusal: null, can_request: false, can_cancel: false }
        : { ...before, state: 'failed', error: null, outcome: null, refusal: null, can_request: false, can_cancel: false })
      return { before }
    },
    onSuccess: (view) => {
      qc.setQueryData(key, view)
      if (view.outcome === 'unknown') void qc.invalidateQueries({ queryKey: key })
    },
    onError: (error, _input, context) => {
      // The write may have reached the owner: offer nothing until a read says what it did, and never send it again.
      if (context?.before) qc.setQueryData<SessionHandoff>(key, { ...context.before, state: 'unknown', outcome: 'unknown', refusal: null, can_request: false, can_cancel: false })
      void qc.invalidateQueries({ queryKey: key })
      showErrorToast(error)
    },
  })
  const view = read.data
  const platform = picked ?? view?.destinations[0]?.platform ?? ''
  const status = view ? statusLine(view) : null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={m.handoff_title()}>
      {!view ? <LoadingState compact /> : (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (view.can_request && platform) write.mutate({ action: 'request', platform }) }}>
          {view.destinations.length > 0 && (
            <Select value={platform} onValueChange={setPicked} aria-label={m.handoff_destination()} disabled={!view.can_request} className="w-full">
              {view.destinations.map((d) => <option key={d.platform} value={d.platform}>{m.handoff_destination_option({ label: d.label, platform: d.platform })}</option>)}
            </Select>
          )}
          {status && <p role="status" className="text-sm text-muted [overflow-wrap:anywhere]">{status}</p>}
          <DialogFooter>
            {view.can_cancel && <Button onClick={() => write.mutate({ action: 'cancel' })}>{m.handoff_cancel()}</Button>}
            <Button onClick={onClose}>{m.close()}</Button>
            <Button type="submit" variant="primary" disabled={!view.can_request || !platform}>{m.handoff_request()}</Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  )
}
