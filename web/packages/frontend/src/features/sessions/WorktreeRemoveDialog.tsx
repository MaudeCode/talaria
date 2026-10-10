import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorktreeStatus } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { showToast } from '../toast/toast'

/**
 * Remove a worktree chat's git worktree (TAL-605). The server's removal check, read fresh on open, decides whether
 * removal is blocked and whether it needs `force`; the dialog words that check and sends the server's `force_required`.
 */
export function WorktreeRemoveDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const worktree = useQuery({ queryKey: keys.sessions.worktree(sessionId), queryFn: () => api.fetchWorktreeStatus(sessionId), staleTime: 0, gcTime: 0 })
  const remove = useMutation({
    mutationFn: (force: boolean) => api.removeWorktree(sessionId, force),
    onSuccess: () => { onClose(); showToast(m.session_worktree_removed()); void qc.invalidateQueries({ queryKey: keys.sessions.all }) },
    onError: (e) => showToast(m.session_worktree_remove_failed() + (e instanceof Error ? e.message : ''), 4000, 'error'),
  })
  const status = worktree.data?.status
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.session_worktree_remove()} description={status ? m.session_worktree_remove_desc({ path: status.path }) : undefined}>
      <WorktreeRemoveCheck status={status} error={worktree.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{m.cancel()}</Button>
        <Button variant="danger" disabled={!status?.removable || remove.isPending} onClick={() => { if (status) remove.mutate(status.force_required) }}>
          {status?.force_required ? m.session_worktree_force_remove() : m.session_worktree_remove_confirm_label()}
        </Button>
      </div>
    </Dialog>
  )
}

/** The removal check in words: what blocks removal, or what a forced removal loses. */
function WorktreeRemoveCheck({ status, error }: { status: WorktreeStatus | undefined; error: Error | null }) {
  if (error) return <p className="text-sm text-error" role="alert">{m.session_worktree_remove_status_failed() + error.message}</p>
  if (!status) return <p className="text-sm text-muted">{m.loading()}</p>
  if (!status.exists) return <p className="text-sm text-muted">{m.session_worktree_remove_not_exists({ path: status.path })}</p>
  if (!status.removable) return <p className="text-sm text-error" role="alert">{status.locked_by_stream ? m.session_worktree_remove_locked_by_stream() : m.session_worktree_remove_locked_by_terminal()}</p>
  if (!status.force_required) return null
  return (
    <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-warning">
      {status.dirty && <li>{m.session_worktree_remove_dirty_warning()}</li>}
      {status.untracked_count > 0 && <li>{m.session_worktree_remove_untracked_warning({ count: status.untracked_count })}</li>}
      {status.ahead_behind.ahead > 0 && <li>{m.session_worktree_remove_ahead_warning({ ahead: status.ahead_behind.ahead })}</li>}
    </ul>
  )
}
