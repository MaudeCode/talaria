import { useResourceMutation } from './useResourceMutation'
import { useSessionPin } from './useSessionPin'
import { discardSession } from '../../stream/connection'
import { discardStagedFiles } from '../composer/useDraft'
import { createContext, useContext, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { SessionRow, SessionsList } from '../../contracts'
import { appUrl } from '../../lib/appRoot'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Button, IconButton } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { WorktreeRemoveDialog } from './WorktreeRemoveDialog'

type ActionKind = 'rename' | 'delete' | 'move' | 'revoke' | 'worktree'
/** An open session dialog and its draft; `list` is the list element its menu sat in, where focus returns on close. */
interface PendingAction { sid: string; kind: ActionKind; active: boolean; list: Element | null; title: string; projectId: string }

/** The server permission each dialog needs: the menu offers it, and a refreshed row that withdraws it closes the dialog. */
const allowed: Record<ActionKind, (row: SessionRow) => boolean> = {
  rename: (row) => !row.read_only,
  move: (row) => !row.read_only,
  delete: (row) => !row.read_only,
  worktree: (row) => !!row.worktree_branch && !row.read_only,
  revoke: (row) => !!row.share_url,
}

const OpenAction = createContext<((action: PendingAction) => void) | null>(null)

/**
 * TAL-1119: one owner for a list's session dialogs and drafts, outside its rows, so a refresh that moves a row to
 * another group (Older to Today, a pin from another device) keeps the open dialog. `rows` are the rows the list shows
 * now: a dialog reads its session's current row there, and closes once the session is gone or no longer allows it.
 */
export function SessionActions({ rows, children }: { rows: readonly SessionRow[]; children: ReactNode }) {
  const [pending, setPending] = useState<PendingAction | null>(null)
  const row = pending ? rows.find((r) => r.session_id === pending.sid) : undefined
  const shown = pending && row && allowed[pending.kind](row) ? pending : null
  if (pending && !shown) setPending(null)
  return (
    <OpenAction.Provider value={setPending}>
      {children}
      <SessionActionDialogs pending={shown} row={row} onChange={setPending} />
    </OpenAction.Provider>
  )
}

/** The session's actions trigger as the list shows it now; a regrouped row has a new one. */
function currentTrigger({ list, sid }: PendingAction) {
  const item = [...(list?.querySelectorAll<HTMLElement>('[data-sid]') ?? [])].find((el) => el.dataset.sid === sid)
  return item?.querySelector<HTMLElement>('.session-actions-trigger') ?? null
}

