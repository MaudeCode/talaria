import { m } from '../../paraglide/messages.js'
import type { ComponentProps } from 'react'
import { Switch } from '../../ui/Field'
import type { ResourceIntent } from './useResourceMutation'

/** Extends the existing inline status treatment, shared by project, sidebar and detail. */
export function ResourcePending({ intent }: { intent: ResourceIntent | undefined }) {
  if (!intent) return null
  return <span role="status" className="text-[11px] text-muted" data-resource-pending>{m.resource_change_pending({ action: intent.label })}{intent.recover && <> <button type="button" className="linklike" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void intent.recover?.().catch(() => undefined) }}>{m.retry()}</button></>}</span>
}

/** The existing switch with requested presentation; effective state stays in the server snapshot. */
export function ResourceSwitch({ intent, checked, disabled, ...props }: ComponentProps<typeof Switch> & { intent: ResourceIntent<boolean> | undefined }) {
  return <span className="inline-flex flex-wrap items-center justify-end gap-2">
    <ResourcePending intent={intent} />
    <Switch {...props} checked={intent?.value ?? checked} disabled={disabled || !!intent} aria-busy={!!intent || undefined} />
  </span>
}
