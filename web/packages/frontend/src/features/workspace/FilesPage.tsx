import { useState, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Download, Eye, EyeOff, File as FileIcon, FilePlus, Folder, FolderPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { appUrl } from '../../lib/appRoot'
import { Button, IconButton } from '../../ui/Button'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { TextInput } from '../../ui/Field'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { ErrorState, LoadingState, formatBytes } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { Markdown } from '../chat/render/Markdown'

function joinPath(dir: string, name: string): string {
  return dir === '.' || dir === '' ? name : `${dir.replace(/\/$/, '')}/${name}`
}
function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? parts.join('/') : '.'
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Drag payload for moving an entry onto a folder row or the Up button. */
const DRAG_TYPE = 'application/x-talaria-workspace-path'

interface Entry { path: string; name: string; isDir: boolean }
type Pending = { kind: 'new-file' } | { kind: 'new-folder' } | { kind: 'rename'; entry: Entry } | { kind: 'delete'; entry: Entry } | null

/** The right panel's Files page (TAL-373): directory tree, file preview/edit, git status. Its folder, preview and draft
 * stay while another page is shown; it fetches only while `active`. */
/** Files a checkpoint restore rewrote; `seq` tells one restore from the next. */
export interface RestoredFiles { seq: number; paths: string[] }

export function FilesPage({ workspace, sessionId, active, restored = null }: { workspace: string | null | undefined; sessionId: string; active: boolean; restored?: RestoredFiles | null }) {
  if (!workspace) return <div className="p-3 text-xs text-muted" role="status">{m.panel_files_unavailable()}</div>
  return <WorkspaceFiles key={workspace} workspace={workspace} sessionId={sessionId} active={active} restored={restored} />
}

function WorkspaceFiles({ workspace, sessionId, active, restored }: { workspace: string; sessionId: string; active: boolean; restored: RestoredFiles | null }) {
  const qc = useQueryClient()
  const [dir, setDir] = useState('.')
  const [showHidden, setShowHidden] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // TAL-571: a restore rewrote these files; a draft of one would put the pre-restore text back on Save, so it goes.
  const [seenRestore, setSeenRestore] = useState(restored?.seq)
  if (restored && restored.seq !== seenRestore) {
    setSeenRestore(restored.seq)
    if (file && restored.paths.includes(file)) setDraft(null)
  }
  const listing = useQuery({ queryKey: keys.files.list(workspace, dir, showHidden), queryFn: () => api.listDir(sessionId, dir, showHidden), staleTime: 10_000, enabled: active })
  const git = useQuery({ queryKey: keys.files.git(sessionId), queryFn: () => api.fetchGitInfo(sessionId), staleTime: 30_000, retry: false, enabled: active })
  const content = useQuery({ queryKey: keys.files.content(workspace, file ?? ''), queryFn: () => api.readFile(sessionId, file ?? ''), enabled: !!file && active, staleTime: 5_000 })
  const save = useMutation({ mutationFn: (text: string) => api.saveFile(sessionId, file ?? '', text), onSuccess: () => { showToast(m.ws_panel_saved()); setDraft(null); void qc.invalidateQueries({ queryKey: keys.files.content(workspace, file ?? '') }) }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  // A path can now name another file (rename, move, delete then create), so cached contents are dropped, not just marked stale.
  const refresh = () => {
    qc.removeQueries({ queryKey: keys.files.contents(workspace) })
    return Promise.all([qc.invalidateQueries({ queryKey: keys.files.lists(workspace) }), qc.invalidateQueries({ queryKey: keys.files.git(sessionId) })])
  }
  // Menu and drag operations report the server's refusal (symlink, conflict, missing) inline above the tree.
  const op = useMutation({ mutationFn: (call: () => Promise<unknown>) => call(), onMutate: () => setNotice(null), onError: (e) => setNotice(errorText(e)), onSettled: refresh })
  const go = (path: string) => { setNotice(null); setDir(path) }
  const dropProps = (dest: string) => ({
    onDragOver: (ev: DragEvent) => {
      if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'move'
      setDropTarget(dest)
    },
    onDragLeave: () => setDropTarget((t) => (t === dest ? null : t)),
    onDrop: (ev: DragEvent) => {
      const src = ev.dataTransfer.getData(DRAG_TYPE)
      setDropTarget(null)
      if (!src) return
      ev.preventDefault()
      if (src !== dest) op.mutate(() => api.moveEntry(sessionId, src, dest))
    },
  })
  const entries = (listing.data?.entries ?? []).slice().sort((a, b) => Number(!!b.is_dir) - Number(!!a.is_dir) || a.name.localeCompare(b.name))
  const g = git.data?.git
  // An older server sends no `preview`: its replies are always text, Markdown by extension. Delete once Stable sends it.
  const kind = content.data ? (content.data.preview ?? (/\.(md|markdown)$/i.test(file ?? '') ? 'markdown' : 'text')) : undefined
  // Markdown, CSV and HTML show their rendered form until Edit opens the text.
  const rendered = draft === null && (kind === 'markdown' || kind === 'csv' || kind === 'html')
  const text = draft ?? content.data?.content ?? ''
  const rawUrl = (inline?: boolean) => appUrl(api.rawFileUrl(sessionId, file ?? '', inline)).href
  return (
    <>
      <div className="flex items-center gap-1 border-b border-border-subtle px-3 py-1" data-files-toolbar>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={workspace}>{`${workspace}${g?.is_git && g.branch ? ` · ${g.branch}${g.dirty ? ` (${g.dirty}±)` : ''}` : ''}`}</span>
        <IconButton label={m.ws_panel_hidden()} active={showHidden} className="h-7 w-7" onClick={() => setShowHidden((h) => !h)}>{showHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}</IconButton>
        <IconButton label={m.refresh()} className="h-7 w-7" onClick={() => { void listing.refetch(); void git.refetch() }}><RefreshCw size={14} aria-hidden="true" /></IconButton>
      </div>
      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1 text-xs">
            <Button variant="ghost" onClick={() => { setFile(null); setDraft(null) }}><ArrowUp size={12} aria-hidden="true" /> {m.back()}</Button>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{file}</span>
            <a className="text-muted hover:text-text" href={rawUrl()} download aria-label={m.download_folder()}><Download size={14} aria-hidden="true" /></a>
          </div>
          {content.isPending && <LoadingState />}
          {content.isError && <ErrorState error={content.error} onRetry={() => { void content.refetch() }} />}
          {kind === 'binary' && <div className="p-3 text-xs text-muted">{m.ws_panel_binary({ size: formatBytes(content.data?.size) })}</div>}
          {/* Media and HTML frames mount only while the page is shown, so a hidden page stops playing; the selection stays. */}
          {active && (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') && (
            <div className="flex min-h-0 flex-1 flex-col">
              <MediaPreview kind={kind} name={file} src={rawUrl(kind === 'pdf')} />
              <div className="border-t border-border-subtle px-2 py-1.5 text-right text-[11px] text-muted">{formatBytes(content.data?.size)}</div>
            </div>
          )}
          {content.data && (kind === 'text' || rendered || draft !== null) && (
            <div className="flex min-h-0 flex-1 flex-col">
              {rendered && kind === 'markdown' && <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px]"><Markdown text={text} /></div>}
              {rendered && kind === 'csv' && <CsvTable rows={content.data.table ?? []} truncated={!!content.data.table_truncated} />}
              {rendered && kind === 'html' && active && (
                // The server's preview URL serves the page and its relative assets with a sandbox CSP; the frame sandbox
                // repeats it without same-origin. An older server's raw inline route serves the page alone.
                <iframe src={content.data.preview_url ? appUrl(content.data.preview_url).href : rawUrl(true)} title={file} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" className="min-h-0 w-full flex-1 border-0 bg-white" />
              )}
              {!rendered && (
                <textarea value={text} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={m.ws_panel_preview()} className="min-h-0 flex-1 resize-none bg-code-bg p-3 font-mono text-[12px] text-pre-text outline-none" />
              )}
              <div className="flex items-center gap-2 border-t border-border-subtle px-2 py-1.5">
                {rendered && <Button variant="ghost" onClick={() => setDraft(text)}>{m.edit()}</Button>}
                <Button variant="primary" disabled={draft === null || save.isPending} onClick={() => { if (draft !== null) save.mutate(draft) }}>{m.save()}</Button>
                {draft !== null && <Button variant="ghost" onClick={() => setDraft(null)}>{m.cancel()}</Button>}
                <span className="ml-auto text-[11px] text-muted">{content.data.truncated ? m.logs_truncated({ n: content.data.lines ?? 0 }) : formatBytes(content.data.size)}</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1 text-xs">
            <IconButton label={m.ws_panel_up()} className={cn('h-7 w-7', dropTarget === parentOf(dir) && dir !== '.' && 'bg-accent-bg')} disabled={dir === '.'} onClick={() => go(parentOf(dir))} {...(dir !== '.' ? dropProps(parentOf(dir)) : {})}><ArrowUp size={14} aria-hidden="true" /></IconButton>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{dir}</span>
            <IconButton label={m.new_file()} className="h-7 w-7" onClick={() => setPending({ kind: 'new-file' })}><FilePlus size={14} aria-hidden="true" /></IconButton>
            <IconButton label={m.new_folder()} className="h-7 w-7" onClick={() => setPending({ kind: 'new-folder' })}><FolderPlus size={14} aria-hidden="true" /></IconButton>
            <a className="text-muted hover:text-text" href={appUrl(api.folderDownloadUrl(sessionId, dir)).href} aria-label={m.ws_panel_download()}><Download size={14} aria-hidden="true" /></a>
          </div>
          {notice && (
            <div role="alert" className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs text-error">
              <span className="min-w-0 flex-1 break-words">{notice}</span>
              <IconButton label={m.close()} className="h-5 w-5" onClick={() => setNotice(null)}><X size={12} aria-hidden="true" /></IconButton>
            </div>
          )}
          <div className="file-tree min-h-0 flex-1 overflow-y-auto p-1" role="tree" aria-label={m.ws_panel_files()}>
            {listing.isPending && <LoadingState />}
            {listing.isError && <ErrorState error={listing.error} onRetry={() => { void listing.refetch() }} />}
            {listing.isSuccess && entries.length === 0 && <div className="p-3 text-xs text-muted">{m.ws_panel_empty()}</div>}
            {entries.map((e) => {
              const path = e.path ?? joinPath(dir, e.name)
              const isDir = !!e.is_dir || e.type === 'dir' || e.type === 'directory'
              const entry: Entry = { path, name: e.name, isDir }
              return (
                <div key={path} role="none" className={cn('group flex items-center rounded-md hover:bg-hover', e.hidden && 'opacity-60', dropTarget === path && 'bg-accent-bg')} {...(isDir ? dropProps(path) : {})}>
                  <button
                    type="button"
                    role="treeitem"
                    aria-label={e.name}
                    draggable
                    onDragStart={(ev) => { ev.dataTransfer.setData(DRAG_TYPE, path); ev.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => setDropTarget(null)}
                    onContextMenu={(ev) => { ev.preventDefault(); setMenuFor(path) }}
                    onClick={() => (isDir ? go(path) : setFile(path))}
                    className="file-item flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[12.5px] text-text"
                    title={path}
                  >
                    {isDir ? <Folder size={14} className="shrink-0 text-accent-text" aria-hidden="true" /> : <FileIcon size={14} className="shrink-0 text-muted" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {!isDir && e.size !== undefined && e.size !== null && <span className="text-[10px] text-muted">{formatBytes(e.size)}</span>}
                  </button>
                  <Menu
                    label={m.more_actions()}
                    align="end"
                    open={menuFor === path}
                    onOpenChange={(o) => setMenuFor(o ? path : null)}
                    trigger={<IconButton label={m.more_actions()} className="h-6 w-6 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"><MoreHorizontal size={14} aria-hidden="true" /></IconButton>}
                  >
                    <MenuItem onClick={() => setPending({ kind: 'rename', entry })}>{m.rename_title()}</MenuItem>
                    <MenuItem onClick={() => op.mutate(() => api.revealEntry(sessionId, path))}>{m.ws_panel_reveal()}</MenuItem>
                    <MenuItem onClick={() => op.mutate(() => api.openInVsCode(sessionId, path))}>{m.ws_panel_open_vscode()}</MenuItem>
                    <MenuSeparator />
                    <MenuItem className="text-error" onClick={() => setPending({ kind: 'delete', entry })}>{m.delete()}</MenuItem>
                  </Menu>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {pending?.kind === 'new-file' && <NameDialog title={m.new_file()} label={m.new_file_prompt()} confirmLabel={m.create()} onClose={() => setPending(null)} onSubmit={(name) => api.createFile(sessionId, joinPath(dir, name)).then(refresh)} />}
      {pending?.kind === 'new-folder' && <NameDialog title={m.new_folder()} label={m.new_folder_prompt()} confirmLabel={m.create()} onClose={() => setPending(null)} onSubmit={(name) => api.createDir(sessionId, joinPath(dir, name)).then(refresh)} />}
      {pending?.kind === 'rename' && <NameDialog title={m.rename_title()} label={m.rename_prompt()} initial={pending.entry.name} confirmLabel={m.save()} onClose={() => setPending(null)} onSubmit={(name) => api.renameEntry(sessionId, pending.entry.path, name).then(refresh)} />}
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(o) => { if (!o) setPending(null) }}
        title={pending?.kind === 'delete' ? (pending.entry.isDir ? m.delete_dir_confirm({ name: pending.entry.name }) : m.delete_confirm({ name: pending.entry.name })) : ''}
        confirmLabel={m.delete()}
        cancelLabel={m.cancel()}
        danger
        onConfirm={() => { if (pending?.kind === 'delete') { const { path, isDir } = pending.entry; op.mutate(() => api.deleteEntry(sessionId, path, isDir)) } }}
      />
    </>
  )
}

/** A media file streamed from the raw route; a PDF uses the frameable inline response. */
function MediaPreview({ kind, name, src }: { kind: 'image' | 'pdf' | 'audio' | 'video'; name: string; src: string }) {
  if (kind === 'pdf') return <iframe src={src} title={name} className="min-h-0 w-full flex-1 border-0 bg-white" />
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
      {kind === 'image' && <img src={src} alt={name} className="max-h-full max-w-full object-contain" />}
      {kind === 'audio' && <audio src={src} controls preload="metadata" aria-label={name} className="w-full" />}
      {kind === 'video' && <video src={src} controls preload="metadata" aria-label={name} className="max-h-full max-w-full" />}
    </div>
  )
}

/** The server's parsed CSV rows; the first row is the header. */
function CsvTable({ rows, truncated }: { rows: string[][]; truncated: boolean }) {
  const [head = [], ...body] = rows
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="border-collapse font-mono text-[12px]">
        <thead className="sticky top-0 bg-code-bg"><tr>{head.map((cell, i) => <th key={i} scope="col" className="border border-border-subtle px-2 py-1 text-left font-semibold whitespace-nowrap">{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} className="border border-border-subtle px-2 py-1 whitespace-pre">{cell}</td>)}</tr>)}</tbody>
      </table>
      {truncated && <div className="p-2 text-[11px] text-muted">{m.ws_panel_csv_truncated({ n: body.length })}</div>}
    </div>
  )
}

/** Name prompt for new file, new folder and rename; the server's refusal (conflict, invalid name) stays inline so the name can be fixed. */
function NameDialog({ title, label, initial = '', confirmLabel, onSubmit, onClose }: { title: string; label: string; initial?: string; confirmLabel: string; onSubmit: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const submit = useMutation({ mutationFn: () => onSubmit(name.trim()), onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) submit.mutate() }} className="flex flex-col gap-3">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={label} />
        {submit.isError && <div role="alert" className="break-words text-xs text-error">{errorText(submit.error)}</div>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={submit.isPending || !name.trim()}>{confirmLabel}</Button></div>
      </form>
    </Dialog>
  )
}
