import type { LinkSafetyModalProps } from 'streamdown'
import { Dialog } from '../../../ui/Dialog'
import { Button } from '../../../ui/Button'
import { m } from '../../../paraglide/messages.js'

/** Streamdown's link warning in the app dialog; Base UI owns focus, Escape, and backdrop dismissal. `host` is the server's answer, absent when it gave none. */
export function LinkSafetyDialog({ isOpen, onClose, onConfirm, url, host }: LinkSafetyModalProps & { host?: string | null | undefined }) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }} title={m.link_safety_title()} description={host ? m.link_safety_description({ host }) : m.link_safety_description_unknown()}>
      <p className="max-h-32 overflow-y-auto break-all rounded-md border border-border-subtle bg-bg px-3 py-2 font-mono text-xs text-muted">{url}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{m.cancel()}</Button>
        <Button variant="primary" onClick={() => { onConfirm(); onClose() }}>{m.link_safety_open()}</Button>
      </div>
    </Dialog>
  )
}
