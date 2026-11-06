import { useEffect, useRef, useState } from 'react'
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConnectorOperationView } from '@maudecode/talaria-web-contracts'
import { ExternalLink } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts'
import { Button, buttonClass } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { showToast } from '../toast/toast'
import { useResourceEffects, useResourceMutation, withEffects } from '../sessions/useResourceMutation'

type Target = ConnectorOperationView['targets'][number]
type Launch = NonNullable<Target['launch']>
interface Move { action: Target['actions'][number] | 'continue'; target?: string; env?: Record<string, string> }

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

/** The server no longer holds the operation (the sidecar restarted, or it aged out): nothing is left to wait on. */
const isGone = (error: unknown): boolean => isApiError(error) && error.code === 'operation_not_found'

const operationResource = (opId: string) => `connector-operation:${opId}`
const targetResource = (opId: string, target: string) => `${operationResource(opId)}:${target}`

/**
 * One connection operation, read from the server until it settles. `initial` is the view the connect or the chat frame
 * carried; every later read replaces it. A failed read (a network blip, a busy server) keeps the last view and polls on;
 * only a server answer that the operation is gone stops it, and `lost` lets the caller drop it.
 */
export function useConnectorOperation(initial: ConnectorOperationView) {
  const qc = useQueryClient()
  const key = keys.connectors.operation(initial.op_id)
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.fetchConnectorOperation(initial.op_id, initial.owner),
    initialData: initial,
    retry: false,
    refetchInterval: (q) => (q.state.data?.settled || isGone(q.state.error) ? false : 2000),
  })
  const answer = (move: Move) => api.respondConnectorOperation({ op_id: initial.op_id, ...initial.owner, ...move })
  const failed = (error: unknown) => showToast(error instanceof Error ? error.message : m.connectors_failed(), 5000, 'error')
  const accepted = (view: ConnectorOperationView) => qc.setQueryData(key, view)
  // Skip and Continue are the user's own choice: shown at once, rolled back on a refusal, decided by a read when the answer is lost.
  const choose = useResourceMutation({
    resource: ({ target }: Move) => target ? targetResource(initial.op_id, target) : operationResource(initial.op_id),
    effect: ({ target }: Move) => target ? { fields: { state: 'skipped', connect_url: null, launch: null, actions: [], env_fields: [] } } : { remove: true },
    queryKey: key, mutationFn: answer, onSuccess: accepted, onError: failed,
  })
  // Approve and Try again run an authorization or install only the server can finish.
  const run = useMutation({ mutationKey: key, mutationFn: answer, onSuccess: accepted,
    onError: (error) => { failed(error); void qc.invalidateQueries({ queryKey: key }) } })
  const running = useMutationState({ filters: { mutationKey: key, status: 'pending' }, select: (mutation) => (mutation.state.variables as Move).target })
  const move = (next: Move) => { if (next.action === 'skip' || next.action === 'continue') choose.mutate(next); else run.mutate(next) }
  const effects = useResourceEffects()
  // A canonical owner's later frames replace the view as they arrive, in the server's order.
  const shown = useRef(initial)
  useEffect(() => {
    if (shown.current === initial || !initial.owner) return
    shown.current = initial
    qc.setQueryData(key, initial)
  }, [initial]) // eslint-disable-line react-hooks/exhaustive-deps -- each frame once
  // Back from the authorization link: the owner looks now, not at its next tick. The next read shows what it found.
  const canWake = query.data.can_wake === true
  useEffect(() => {
    if (!canWake) return
    const wake = () => { void api.respondConnectorOperation({ op_id: initial.op_id, ...initial.owner, action: 'wake' }).then((view) => qc.setQueryData(key, view), () => undefined) }
    window.addEventListener('focus', wake)
    return () => window.removeEventListener('focus', wake)
  }, [canWake]) // eslint-disable-line react-hooks/exhaustive-deps -- one operation per mount
  const view: ConnectorOperationView = { ...query.data, settled: query.data.settled || effects[operationResource(initial.op_id)]?.remove === true,
    targets: withEffects(query.data.targets, (target) => targetResource(initial.op_id, target.name), effects) }
  return { view, lost: isGone(query.error), move, running }
}

/** The operation's targets: state, the authorization link while one waits, and the moves the server offers. */
export function ConnectTargets({ view, move, running }: Pick<ReturnType<typeof useConnectorOperation>, 'view' | 'move' | 'running'>) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      {view.targets.map((target) => <TargetRow key={target.name} target={target} busy={running.includes(target.name)} onMove={(action, env) => move({ action, target: target.name, ...(env ? { env } : {}) })} />)}
    </ul>
  )
}

const LAUNCH_LINE: Record<Launch['kind'], (inputs: { target: string }) => string> = {
  stdio: m.connectors_launch_stdio,
  remote: m.connectors_launch_remote,
}

/** What the row will run or contact, in the approval card's command box: never cut, with the Agent's spacing kept, scrolling once it is long. */
function LaunchLine({ launch }: { launch: Launch }) {
  return (
    <pre className="approval-cmd" data-connect-launch tabIndex={0}>
      <span className="block">{LAUNCH_LINE[launch.kind]({ target: launch.target })}</span>
      {launch.cwd && <span className="block">{m.connectors_launch_cwd({ cwd: launch.cwd })}</span>}
      {launch.env.length > 0 && <span className="block">{m.connectors_launch_env({ names: launch.env.join(', ') })}</span>}
    </pre>
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
        {target.actions.includes('skip') && <Button variant="ghost" onClick={() => onMove('skip')}>{m.connectors_skip()}</Button>}
        </div>
      </div>
      {target.detail && <div className="text-xs text-muted">{target.detail}</div>}
      {target.launch && <LaunchLine launch={target.launch} />}
      {target.env_fields.map((field) => (
        <TextInput key={field.name} type={field.secret ? 'password' : 'text'} autoComplete="off" aria-label={field.label} placeholder={field.label}
          value={env[field.name] ?? ''} onChange={(e) => setEnv((current) => ({ ...current, [field.name]: e.target.value }))} />
      ))}
    </li>
  )
}

/** The page's own connect: the authorization link and Skip until the server reports the account connected. */
export function PageConnect({ initial, name, onDone }: { initial: ConnectorOperationView; name: string; onDone: () => void }) {
  const { view, lost, move, running } = useConnectorOperation(initial)
  useEffect(() => {
    if (!view.outcome && !lost) return
    if (view.outcome) showToast(view.outcome === 'connected' ? m.connectors_connected_toast({ name }) : m.connectors_not_connected_toast({ name }), 3000, view.outcome === 'connected' ? 'info' : 'error')
    onDone()
  }, [view.outcome, lost]) // eslint-disable-line react-hooks/exhaustive-deps -- once, when it settles
  return <div className="pl-9"><ConnectTargets view={view} move={move} running={running} /></div>
}
