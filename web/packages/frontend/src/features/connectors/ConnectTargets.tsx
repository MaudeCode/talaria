import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConnectorOperationView } from '@maudecode/talaria-web-contracts'
import { ExternalLink } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Button, buttonClass } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { showToast } from '../toast/toast'

type Target = ConnectorOperationView['targets'][number]
type Move = Target['actions'][number] | 'continue'

const STATE: Record<Target['state'], () => string> = {
  pending: m.connectors_state_pending,
  initiated: m.connectors_state_initiated,
  connected: m.connectors_state_connected,
  skipped: m.connectors_state_skipped,
  failed: m.connectors_state_failed,
  expired: m.connectors_state_expired,
  not_connected: m.connectors_state_not_connected,
}
export const targetState = (state: Target['state']): string => STATE[state]()

/**
 * One connection operation, read from the server until it settles. `initial` is the view the connect or the chat frame
 * carried; every later read replaces it. A read that fails (the operation is gone) stops the polling; `lost` lets the
 * caller drop it.
 */
export function useConnectorOperation(initial: ConnectorOperationView) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: keys.connectors.operation(initial.op_id),
    queryFn: () => api.fetchConnectorOperation(initial.op_id),
    initialData: initial,
    retry: false,
    refetchInterval: (q) => (q.state.data?.settled || q.state.status === 'error' ? false : 2000),
  })
  const move = useMutation({
    mutationFn: (move: { action: Move; target?: string; env?: Record<string, string> }) => api.respondConnectorOperation({ op_id: initial.op_id, ...move }),
    onSuccess: (view) => qc.setQueryData(keys.connectors.operation(initial.op_id), view),
    onError: (error) => showToast(error instanceof Error ? error.message : m.connectors_failed(), 5000, 'error'),
  })
  return { view: query.data, lost: query.isError, move }
}

/** The operation's targets: state, the authorization link while one waits, and the moves the server offers. */
export function ConnectTargets({ view, move }: Pick<ReturnType<typeof useConnectorOperation>, 'view' | 'move'>) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      {view.targets.map((target) => <TargetRow key={target.name} target={target} busy={move.isPending} onMove={(action, env) => move.mutate({ action, target: target.name, ...(env ? { env } : {}) })} />)}
    </ul>
  )
}

function TargetRow({ target, busy, onMove }: { target: Target; busy: boolean; onMove: (action: Target['actions'][number], env?: Record<string, string>) => void }) {
  const [env, setEnv] = useState<Record<string, string>>({})
  const missing = target.env_fields.some((field) => field.required && !env[field.name]?.trim())
  return (
    <li className="flex flex-col gap-2 py-2" data-connect-target={target.name}>
      <div className="flex items-center gap-2 text-sm">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-text">{target.title}</span>
          <span className="text-xs text-muted" data-connect-state={target.state}>{targetState(target.state)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
        {target.connect_url && (
          <a href={target.connect_url} target="_blank" rel="noopener noreferrer" className={buttonClass('primary')}>
            {m.connectors_authorize()}<ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
        {target.actions.includes('approve') && <Button variant="primary" disabled={busy || missing} onClick={() => onMove('approve', env)}>{m.connectors_approve()}</Button>}
        {target.actions.includes('retry') && <Button disabled={busy || missing} onClick={() => onMove('retry', env)}>{m.connectors_retry()}</Button>}
        {target.actions.includes('skip') && <Button variant="ghost" disabled={busy} onClick={() => onMove('skip')}>{m.connectors_skip()}</Button>}
        </div>
      </div>
      {target.detail && <div className="text-xs text-muted">{target.detail}</div>}
      {target.env_fields.map((field) => (
        <TextInput key={field.name} type={field.secret ? 'password' : 'text'} autoComplete="off" aria-label={field.label} placeholder={field.label}
          value={env[field.name] ?? ''} onChange={(e) => setEnv((current) => ({ ...current, [field.name]: e.target.value }))} />
      ))}
    </li>
  )
}