function SessionActionDialogs({ pending, row, onChange }: { pending: PendingAction | null; row: SessionRow | undefined; onChange: (action: PendingAction | null) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.fetchProjects, staleTime: 60_000, enabled: pending?.kind === 'move' })
  const fail = (e: unknown) => showErrorToast(e)
  const rename = useResourceMutation({ resource: ({ sid }: { sid: string; title: string }) => `session:${sid}`, effect: ({ title }) => ({ fields: { title } }), mutationFn: ({ sid, title }) => api.renameSession(sid, title), onError: fail })
  const del = useResourceMutation({
    resource: (sid: string) => `session:${sid}`,
    effect: () => ({ remove: true }),
    mutationFn: (sid) => api.deleteSession(sid),
    onSuccess: (_, sid) => {
      discardSession(sid)
      discardStagedFiles(sid)
      qc.setQueriesData<SessionsList>({ predicate: (query) => query.queryKey[0] === 'sessions' && (query.queryKey[1] === 'list' || query.queryKey[1] === 'search') }, (data) => data ? { ...data, sessions: data.sessions.filter((item) => item.session_id !== sid) } : data)
      qc.removeQueries({ predicate: (query) => query.queryKey[0] === 'sessions' && query.queryKey[1] !== 'list' && query.queryKey[1] !== 'search' && query.queryKey[2] === sid })
      showToast(m.session_deleted())
    },
    onError: fail,
  })
  const move = useResourceMutation({ resource: ({ sid }: { sid: string; projectId: string }) => `session:${sid}`, effect: ({ projectId }) => ({ fields: { project_id: projectId || null } }), mutationFn: ({ sid, projectId }) => api.moveSession(sid, projectId || null), onError: fail })
  const revoke = useResourceMutation({
    resource: (sid: string) => `session:${sid}`,
    effect: () => ({ fields: { share_url: null } }),
    mutationFn: (sid) => api.revokeShare(sid),
    onSuccess: () => showToast(m.share_session_revoked()),
    onError: (e) => showToast(m.share_session_revoke_failed() + (e instanceof Error ? e.message : ''), 4000, 'error'),
  })
  if (!pending || !row) return null
  const { sid, kind, title, projectId } = pending
  const close = () => onChange(null)
  const dismiss = (open: boolean) => { if (!open) close() }
  const finalFocus = () => currentTrigger(pending) ?? true
  if (kind === 'rename') return (
    <Dialog open onOpenChange={dismiss} finalFocus={finalFocus} title={m.session_rename()} description={m.session_rename_desc()}>
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) { rename.mutate({ sid, title: title.trim() }); close() } }} className="flex flex-col gap-3">
        <TextInput value={title} onChange={(e) => onChange({ ...pending, title: e.target.value })} placeholder={m.session_rename_placeholder()} aria-label={m.session_rename()} maxLength={300} />
        <div className="flex justify-end gap-2"><Button onClick={close}>{m.cancel()}</Button><Button type="submit" variant="primary">{m.save()}</Button></div>
      </form>
    </Dialog>
  )
  if (kind === 'move') return (
    <Dialog open onOpenChange={dismiss} finalFocus={finalFocus} title={m.session_move_project()} description={row.project_id ? m.session_move_project_desc_has() : m.session_move_project_desc_none()}>
      <form onSubmit={(e) => { e.preventDefault(); move.mutate({ sid, projectId }); close() }} className="flex flex-col gap-3">
        <Select value={projectId} onValueChange={(v) => onChange({ ...pending, projectId: v })} aria-label={m.session_move_project()} className="w-full">
          <option value="">—</option>
          {(projects.data?.projects ?? []).map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
        </Select>
        <div className="flex justify-end gap-2"><Button onClick={close}>{m.cancel()}</Button><Button type="submit" variant="primary">{m.save()}</Button></div>
      </form>
    </Dialog>
  )
  if (kind === 'worktree') return <WorktreeRemoveDialog sessionId={sid} onClose={close} finalFocus={finalFocus} />
  if (kind === 'revoke') return <ConfirmDialog open onOpenChange={dismiss} finalFocus={finalFocus} title={m.session_share_revoke()} description={m.stop_sharing_session_confirm()} confirmLabel={m.session_share_revoke()} cancelLabel={m.cancel()} danger onConfirm={() => revoke.mutate(sid)} />
  return <ConfirmDialog open onOpenChange={dismiss} finalFocus={finalFocus} title={m.session_delete_confirm()} description={row.worktree_branch ? m.session_delete_worktree_desc() : m.session_delete_desc()} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => { del.mutate(sid); if (pending.active) void navigate({ to: '/', search: { action: 'new-chat' } }) }} />
}

/** A row's kebab menu. The row's right-click and long-press menu shows the same `SessionMenuItems` (TAL-699). */
export function SessionContextMenu({ row, active }: { row: SessionRow; active: boolean }) {
  const open = useContext(OpenAction)
  const ref = useRef<HTMLSpanElement>(null)
  // Outside a list, the menu owns its dialogs.
  if (!open) return <SessionActions rows={[row]}><SessionContextMenu row={row} active={active} /></SessionActions>
  return (
    <span ref={ref} className="contents" onClick={(e) => e.stopPropagation()}>
      <Menu
        label={m.session_menu()}
        align="end"
        trigger={
          <IconButton label={m.session_menu()} className="session-actions-trigger" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </IconButton>
        }
      >
        <SessionMenuItems row={row} active={active} anchor={ref} />
      </Menu>
    </span>
  )
}

/**
 * The conversation's actions, mounted only while a menu shows them; every mutation invalidates the session list family.
 * `anchor` sits inside the row, so a dialog returns focus to the row's list. Render inside `SessionActions`.
 */
