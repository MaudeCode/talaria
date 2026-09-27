import { CheckCircle2, CircleAlert, Clock3, LoaderCircle } from 'lucide-react'
import type { UpdateNotification } from '../../contracts'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Dialog } from '../../ui/Dialog'

export type UpdateDialogTarget = 'webui' | 'agent'
const NAMES: Record<UpdateDialogTarget, string> = { webui: 'Talaria Web', agent: 'Hermes Agent' }

export function StatusIcon({ notification }: { notification: UpdateNotification }) {
  if (notification.severity === 'critical' || notification.phase === 'failed' || notification.phase === 'unknown') return <CircleAlert className="size-5 text-error" aria-hidden="true" />
  if (notification.phase === 'succeeded') return <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
  if (notification.severity === 'warning' || notification.phase === 'blocked' || notification.phase === 'awaiting_confirmation') return <Clock3 className="size-5 text-warning" aria-hidden="true" />
  return <LoaderCircle className={cn('size-5 text-accent-text', notification.active && 'animate-spin')} aria-hidden="true" />
}

/**
 * The Updating dialog for an update this tab started from Settings. `row` is the server's record for that
 * operation and owns every phase and outcome shown; before it arrives the dialog only says the update is
 * starting, or that the server's answer is outstanding. It never infers success from reachability.
 */
export function UpdatingDialog({ target, row, message, lost, reconnecting, checking, onCheckAgain, onClose }: {
  target: UpdateDialogTarget
  row: UpdateNotification | null
  /** The server's answer when it returned no operation record. */
  message: string | null
  /** The apply request lost the server before answering. */
  lost: boolean
  reconnecting: boolean
  checking: boolean
  onCheckAgain: () => void
  onClose: () => void
}) {
  const unverified = !row && !message && lost && !reconnecting
  const text = row?.message ?? message ?? (unverified ? m.update_dialog_unverified() : lost ? m.update_dialog_waiting() : m.update_dialog_starting())
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={m.update_dialog_title({ name: NAMES[target] })} className="max-[641px]:w-[calc(100vw-16px)]">
      <div role="status" className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {row ? <StatusIcon notification={row} />
            : message || unverified ? <CircleAlert className="size-5 text-warning" aria-hidden="true" />
              : <LoaderCircle className="size-5 animate-spin text-accent-text" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1 text-sm leading-5">
          <p className="text-text">{text}</p>
          {row?.detail && <p className="mt-1 whitespace-pre-line break-words text-muted">{row.detail}</p>}
          {reconnecting && <p className="mt-1 text-muted">{m.update_dialog_reconnecting()}</p>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {unverified && <Button onClick={onCheckAgain} disabled={checking}>{m.update_dialog_check_again()}</Button>}
        <Button variant="primary" onClick={onClose}>{m.close()}</Button>
      </div>
    </Dialog>
  )
}
