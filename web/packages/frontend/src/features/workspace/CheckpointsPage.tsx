/**
 * TAL-571: the right panel's Checkpoints page. It lists the Agent's file checkpoints for the chat's workspace as the
 * server reads them (newest first), shows each one's diff against the current files, and restores one behind a
 * confirmation: by default only the files the Agent last wrote, keeping the user's hand-edits, or everything (TAL-1260).
 * It loads only while shown, and each read is fresh: the Agent changes these files and checkpoints at will.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDiff, RotateCcw } from 'lucide-react'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { HelpTip } from '../../ui/Field'
import { Button, IconButton } from '../../ui/Button'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { ErrorState, LoadingState } from '../../ui/States'
import { showRichToast, showToast } from '../toast/toast'

interface Picked { id: string; message: string }

const listed = (files: string[], message: (inputs: { files: string }) => string): string[] => (files.length ? [message({ files: files.join(', ') })] : [])

/** `onRestored` gets the files a restore rewrote, so another page can drop its unsaved edits of them. */
export function CheckpointsPage({ workspace, sessionId, active, onRestored }: { workspace: string | null | undefined; sessionId: string; active: boolean; onRestored: (paths: string[]) => void }) {
  return <WorkspaceCheckpoints key={JSON.stringify(keys.checkpoints.all(sessionId, workspace ?? ''))} workspace={workspace ?? ''} sessionId={sessionId} active={active} onRestored={onRestored} />
}

