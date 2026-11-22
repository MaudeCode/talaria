import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArchiveRestore, CheckCheck, Trash2, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { SessionRow } from '../../contracts'
import { IconButton } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/Dialog'
import { showErrorToast } from '../toast/errorToast'
import { forgetDeletedSessions } from './SessionContextMenu'
import { useResourceMutation } from './useResourceMutation'

type BulkAction = 'archive' | 'unarchive' | 'delete'

/**
 * TAL-606: the Chats list's select mode bar, after the App's `SessionSelectionBar`. Each action is one `sessions.bulk`
 * call over the selected rows the server allows it on; the rows change at once, and the ids the server refuses come
 * back selected with its reason.
 */
export function SessionSelectionBar({ rows, selectable, onSelected, showArchived, activeId, onDone }: {
  /** The selected rows as the list shows them. */
  rows: readonly SessionRow[]
  /** The ids Select all chooses. */
  selectable: readonly string[]
  onSelected: (ids: string[]) => void
  showArchived: boolean
  activeId: string | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const bulk = useResourceMutation({
    resource: ({ ids }: { action: BulkAction; ids: string[] }) => ids.map((id) => `session:${id}`),
    effect: ({ action }) => action === 'delete' ? { remove: true } : { fields: { archived: action === 'archive' } },
    mutationFn: ({ action, ids }) => api.bulkSessions(action, ids),
    onSuccess: ({ results }, { action }) => {
      if (action === 'delete') forgetDeletedSessions(qc, results.flatMap((r) => (r.ok ? [r.session_id] : [])))
      const failed = results.filter((r) => !r.ok)
      if (!failed.length) { onDone(); return }
      onSelected(failed.map((r) => r.session_id))
      showErrorToast(new Error(failed[0]?.error ?? m.error_generic()), action === 'delete' ? m.delete_failed() : m.session_archive_failed())
    },
    onError: (e) => showErrorToast(e),
  })
  const ids = (allowed: (row: SessionRow) => boolean) => rows.filter(allowed).map((r) => r.session_id)
  const archiveIds = ids((r) => r.can_archive && !r.archived)
  const unarchiveIds = ids((r) => r.can_archive && !!r.archived)
  const deleteIds = ids((r) => r.can_delete)
  const worktrees = rows.filter((r) => r.can_delete && r.worktree_branch).length
  return (
    <div role="group" aria-label={m.session_select_mode_desc()} className="flex items-center gap-1 px-2 py-1 text-sm max-[641px]:px-3">
      <span className="min-w-0 flex-1 truncate text-muted" role="status">{m.session_selected_count({ a0: rows.length })}</span>
      <IconButton variant="ghost" label={m.session_select_all()} disabled={!selectable.length} onClick={() => onSelected([...selectable])}><CheckCheck aria-hidden="true" /></IconButton>
      <IconButton variant="ghost" label={m.session_batch_archive()} disabled={!archiveIds.length} onClick={() => bulk.mutate({ action: 'archive', ids: archiveIds })}><Archive aria-hidden="true" /></IconButton>
      {showArchived && <IconButton variant="ghost" label={m.session_batch_unarchive()} disabled={!unarchiveIds.length} onClick={() => bulk.mutate({ action: 'unarchive', ids: unarchiveIds })}><ArchiveRestore aria-hidden="true" /></IconButton>}
      <IconButton variant="danger" label={m.session_batch_delete()} disabled={!deleteIds.length} onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" /></IconButton>
      <IconButton variant="ghost" label={m.done()} onClick={onDone}><X aria-hidden="true" /></IconButton>
      <ConfirmDialog
        open={confirming} onOpenChange={setConfirming} danger
        title={deleteIds.length === 1 ? m.session_delete_confirm() : m.session_batch_delete_confirm({ a0: deleteIds.length })}
        description={worktrees ? m.session_batch_delete_worktree_confirm({ a0: deleteIds.length, a1: worktrees }) : undefined}
        confirmLabel={m.delete()} cancelLabel={m.cancel()}
        onConfirm={() => {
          bulk.mutate({ action: 'delete', ids: deleteIds })
          if (activeId && deleteIds.includes(activeId)) void navigate({ to: '/', search: { action: 'new-chat' } })
        }}
      />
    </div>
  )
}
