import { CheckCircle2, Circle, CircleAlert, Clock3, LoaderCircle } from 'lucide-react'
import type { UpdateNotification } from '../../contracts'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Dialog } from '../../ui/Dialog'

export type UpdateDialogTarget = 'webui' | 'agent'
const NAMES: Record<UpdateDialogTarget, string> = { webui: 'Talaria Web', agent: 'Hermes Agent' }
const ACTION_VARIANT = { default: 'default', primary: 'primary', destructive: 'danger' } as const
type StepState = UpdateNotification['steps'][number]['state']
const STEP_ICON: Record<StepState, [typeof Circle, string]> = {
  done: [CheckCircle2, 'text-success'],
  active: [LoaderCircle, 'animate-spin text-accent-text'],
  pending: [Circle, 'text-muted'],
  failed: [CircleAlert, 'text-error'],
}

export function StatusIcon({ notification }: { notification: UpdateNotification }) {
  if (notification.severity === 'critical' || notification.phase === 'failed' || notification.phase === 'unknown') return <CircleAlert className="size-5 text-error" aria-hidden="true" />
  if (notification.phase === 'succeeded') return <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
  if (notification.severity === 'warning' || notification.phase === 'blocked' || notification.phase === 'awaiting_confirmation' || notification.phase === 'waiting_for_idle') return <Clock3 className="size-5 text-warning" aria-hidden="true" />
  return <LoaderCircle className={cn('size-5 text-accent-text', notification.active && 'animate-spin')} aria-hidden="true" />
}

/**
 * The Updating dialog for one update operation. `row` is the server's record and owns every step, state, label,
 * action, and how the dialog may close (TAL-1138); before it arrives the dialog only says the update is starting, or
 * that the server's answer is outstanding. It never infers success from reachability.
 */
export function UpdatingDialog({ target, row, message, lost, reconnecting, checking, actionPending, onAction, onCheckAgain, onClose }: {
  target: UpdateDialogTarget
  row: UpdateNotification | null
  /** The server's answer when it returned no operation record. */
  message: string | null
  /** The apply request lost the server before answering. */
  lost: boolean
  reconnecting: boolean
  checking: boolean
  /** A server action on `row` is in flight. */
  actionPending: boolean
  /** Perform one of `row`'s server actions (Restart now while the gateway restart waits, Reload once Web is ready). */
  onAction: (actionId: string) => void
  onCheckAgain: () => void
  onClose: () => void
}) {
  const unverified = !row && !message && lost && !reconnecting
  const close = row ? row.dialog_close : message || unverified ? 'close' : 'none'
  const steps = row?.steps ?? []
  const failure = row?.detail ?? row?.message ?? null
  const text = row ? (steps.length === 0 ? row.message : null) : message ?? (unverified ? m.update_dialog_unverified() : lost ? m.update_dialog_waiting() : m.update_dialog_starting())
  return (
    <Dialog open onOpenChange={(open) => { if (!open && (close === 'close' || close === 'restart_later')) onClose() }} title={m.update_dialog_title({ name: NAMES[target] })} className="max-[641px]:w-[calc(100vw-16px)]">
      <div role="status" className="text-sm leading-5">
        {text !== null && <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">
            {row ? <StatusIcon notification={row} />
              : message || unverified ? <CircleAlert className="size-5 text-warning" aria-hidden="true" />
                : <LoaderCircle className="size-5 animate-spin text-accent-text" aria-hidden="true" />}
          </div>
          <p className="min-w-0 flex-1 text-text">{text}</p>
        </div>}
        {steps.length > 0 && <ol className="flex flex-col gap-2.5">
          {steps.map((step) => {
            const [Icon, tone] = STEP_ICON[step.state]
            return <li key={step.id} className="flex items-start gap-3" aria-current={step.state === 'active' ? 'step' : undefined}>
              <Icon className={cn('mt-px size-[18px] shrink-0', tone)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className={cn(step.state === 'pending' ? 'text-muted' : 'text-text', step.state === 'active' && 'font-medium')}>{step.label}</p>
                {step.state === 'failed' && failure && <p className="mt-1 whitespace-pre-line break-words text-muted">{failure}</p>}
              </div>
            </li>
          })}
        </ol>}
        {row?.detail && !steps.some((step) => step.state === 'failed') && <p className="mt-3 whitespace-pre-line break-words text-muted">{row.detail}</p>}
        {reconnecting && <p className="mt-3 text-muted">{m.update_dialog_reconnecting()}</p>}
      </div>
      {(unverified || (row?.actions.length ?? 0) > 0 || close === 'close' || close === 'restart_later') && <div className="mt-5 flex flex-wrap justify-end gap-2">
        {unverified && <Button onClick={onCheckAgain} disabled={checking}>{m.update_dialog_check_again()}</Button>}
        {close === 'restart_later' && <Button onClick={onClose}>{m.update_dialog_restart_later()}</Button>}
        {row?.actions.map((item) => <Button key={item.id} variant={ACTION_VARIANT[item.style]} disabled={actionPending} onClick={() => { onAction(item.id) }}>{item.label}</Button>)}
        {close === 'close' && <Button variant="primary" onClick={onClose}>{m.close()}</Button>}
      </div>}
    </Dialog>
  )
}
