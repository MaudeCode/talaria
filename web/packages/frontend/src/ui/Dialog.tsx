import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog'
import type { ReactNode } from 'react'
import { cn } from './cn'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string | undefined
  children?: ReactNode
  className?: string | undefined
  /** Replaces the title's default size and weight. */
  titleClassName?: string | undefined
  /** Where focus goes on close; by default the element focused before it opened. */
  finalFocus?: BaseDialog.Popup.Props['finalFocus']
}

/** Modal dialog: focus trap, escape, backdrop click, and aria wiring via Base UI. */
export function Dialog({ open, onOpenChange, title, description, children, className, titleClassName, finalFocus }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[1300] bg-black/50" />
        <BaseDialog.Popup finalFocus={finalFocus} className={cn('fixed left-1/2 top-1/2 z-[1301] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 text-text shadow-md outline-none', className)}>
          <BaseDialog.Title className={cn('text-strong [overflow-wrap:anywhere]', titleClassName ?? 'text-base font-semibold')}>{title}</BaseDialog.Title>
          {description && <BaseDialog.Description className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">{description}</BaseDialog.Description>}
          <div className="mt-4">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string | undefined
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  /** A second, destructive way to confirm, beside the main one (TAL-1260: Restore everything). */
  alternate?: { label: string; onConfirm: () => void | Promise<void> } | undefined
  finalFocus?: DialogProps['finalFocus']
  /** Structured detail the confirmation binds (TAL-1563: the exact replay a user consents to). */
  children?: ReactNode
}

// The confirmed change shows at once (optimistic writes); the dialog never waits for the server.
// Module scope: React Compiler cannot lower try/finally inside a component.
function confirmThenClose(confirm: () => void | Promise<void>, close: () => void) {
  try { void Promise.resolve(confirm()).catch(() => undefined) } finally { close() }
}

/** Destructive confirmation (alert dialog semantics: no outside-click dismissal). */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, danger, onConfirm, alternate, finalFocus, children }: ConfirmDialogProps) {
  const action = (label: string, destructive: boolean | undefined, confirm: () => void | Promise<void>) => (
    <button
      type="button"
      className={cn('rounded-md px-3 py-1.5 text-sm font-medium', destructive ? 'bg-error text-white' : 'bg-accent text-accent-fg')}
      onClick={() => { confirmThenClose(confirm, () => onOpenChange(false)) }}
    >
      {label}
    </button>
  )
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="fixed inset-0 z-[1300] bg-black/50" />
        <BaseAlertDialog.Popup finalFocus={finalFocus} className="fixed left-1/2 top-1/2 z-[1301] max-h-[90dvh] overflow-y-auto w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 text-text shadow-md outline-none">
          <BaseAlertDialog.Title className="text-base font-semibold text-strong">{title}</BaseAlertDialog.Title>
          {description && <BaseAlertDialog.Description className="mt-1 whitespace-pre-line text-sm text-muted [overflow-wrap:anywhere]">{description}</BaseAlertDialog.Description>}
          {children}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <BaseAlertDialog.Close className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-hover">{cancelLabel}</BaseAlertDialog.Close>
            {alternate && action(alternate.label, true, alternate.onConfirm)}
            {action(confirmLabel, danger, onConfirm)}
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  )
}
