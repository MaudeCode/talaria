import { m } from '../../paraglide/messages.js'
import type { ResourceIntent } from './useResourceMutation'

/** Extends the existing inline status treatment, shared by project, sidebar and detail. */
export function ResourcePending({ intent }: { intent: ResourceIntent | undefined }) {
  if (!intent) return null
  return <span role="status" className="text-[11px] text-muted" data-resource-pending>{m.resource_change_pending({ action: intent.label })}{intent.recover && <> <button type="button" className="linklike" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void intent.recover?.().catch(() => undefined) }}>{m.retry()}</button></>}</span>
}
