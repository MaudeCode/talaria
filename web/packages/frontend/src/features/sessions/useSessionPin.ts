import * as api from '../../api/endpoints'
import { m } from '../../paraglide/messages.js'
import { showToast } from '../toast/toast'
import { useResourceMutation } from './useResourceMutation'

/** Menu and drop share the existing resource owner, rollback and reconciliation. */
export function useSessionPin() {
  return useResourceMutation({
    resource: ({ id }: { id: string; pinned: boolean }) => `session:${id}`,
    effect: ({ pinned }) => ({ fields: { pinned, sidebar_group: pinned ? 'pinned' : 'recent' } }),
    mutationFn: ({ id, pinned }) => api.pinSession(id, pinned),
    onError: (e) => showToast(m.session_pin_failed() + (e instanceof Error ? e.message : ''), 4000, 'error'),
  })
}
