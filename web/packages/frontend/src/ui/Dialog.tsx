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
}

/** Modal dialog: focus trap, escape, backdrop click, and aria wiring via Base UI. */
export function Dialog({ open, onOpenChange, title, description, children, className }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[1300] bg-black/50" />
        <BaseDialog.Popup className={cn('fixed left-1/2 top-1/2 z-[1301] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 text-text shadow-md outline-none', className)}>
          <BaseDialog.Title className="text-base font-semibold text-strong">{title}</BaseDialog.Title>
          {description && <BaseDialog.Description className="mt-1 text-sm text-muted">{description}</BaseDialog.Description>}
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
}

/** Destructive confirmation (alert dialog semantics: no outside-click dismissal). */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, danger, onConfirm }: ConfirmDialogProps) {
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="fixed inset-0 z-[1300] bg-black/50" />
        <BaseAlertDialog.Popup className="fixed left-1/2 top-1/2 z-[1301] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 text-text shadow-md outline-none">
          <BaseAlertDialog.Title className="text-base font-semibold text-strong">{title}</BaseAlertDialog.Title>
          {description && <BaseAlertDialog.Description className="mt-1 text-sm text-muted">{description}</BaseAlertDialog.Description>}
          <div className="mt-4 flex justify-end gap-2">
            <BaseAlertDialog.Close className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-hover">{cancelLabel}</BaseAlertDialog.Close>
            <button
              type="button"
              className={cn('rounded-md px-3 py-1.5 text-sm font-medium', danger ? 'bg-error text-white' : 'bg-accent text-accent-fg')}
              onClick={() => {
                void Promise.resolve(onConfirm()).finally(() => onOpenChange(false))
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  )
}
