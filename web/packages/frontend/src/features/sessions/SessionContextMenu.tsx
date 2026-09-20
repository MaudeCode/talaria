import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { SessionRow } from '../../contracts'
import { appUrl } from '../../lib/appRoot'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Button, IconButton } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { showToast } from '../toast/toast'
import { useQuery } from '@tanstack/react-query'

type PendingDialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'move' } | null

/** Per-row conversation actions (legacy long-press / kebab menu). Every mutation invalidates the session list family. */
export function SessionContextMenu({ row, active }: { row: SessionRow; active: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<PendingDialog>(null)
  const [title, setTitle] = useState(row.title)
  const [projectId, setProjectId] = useState(row.project_id ?? '')
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.fetchProjects, staleTime: 60_000, enabled: dialog?.kind === 'move' })
  const sid = row.session_id
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.sessions.all }) }
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const rename = useMutation({ mutationFn: () => api.renameSession(sid, title.trim()), onSuccess: () => { setDialog(null); invalidate(); void qc.invalidateQueries({ queryKey: keys.sessions.detail(sid) }) }, onError: fail })
  const pin = useMutation({ mutationFn: () => api.pinSession(sid, !row.pinned), onSuccess: invalidate, onError: (e) => showToast(m.session_pin_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const archive = useMutation({ mutationFn: () => api.archiveSession(sid, !row.archived), onSuccess: () => { showToast(m.session_archived()); invalidate() }, onError: (e) => showToast(m.session_archive_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const duplicate = useMutation({ mutationFn: () => api.duplicateSession(sid), onSuccess: (r) => { showToast(m.session_duplicated()); invalidate(); void navigate({ to: '/session/$sessionId', params: { sessionId: r.session.session_id } }) }, onError: (e) => showToast(m.session_duplicate_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const del = useMutation({ mutationFn: () => api.deleteSession(sid), onSuccess: () => { showToast(m.session_deleted()); invalidate(); if (active) void navigate({ to: '/', search: { action: 'new-chat' } }) }, onError: fail })
  const move = useMutation({ mutationFn: () => api.moveSession(sid, projectId || null), onSuccess: () => { setDialog(null); invalidate() }, onError: fail })
  const regen = useMutation({ mutationFn: () => api.regenerateTitle(sid), onSuccess: (r) => { showToast(r.title ? m.session_title_regenerated({ title: r.title }) : m.session_title_regenerating()); invalidate() }, onError: (e) => showToast(m.session_title_regenerate_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const share = useMutation({
    mutationFn: () => (row.share_token ? api.revokeShare(sid) : api.createShare(sid)),
    onSuccess: async (r) => {
      if (row.share_token) showToast(m.share_session_revoked())
      else {
        const token = ('token' in r && typeof r.token === 'string' ? r.token : undefined) ?? ('share' in r && r.share && typeof r.share === 'object' && 'token' in r.share ? (r.share as { token?: string }).token : undefined)
        if (token) {
          await navigator.clipboard.writeText(appUrl(`share/${encodeURIComponent(token)}`).href).catch(() => undefined)
          showToast(m.session_share_copied())
        } else showToast(m.share_session_created())
      }
      invalidate()
    },
    onError: fail,
  })
  const copyLink = () => {
    void navigator.clipboard.writeText(appUrl(`session/${encodeURIComponent(sid)}`).href).then(() => showToast(m.copied()), () => showToast(m.session_link_copy_failed(), 3000, 'error'))
  }
  const exportAs = (format: 'json' | 'html') => {
    const a = document.createElement('a')
    a.href = appUrl(api.exportSessionUrl(sid, format)).href
    a.download = ''
    a.rel = 'noopener'
    a.click()
  }
  return (
    <>
      <Menu
        label={m.session_menu()}
        align="end"
        trigger={
          <IconButton label={m.session_menu()} className="session-actions-trigger" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </IconButton>
        }
      >
        <MenuItem onClick={() => { setTitle(row.title); setDialog({ kind: 'rename' }) }}>{m.session_rename()}</MenuItem>
        <MenuItem onClick={() => regen.mutate()}>{m.session_title_regenerate()}</MenuItem>
        <MenuItem onClick={() => pin.mutate()}>{row.pinned ? m.session_unpin() : m.session_pin()}</MenuItem>
        <MenuItem onClick={() => { setProjectId(row.project_id ?? ''); setDialog({ kind: 'move' }) }}>{m.session_move_project()}</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={copyLink}>{m.session_copy_link()}</MenuItem>
        <MenuItem onClick={() => share.mutate()}>{row.share_token ? m.session_share_revoke() : m.session_share()}</MenuItem>
        <MenuItem onClick={() => duplicate.mutate()}>{m.session_duplicate()}</MenuItem>
        <MenuItem onClick={() => exportAs('json')}>{m.session_export_json()}</MenuItem>
        <MenuItem onClick={() => exportAs('html')}>{m.session_export_html()}</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => archive.mutate()}>{row.archived ? m.session_unarchive() : m.session_archive()}</MenuItem>
        <MenuItem className="text-error" onClick={() => setDialog({ kind: 'delete' })}>{m.session_delete()}</MenuItem>
      </Menu>
      {dialog?.kind === 'rename' && (
        <Dialog open onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.session_rename()} description={m.session_rename_desc()}>
          <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) rename.mutate() }} className="flex flex-col gap-3">
            <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={m.session_rename_placeholder()} aria-label={m.session_rename()} maxLength={300} />
            <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={rename.isPending}>{m.save()}</Button></div>
          </form>
        </Dialog>
      )}
      {dialog?.kind === 'move' && (
        <Dialog open onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.session_move_project()} description={row.project_id ? m.session_move_project_desc_has() : m.session_move_project_desc_none()}>
          <form onSubmit={(e) => { e.preventDefault(); move.mutate() }} className="flex flex-col gap-3">
            <Select value={projectId} onValueChange={(v) => setProjectId(v)} aria-label={m.session_move_project()} className="w-full">
              <option value="">—</option>
              {(projects.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={move.isPending}>{m.save()}</Button></div>
          </form>
        </Dialog>
      )}
      <ConfirmDialog open={dialog?.kind === 'delete'} onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.session_delete_confirm()} description={row.worktree_branch ? m.session_delete_worktree_desc() : m.session_delete_desc()} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => del.mutate()} />
    </>
  )
}