export function SessionMenuItems({ row, active, anchor }: { row: SessionRow; active: boolean; anchor: RefObject<Element | null> }) {
  const open = useContext(OpenAction)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const sid = row.session_id
  const openAction = (kind: ActionKind) => open?.({ sid, kind, active, list: anchor.current?.closest('[role="list"]') ?? null, title: row.title, projectId: row.project_id ?? '' })
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.sessions.all }) }
  // `row` is the displayed row, so a repeated toggle targets the state the user sees.
  const pin = useSessionPin()
  const archive = useResourceMutation({ resource: () => `session:${sid}`, effect: (archived: boolean) => ({ fields: { archived } }), mutationFn: (archived) => api.archiveSession(sid, archived), onSuccess: (_, archived) => { if (archived) showToast(m.session_archived()) }, onError: (e) => showToast(m.session_archive_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const duplicate = useMutation({ mutationFn: () => api.duplicateSession(sid), onSuccess: (r) => { showToast(m.session_duplicated()); invalidate(); void navigate({ to: '/session/$sessionId', params: { sessionId: r.session.session_id } }) }, onError: (e) => showToast(m.session_duplicate_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const regen = useMutation({ mutationFn: () => api.regenerateTitle(sid), onSuccess: (r) => { showToast(r.title ? m.session_title_regenerated({ title: r.title }) : m.session_title_regenerating()); invalidate() }, onError: (e) => showToast(m.session_title_regenerate_failed() + (e instanceof Error ? e.message : ''), 4000, 'error') })
  const shareUrl = row.share_url
  /** Copy the server's share URL; when the clipboard refuses, the toast carries the link instead. */
  const copyShareLink = async (url: string) => {
    const href = appUrl(url).href
    try { await navigator.clipboard.writeText(href); showToast(m.share_session_link_copied()) } catch { showToast(`${m.share_session_status_active()} — ${href}`, 6000) }
  }
  // Creating a share again refreshes its snapshot from the latest visible messages and keeps the token.
  const share = useMutation({
    mutationFn: () => api.createShare(sid),
    onSuccess: async (r) => { await copyShareLink(r.share.url); invalidate() },
    onError: (e) => showToast(m.share_session_failed() + (e instanceof Error ? e.message : ''), 4000, 'error'),
  })
  const sessionUrl = () => appUrl(`session/${encodeURIComponent(sid)}`).href
  const copyLink = () => {
    void navigator.clipboard.writeText(sessionUrl()).then(() => showToast(m.copied()), () => showToast(m.session_link_copy_failed(), 3000, 'error'))
  }
  const exportAs = (format: 'json' | 'markdown' | 'html') => {
    const a = document.createElement('a')
    a.href = appUrl(api.exportSessionUrl(sid, format)).href
    a.download = ''
    a.rel = 'noopener'
    a.click()
  }
  return (
    <>
      {/* The row's menu replaces the browser's link menu, so it carries Open in new tab. */}
      <MenuItem onClick={() => window.open(sessionUrl(), '_blank', 'noopener')}>{m.session_open_new_tab()}</MenuItem>
      <MenuSeparator />
      {allowed.rename(row) && <MenuItem onClick={() => openAction('rename')}>{m.session_rename()}</MenuItem>}
      {!row.read_only && <MenuItem onClick={() => regen.mutate()}>{m.session_title_regenerate()}</MenuItem>}
      {row.can_pin && <MenuItem onClick={() => pin.mutate({ id: sid, pinned: !row.pinned, group: row.sidebar_group })}>{row.pinned ? m.session_unpin() : m.session_pin()}</MenuItem>}
      {allowed.move(row) && <MenuItem onClick={() => openAction('move')}>{m.session_move_project()}</MenuItem>}
      <MenuSeparator />
      <MenuItem onClick={copyLink}>{m.session_copy_link()}</MenuItem>
      {shareUrl
        ? <>
            <MenuItem onClick={() => { void copyShareLink(shareUrl) }}>{m.session_share_copy_link()}</MenuItem>
            {row.can_share && <MenuItem onClick={() => share.mutate()}>{m.share_session_refresh_snapshot()}</MenuItem>}
            <MenuItem className="text-error" onClick={() => openAction('revoke')}>{m.session_share_revoke()}</MenuItem>
          </>
        : row.can_share && <MenuItem onClick={() => share.mutate()}>{m.session_share()}</MenuItem>}
      {row.can_duplicate && <MenuItem onClick={() => duplicate.mutate()}>{m.session_duplicate()}</MenuItem>}
      <MenuItem onClick={() => exportAs('json')}>{m.session_export_json()}</MenuItem>
      <MenuItem onClick={() => exportAs('markdown')}>{m.session_export_markdown()}</MenuItem>
      <MenuItem onClick={() => exportAs('html')}>{m.session_export_html()}</MenuItem>
      <MenuSeparator />
      {allowed.worktree(row) && <MenuItem className="text-error" onClick={() => openAction('worktree')}>{m.session_worktree_remove()}</MenuItem>}
      {row.can_archive && <MenuItem onClick={() => archive.mutate(!row.archived)}>{row.archived ? m.session_unarchive() : m.session_archive()}</MenuItem>}
      {allowed.delete(row) && <MenuItem className="text-error" onClick={() => openAction('delete')}>{m.session_delete()}</MenuItem>}
    </>
  )
}