function WorkspaceCheckpoints({ workspace, sessionId, active, onRestored }: { workspace: string; sessionId: string; active: boolean; onRestored: (paths: string[]) => void }) {
  const qc = useQueryClient()
  const [viewing, setViewing] = useState<Picked | null>(null)
  const [restoring, setRestoring] = useState<Picked | null>(null)
  const list = useQuery({ queryKey: keys.checkpoints.list(sessionId, workspace), queryFn: () => api.fetchCheckpoints(sessionId), enabled: active, staleTime: 0 })
  const restore = useMutation({
    mutationFn: ({ id, all }: { id: string; all: boolean }) => api.restoreCheckpoint(sessionId, id, all),
    onSuccess: (res) => {
      // The server answers 200 with per-file errors; any error makes this a failed restore, never a restored one.
      const failed = res.errors.map((e) => `${e.file}: ${e.error}`)
      // The files the restore left as they are; the server names each list.
      const kept = [...listed(res.kept_user_edits, m.checkpoint_kept_user_edits), ...listed(res.skipped_oversize, m.checkpoint_skipped_oversize)]
      if (failed.length) showToast(`${m.checkpoint_restore()}: ${[...failed, ...kept].join('; ')}`, 6000, 'error')
      else if (kept.length) showRichToast({ id: `checkpoint-restored-${workspace}`, title: m.checkpoint_restored(), text: kept.join(' · '), ttl: 10000, kind: 'info', dismissible: true, actions: [] })
      else showToast(m.checkpoint_restored())
      onRestored(res.files_restored)
      // The restore rewrote workspace files: drop every view of them.
      void Promise.all([
        qc.invalidateQueries({ queryKey: keys.checkpoints.all(sessionId, workspace) }),
        qc.invalidateQueries({ queryKey: keys.files.lists(workspace) }),
        qc.invalidateQueries({ queryKey: keys.files.contents(workspace) }),
        qc.invalidateQueries({ queryKey: keys.files.git(sessionId) }),
      ])
    },
    onError: (e) => showToast(`${m.checkpoint_restore()}: ${e instanceof Error ? e.message : String(e)}`, 6000, 'error'),
  })
  if (list.isPending) return <LoadingState label={m.checkpoint_loading()} />
  if (list.isError) return <ErrorState error={list.error} onRetry={() => { void list.refetch() }} />
  const { checkpoints, session_diff: native } = list.data
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {native ? (
        <div className="flex items-center gap-2 border-b border-border-subtle p-3">
          <Button onClick={() => setViewing({ id: native.checkpoint, message: '' })}>{m.checkpoint_view_diff()}</Button>
          <HelpTip label={m.checkpoint_project_baseline()}>{m.checkpoint_project_baseline_help()}</HelpTip>
        </div>
      ) : checkpoints.length === 0 ? (
        <div className="p-3 text-xs text-muted" role="status">{m.checkpoint_empty()}</div>
      ) : (
        <ul className="flex flex-col" aria-label={m.checkpoint_title()}>
          {checkpoints.map((c) => (
            <li key={c.id} className="flex min-w-0 items-center gap-1 border-b border-border-subtle py-1 pl-3 pr-1">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-text" title={c.message}>{c.message}</div>
                <div className="flex min-w-0 gap-1 text-[11px] text-muted">
                  <code className="truncate">{c.id}</code>
                  {c.date_display && <span className="shrink-0">· {c.date_display}</span>}
                  <span className="shrink-0">· {m.checkpoint_files()}: {c.files}</span>
                </div>
              </div>
              <IconButton label={m.checkpoint_view_diff()} onClick={() => setViewing({ id: c.id, message: c.message })}><FileDiff size={15} aria-hidden="true" /></IconButton>
              <IconButton label={m.checkpoint_restore()} disabled={restore.isPending} onClick={() => setRestoring({ id: c.id, message: c.message })}><RotateCcw size={15} aria-hidden="true" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      {viewing && <CheckpointDiff workspace={workspace} sessionId={sessionId} checkpoint={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => { if (!o) setRestoring(null) }}
        title={m.checkpoint_restore_confirm_title()}
        description={restoring ? m.checkpoint_restore_confirm_message({ ckpt: restoring.message }) : undefined}
        confirmLabel={m.checkpoint_restore()}
        cancelLabel={m.cancel()}
        onConfirm={() => { if (restoring) restore.mutate({ id: restoring.id, all: false }) }}
        alternate={{ label: m.checkpoint_restore_everything(), onConfirm: () => { if (restoring) restore.mutate({ id: restoring.id, all: true }) } }}
      />
    </div>
  )
}

function CheckpointDiff({ workspace, sessionId, checkpoint, onClose }: { workspace: string; sessionId: string; checkpoint: Picked; onClose: () => void }) {
  const diff = useQuery({ queryKey: keys.checkpoints.diff(sessionId, workspace, checkpoint.id), queryFn: () => api.fetchCheckpointDiff(sessionId, checkpoint.id), staleTime: 0, gcTime: 0 })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.checkpoint_diff_title()} description={checkpoint.message} className="flex max-h-[80vh] w-[min(92vw,800px)] flex-col">
      {diff.isPending && <LoadingState label={m.checkpoint_loading()} />}
      {diff.isError && <ErrorState error={diff.error} onRetry={() => { void diff.refetch() }} />}
      {diff.isSuccess && diff.data.comparison?.provenance === 'native_owner' && <div className="mb-2 text-xs text-muted">{m.checkpoint_project_baseline()} <HelpTip label={m.checkpoint_project_baseline()}>{m.checkpoint_project_baseline_help()}</HelpTip></div>}
      {diff.isSuccess && diff.data.comparison?.truncated && <div role="status" className="mb-2 text-xs text-warning">{m.checkpoint_diff_truncated()}</div>}
      {diff.isSuccess && (diff.data.comparison?.available === false ? (
        <div className="text-sm text-muted" role="status">{checkpointUnavailable(diff.data.comparison.reason)}</div>
      ) : diff.data.total_changes === 0 && !diff.data.comparison?.truncated ? (
        <div className="text-sm text-muted" role="status">{m.checkpoint_diff_no_changes()}</div>
      ) : (
        <div className="flex min-h-0 flex-col gap-2">
          <div className="text-xs text-text">{m.checkpoint_diff_files_changed({ n: diff.data.total_changes })}</div>
          <ul className="flex flex-col gap-0.5 text-xs" aria-label={m.checkpoint_diff_files_changed({ n: diff.data.total_changes })}>
            {diff.data.files_changed.map((f) => (
              <li key={f.file} className="flex gap-1.5" data-status={f.status}>
                <span aria-hidden="true" className={f.status === 'deleted' ? 'font-bold text-error' : 'font-bold text-accent-text'}>{f.status === 'deleted' ? '−' : '~'}</span>
                <code className="min-w-0 break-all">{f.file}</code>
              </li>
            ))}
          </ul>
          {diff.data.diff && <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-[11px] leading-snug text-pre-text">{diff.data.diff}</pre>}
        </div>
      ))}
      <div className="mt-3 flex justify-end"><Button onClick={onClose}>{m.close()}</Button></div>
    </Dialog>
  )
}

function checkpointUnavailable(reason: string | null): string {
  if (reason === 'checkpoints_disabled') return m.checkpoint_owner_disabled()
  if (reason === 'no_baseline') return m.checkpoint_no_baseline()
  return m.checkpoint_owner_unavailable()
}
