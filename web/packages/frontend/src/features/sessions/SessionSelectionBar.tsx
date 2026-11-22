import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArchiveRestore, CheckCheck, Trash2, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { SessionRow } from '../../contracts'
import { SESSIONS_BULK_MAX } from '@maudecode/talaria-web-contracts'
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
export function SessionSelectionBar({ session, rows, selectable, onSelected, onResult, showArchived, activeId, onDone }: {
  /** The select mode visit this bar acts for; its results are reported against it. */
  session: string
  /** The selected rows as the list shows them. */
  rows: readonly SessionRow[]
  /** The ids Select all chooses. */
  selectable: readonly string[]
  onSelected: (ids: string[]) => void
  /** One bulk call's outcome: the ids it sent and those the server refused. */
  onResult: (session: string, sent: readonly string[], failed: readonly string[]) => void
  showArchived: boolean
  activeId: string | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const bulk = useResourceMutation({
    resource: ({ ids }: { action: BulkAction; ids: string[]; session: string }) => ids.map((id) => `session:${id}`),
    effect: ({ action }) => action === 'delete' ? { remove: true } : { fields: { archived: action === 'archive' } },
    mutationFn: ({ action, ids }) => api.bulkSessions(action, ids),
    // A 4xx for one id is that id's definite refusal: it comes back at once; any other failure waits for the next read.
    refused: ({ results }) => results.flatMap((r) => (!r.ok && r.status !== undefined && r.status >= 400 && r.status < 500 && r.status !== 408 ? [`session:${r.session_id}`] : [])),
    onSuccess: ({ results }, { action, ids, session }) => {
      if (action === 'delete') forgetDeletedSessions(qc, results.flatMap((r) => (r.ok ? [r.session_id] : [])))
      const failed = results.filter((r) => !r.ok)
      onResult(session, ids, failed.map((r) => r.session_id))
      if (failed.length) showErrorToast(new Error(failed[0]?.error ?? m.error_generic()), action === 'delete' ? m.delete_failed() : m.session_archive_failed())
    },
    onError: (e) => showErrorToast(e),
  })
  // The panel caps selection at the route's limit; a larger one (rows hidden by a filter, then shown again) acts on nothing.
  const ids = (allowed: (row: SessionRow) => boolean) => (rows.length > SESSIONS_BULK_MAX ? [] : rows.filter(allowed).map((r) => r.session_id))
  const archiveIds = ids((r) => r.can_archive && !r.archived)
  const unarchiveIds = ids((r) => r.can_archive && !!r.archived)
  const deleteIds = ids((r) => r.can_delete)
  const worktrees = rows.filter((r) => r.can_delete && r.worktree_branch).length
  return (
    <div role="group" aria-label={m.session_select_mode_desc()} className="flex items-center gap-1 px-2 py-1 text-sm max-[641px]:px-3">
      <span className="min-w-0 flex-1 truncate text-muted" role="status">{m.session_selected_count({ a0: rows.length })}</span>
      <IconButton variant="ghost" label={m.session_select_all()} disabled={!selectable.length} onClick={() => onSelected([...selectable])}><CheckCheck aria-hidden="true" /></IconButton>
      <IconButton variant="ghost" label={m.session_batch_archive()} disabled={!archiveIds.length} onClick={() => bulk.mutate({ action: 'archive', ids: archiveIds, session })}><Archive aria-hidden="true" /></IconButton>
      {showArchived && <IconButton variant="ghost" label={m.session_batch_unarchive()} disabled={!unarchiveIds.length} onClick={() => bulk.mutate({ action: 'unarchive', ids: unarchiveIds, session })}><ArchiveRestore aria-hidden="true" /></IconButton>}
      <IconButton variant="danger" label={m.session_batch_delete()} disabled={!deleteIds.length} onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" /></IconButton>
      <IconButton variant="ghost" label={m.done()} onClick={onDone}><X aria-hidden="true" /></IconButton>
      <ConfirmDialog
        open={confirming} onOpenChange={setConfirming} danger
        title={deleteIds.length === 1 ? m.session_delete_confirm() : m.session_batch_delete_confirm({ a0: deleteIds.length })}
        description={worktrees ? m.session_batch_delete_worktree_confirm({ a0: deleteIds.length, a1: worktrees }) : undefined}
        confirmLabel={m.delete()} cancelLabel={m.cancel()}
        onConfirm={() => {
          bulk.mutate({ action: 'delete', ids: deleteIds, session })
          if (activeId && deleteIds.includes(activeId)) void navigate({ to: '/', search: { action: 'new-chat' } })
        }}
      />
    </div>
  )
}
