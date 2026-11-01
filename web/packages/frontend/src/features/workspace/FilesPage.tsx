import { useEffect, useRef, useState, type Dispatch, type DragEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Download, Eye, EyeOff, File as FileIcon, FilePlus, Folder, FolderPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { appUrl } from '../../lib/appRoot'
import { Button, IconButton } from '../../ui/Button'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Select } from '../../ui/Select'
import { HelpTip, TextInput } from '../../ui/Field'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { ErrorState, LoadingState, formatBytes } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { Markdown } from '../chat/render/Markdown'
import { newResource, useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'

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
/** One write owner per entry and per file's contents; a profile or workspace switch fences them like any resource. */
const entryResource = (workspace: string, path: string) => JSON.stringify(['file', workspace, path])
const contentResource = (workspace: string, path: string) => JSON.stringify(['file-content', workspace, path])
const createKind = (workspace: string, dir: string) => JSON.stringify(['file-new', workspace, dir])
/** One unsaved draft per session, source, workspace and file, so a draft never reaches the same name elsewhere. */
const draftKey = (sessionId: string, source: 'workspace' | 'managed', workspace: string, path: string) => JSON.stringify([sessionId, source, workspace, path])
type Drafts = Record<string, string>
type Pending = { kind: 'new-file' } | { kind: 'new-folder' } | { kind: 'rename'; entry: Entry } | { kind: 'delete'; entry: Entry } | null

/** Files a checkpoint restore rewrote in `workspace`; `seq` tells one restore from the next. */
export interface RestoredFiles { seq: number; paths: string[]; workspace: string }

/** The right panel's Files page (TAL-373): directory tree, file preview/edit, git status. Its folder and preview stay
 * while another page is shown; it fetches only while `active`. Unsaved drafts live here, above the per-workspace
 * remount, so a workspace switch, Back or another file keeps them until Save or Cancel (TAL-1576). */
export function FilesPage({ workspace, sessionId, active, restored = null }: { workspace: string | null | undefined; sessionId: string; active: boolean; restored?: RestoredFiles | null }) {
  const [source, setSource] = useState<'workspace' | 'managed'>('workspace')
  const [managedOpened, setManagedOpened] = useState(false)
  const [drafts, setDrafts] = useState<Drafts>({})
  // TAL-571: a restore rewrote these files; a draft of one would put the pre-restore text back on Save, so it goes.
  const [seenRestore, setSeenRestore] = useState(restored?.seq)
  if (restored && restored.seq !== seenRestore) {
    setSeenRestore(restored.seq)
    const rewritten = new Set(restored.paths.map((path) => draftKey(sessionId, 'workspace', restored.workspace, path)))
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([key]) => !rewritten.has(key))))
  }
  const sources: ('workspace' | 'managed')[] = managedOpened ? ['workspace', 'managed'] : ['workspace']
  const sourceControl = <Select aria-label={m.ws_panel_source()} value={source} onValueChange={(value) => { setSource(value as 'workspace' | 'managed'); if (value === 'managed') setManagedOpened(true) }}>
    <option value="workspace">{m.ws_panel_workspace_source()}</option>
    <option value="managed">{m.ws_panel_managed_source()}</option>
  </Select>
  return <>
    {sources.map((owner) => <div key={owner} hidden={source !== owner} className={cn('min-h-0 flex-1 flex-col', source === owner && 'flex')}>
      {owner === 'workspace' && !workspace
        ? <><div className="border-b border-border-subtle px-3 py-1">{sourceControl}</div><div className="p-3 text-xs text-muted" role="status">{m.panel_files_unavailable()}</div></>
        : <WorkspaceFiles key={owner === 'managed' ? sessionId : workspace} workspace={owner === 'managed' ? JSON.stringify(['managed', sessionId]) : workspace ?? ''} sessionId={sessionId} source={owner} sourceControl={sourceControl} active={active && source === owner} drafts={drafts} setDrafts={setDrafts} />}
    </div>)}
  </>
}

function WorkspaceFiles({ workspace, sessionId, source, sourceControl, active, drafts, setDrafts }: { workspace: string; sessionId: string; sourceControl: ReactNode; source: 'workspace' | 'managed'; active: boolean; drafts: Drafts; setDrafts: Dispatch<SetStateAction<Drafts>> }) {
  const managed = source === 'managed'
  const sourceArgs: [] | ['managed'] = managed ? ['managed'] : []
  const qc = useQueryClient()
  const [dir, setDir] = useState('.')
  const [showHidden, setShowHidden] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  // The draft belongs to the file it was typed in, so a save that finishes later never clears another file's edits.
  const keyOf = (path: string) => draftKey(sessionId, source, workspace, path)
  const draft = file === null ? null : drafts[keyOf(file)] ?? null
  // Sets or (null) clears one draft; with `ifText`, only while it still holds that text, so a save never clears newer edits.
  const putDraft = (path: string, text: string | null, ifText?: string) => setDrafts((d) => {
    const key = keyOf(path)
    if (ifText !== undefined && d[key] !== ifText) return d
    return text === null ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)) : { ...d, [key]: text }
  })
  const setDraft = (text: string | null) => { if (file !== null) putDraft(file, text) }
  // A renamed or moved entry takes its drafts (a folder, its files' drafts) to the new path; a deleted one drops them.
  const relocateDrafts = (from: string, to: string | null) => setDrafts((d) => Object.fromEntries(Object.entries(d).flatMap(([key, text]) => {
    const [s, src, ws, path = ''] = JSON.parse(key) as string[]
    if (s !== sessionId || src !== source || ws !== workspace || (path !== from && !path.startsWith(`${from}/`))) return [[key, text]]
    return to === null ? [] : [[keyOf(to + path.slice(from.length)), text]]
  })))
  const [pending, setPending] = useState<Pending>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // TAL-1606: the tree has one tab stop, the row last focused in this folder. A refresh keeps it on that row; a removed
  // row passes it to the row now at its index. Opening a folder starts at its first row; Up returns to the folder left.
  const [cursor, setCursor] = useState({ dir: '.', path: '', index: 0 })
  const treeRef = useRef<HTMLDivElement>(null)
  // The row focus was last on, until focus moves to something outside the tree.
  const focusedRow = useRef<HTMLElement | null>(null)
  const listing = useQuery({ queryKey: keys.files.list(workspace, dir, showHidden), queryFn: () => api.listDir(sessionId, dir, showHidden, ...sourceArgs), staleTime: 10_000, enabled: active })
  const git = useQuery({ queryKey: keys.files.git(sessionId), queryFn: () => api.fetchGitInfo(sessionId), staleTime: 30_000, retry: false, enabled: active && !managed })
  const content = useQuery({ queryKey: keys.files.content(workspace, file ?? ''), queryFn: () => api.readFile(sessionId, file ?? '', ...sourceArgs), enabled: !!file && active, staleTime: 5_000 })
  const effects = useResourceEffects()
  // The saved text shows until the reread of that same file confirms it; edits typed meanwhile stay as the draft.
  const save = useResourceMutation({
    resource: ({ path }: { path: string; text: string }) => contentResource(workspace, path),
    queryKey: keys.files.contents(workspace), readKeys: ({ path }) => [{ queryKey: keys.files.content(workspace, path), exact: true }],
    effect: ({ text }) => ({ value: text }),
    mutationFn: ({ path, text }) => api.saveFile(sessionId, path, text, ...sourceArgs),
    onSuccess: (_, { path, text }) => { showToast(m.ws_panel_saved()); putDraft(path, null, text) },
    onError: (e) => showErrorToast(e),
  })
  // A path can now name another file (rename, move, delete then create), so cached contents are dropped, not just marked stale.
  const refresh = () => {
    qc.removeQueries({ queryKey: keys.files.contents(workspace) })
    return Promise.all([qc.invalidateQueries({ queryKey: keys.files.lists(workspace) }), qc.invalidateQueries({ queryKey: keys.files.git(sessionId) })])
  }
  // Reveal and Open in VS Code act on the host; the server's refusal shows inline above the tree.
  const op = useMutation({ mutationFn: (call: () => Promise<unknown>) => call(), onMutate: () => setNotice(null), onError: (e) => setNotice(errorText(e)), onSettled: refresh })
  // Tree writes show at once: a moved or deleted entry leaves, a renamed one takes its new name, a new one appears.
  // The server's refusal (symlink, conflict, missing, invalid name) rolls it back and shows inline above the tree.
  // Each write rereads only the folders it changed: a deleted or moved folder's own listing is gone on the server.
  // A rename owns its old and new paths, so an action on the renamed row waits for it instead of racing it.
  const treeWrite = { queryKey: keys.files.lists(workspace), onError: (e: unknown) => setNotice(errorText(e)), onSuccess: () => { void refresh() } }
  const folders = (...paths: string[]) => paths.map((path) => keys.files.dir(workspace, path))
  const remove = useResourceMutation({ ...treeWrite, onSuccess: (_, { path, to }) => { relocateDrafts(path, to === undefined ? null : joinPath(to, path.split('/').pop() ?? '')); void refresh() }, resource: ({ path }: { path: string; to?: string; call: () => Promise<unknown> }) => entryResource(workspace, path), readKeys: ({ path, to }) => folders(parentOf(path), ...(to === undefined ? [] : [to])), effect: () => ({ remove: true }), mutationFn: ({ call }) => call() })
  const rename = useResourceMutation({ ...treeWrite, onSuccess: (_, { path, name }) => { relocateDrafts(path, joinPath(parentOf(path), name)); void refresh() }, resource: ({ path, name }: { path: string; name: string }) => [entryResource(workspace, path), entryResource(workspace, joinPath(parentOf(path), name))], readKeys: ({ path }) => folders(parentOf(path)), effect: ({ path, name }) => ({ fields: { name, path: joinPath(parentOf(path), name) } }), mutationFn: ({ path, name }) => api.renameEntry(sessionId, path, name) })
  const create = useResourceMutation({ ...treeWrite, exclusive: true, resource: ({ resource }: { resource: string; path: string; name: string; isDir: boolean }) => resource, readKeys: ({ path }) => folders(parentOf(path)), effect: ({ path, name, isDir }) => ({ fields: { path, name, is_dir: isDir, type: isDir ? 'dir' : 'file' } }), mutationFn: ({ path, isDir }) => isDir ? api.createDir(sessionId, path) : api.createFile(sessionId, path) })
  const submitName = (kind: 'file' | 'dir', name: string) => { setNotice(null); create.mutate({ resource: newResource(createKind(workspace, dir)), path: joinPath(dir, name), name, isDir: kind === 'dir' }) }
  const go = (path: string) => { setNotice(null); setCursor({ dir: path, path: dir, index: 0 }); setDir(path) }
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
      if (src !== dest) { setNotice(null); remove.mutate({ path: src, to: dest, call: () => api.moveEntry(sessionId, src, dest) }) }
    },
  })
  // The server orders the listing (symlinks, folders, files); rows render in that order.
  const entries = withCreated(withEffects(listing.data?.entries ?? [], (e) => entryResource(workspace, e.path ?? joinPath(dir, e.name)), effects), createKind(workspace, dir), effects)
  const paths = entries.map((e) => e.path ?? joinPath(dir, e.name))
  const kept = cursor.dir === dir ? paths.indexOf(cursor.path) : -1
  const activeIndex = kept >= 0 ? kept : Math.min(cursor.dir === dir ? cursor.index : 0, paths.length - 1)
  // When the focused row leaves (removed, or its folder or file view replaced it) and focus fell to the page, the tab
  // stop row takes it. Focus the user moved elsewhere stays there.
  useEffect(() => {
    const last = focusedRow.current
    const current = document.activeElement
    if (!active || !last || last.isConnected || (current && current !== document.body)) return
    treeRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus()
  })
  const onTreeKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const at = items.indexOf(ev.target as HTMLElement)
    const to = at < 0 ? null : ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[ev.key]
    if (to === undefined || to === null) return
    ev.preventDefault()
    items[Math.max(0, Math.min(to, items.length - 1))]?.focus()
  }
  const g = git.data?.git
  const readOnly = managed && (content.data?.read_only !== false || content.isError)
  const fileName = content.data?.name ?? listing.data?.entries.find((entry) => entry.path === file)?.name ?? file
  // An older server sends no `preview`: its replies are always text, Markdown by extension. Delete once Stable sends it.
  const kind = content.data ? (content.data.preview ?? (/\.(md|markdown)$/i.test(file ?? '') ? 'markdown' : 'text')) : undefined
  // Markdown, CSV and HTML show their rendered form until Edit opens the text.
  const rendered = draft === null && (kind === 'markdown' || kind === 'csv' || kind === 'html')
  const saving = file ? effects[contentResource(workspace, file)]?.value : undefined
  const text = draft ?? (typeof saving === 'string' ? saving : content.data?.content ?? '')
  const rawUrl = (inline?: boolean) => appUrl(api.rawFileUrl(sessionId, file ?? '', inline)).href
  return (
    <>
      <div className="flex items-center gap-1 border-b border-border-subtle px-3 py-1" data-files-toolbar>
        {sourceControl}
        <span data-files-workspace={managed ? undefined : ''} className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={managed ? undefined : workspace}>{managed ? '' : `${workspace}${g?.is_git && g.branch ? ` · ${g.branch}${g.dirty ? ` (${g.dirty}±)` : ''}` : ''}`}</span>
        {!managed && <IconButton label={m.ws_panel_hidden()} active={showHidden} className="h-7 w-7" onClick={() => setShowHidden((h) => !h)}>{showHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}</IconButton>}
        <IconButton label={m.refresh()} className="h-7 w-7" onClick={() => { void listing.refetch(); if (!managed) void git.refetch(); if (file) void content.refetch() }}><RefreshCw size={14} aria-hidden="true" /></IconButton>
      </div>
      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1 text-xs">
            <Button variant="ghost" onClick={() => setFile(null)}><ArrowUp size={12} aria-hidden="true" /> {m.back()}</Button>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{fileName}</span>
            {!managed && <a className="text-muted hover:text-text" href={rawUrl()} download aria-label={m.download_folder()}><Download size={14} aria-hidden="true" /></a>}
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
                <textarea readOnly={readOnly} value={text} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={m.ws_panel_preview()} className="min-h-0 flex-1 resize-none bg-code-bg p-3 font-mono text-[12px] text-pre-text outline-none" />
              )}
              <div className="flex items-center gap-2 border-t border-border-subtle px-2 py-1.5">
                {rendered && !readOnly && <Button variant="ghost" onClick={() => setDraft(text)}>{m.edit()}</Button>}
                <Button variant="primary" disabled={draft === null || readOnly} onClick={() => { if (draft !== null && file) save.mutate({ path: file, text: draft }) }}>{m.save()}</Button>
                {draft !== null && <Button variant="ghost" onClick={() => setDraft(null)}>{m.cancel()}</Button>}
                <span className="ml-auto text-[11px] text-muted">{readOnly ? m.ws_panel_read_only() : ''}</span>
                {managed && <HelpTip label={m.ws_panel_write_semantics()}>{m.ws_panel_unconditional_save()}</HelpTip>}
                <span className="text-[11px] text-muted">{content.data.truncated ? m.logs_truncated({ n: content.data.lines ?? 0 }) : formatBytes(content.data.size)}</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {!managed && <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1 text-xs">
            <IconButton label={m.ws_panel_up()} className={cn('h-7 w-7', dropTarget === parentOf(dir) && dir !== '.' && 'bg-accent-bg')} disabled={dir === '.'} onClick={() => go(parentOf(dir))} {...(dir !== '.' ? dropProps(parentOf(dir)) : {})}><ArrowUp size={14} aria-hidden="true" /></IconButton>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{dir}</span>
            <IconButton label={m.new_file()} className="h-7 w-7" onClick={() => setPending({ kind: 'new-file' })}><FilePlus size={14} aria-hidden="true" /></IconButton>
            <IconButton label={m.new_folder()} className="h-7 w-7" onClick={() => setPending({ kind: 'new-folder' })}><FolderPlus size={14} aria-hidden="true" /></IconButton>
            <a className="text-muted hover:text-text" href={appUrl(api.folderDownloadUrl(sessionId, dir)).href} aria-label={m.ws_panel_download()}><Download size={14} aria-hidden="true" /></a>
          </div>}
          {notice && (
            <div role="alert" className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs text-error">
              <span className="min-w-0 flex-1 break-words">{notice}</span>
              <IconButton label={m.close()} className="h-5 w-5" onClick={() => setNotice(null)}><X size={12} aria-hidden="true" /></IconButton>
            </div>
          )}
          <div ref={treeRef} className="file-tree min-h-0 flex-1 overflow-y-auto p-1" role="tree" aria-label={m.ws_panel_files()} onKeyDown={onTreeKey} onBlur={(ev) => { if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget)) focusedRow.current = null }}>
            {listing.isPending && <LoadingState />}
            {listing.isError && <ErrorState error={listing.error} onRetry={() => { void listing.refetch() }} />}
            {listing.isSuccess && entries.length === 0 && <div role="status" className="p-3 text-xs text-muted">{listing.data.unavailable ? m.ws_panel_managed_unavailable() : m.ws_panel_empty()}</div>}
            {entries.map((e, i) => {
              const path = paths[i] ?? ''
              const isDir = !!e.is_dir || e.type === 'dir' || e.type === 'directory'
              const entry: Entry = { path, name: e.name, isDir }
              const size = !isDir && e.size !== undefined && e.size !== null ? formatBytes(e.size) : ''
              const tabIndex = i === activeIndex ? 0 : -1
              return (
                <div key={path} role="none" className={cn('group flex items-center rounded-md hover:bg-hover', e.hidden && 'opacity-60', dropTarget === path && 'bg-accent-bg')} {...(isDir ? dropProps(path) : {})}>
                  <button
                    type="button"
                    role="treeitem"
                    aria-label={isDir ? m.ws_panel_entry_folder({ name: e.name }) : size ? m.ws_panel_entry_file_size({ name: e.name, size }) : m.ws_panel_entry_file({ name: e.name })}
                    tabIndex={tabIndex}
                    onFocus={(ev) => { focusedRow.current = ev.currentTarget; setCursor({ dir, path, index: i }) }}
                    draggable={!managed}
                    onDragStart={(ev) => { ev.dataTransfer.setData(DRAG_TYPE, path); ev.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => setDropTarget(null)}
                    onContextMenu={(ev) => { if (!managed) { ev.preventDefault(); setMenuFor(path) } }}
                    onClick={() => (isDir ? go(path) : setFile(path))}
                    className="file-item flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[12.5px] text-text"
                    title={path}
                  >
                    {isDir ? <Folder size={14} className="shrink-0 text-accent-text" aria-hidden="true" /> : <FileIcon size={14} className="shrink-0 text-muted" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {size && <span className="text-[10px] text-muted">{size}</span>}
                  </button>
                  {!managed && <Menu
                    label={m.more_actions()}
                    align="end"
                    open={menuFor === path}
                    onOpenChange={(o) => setMenuFor(o ? path : null)}
                    trigger={<IconButton label={m.more_actions()} tabIndex={tabIndex} className="h-6 w-6 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"><MoreHorizontal size={14} aria-hidden="true" /></IconButton>}
                  >
                    <MenuItem onClick={() => setPending({ kind: 'rename', entry })}>{m.rename_title()}</MenuItem>
                    <MenuItem onClick={() => op.mutate(() => api.revealEntry(sessionId, path))}>{m.ws_panel_reveal()}</MenuItem>
                    <MenuItem onClick={() => op.mutate(() => api.openInVsCode(sessionId, path))}>{m.ws_panel_open_vscode()}</MenuItem>
                    <MenuSeparator />
                    <MenuItem className="text-error" onClick={() => setPending({ kind: 'delete', entry })}>{m.delete()}</MenuItem>
                  </Menu>}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {pending?.kind === 'new-file' && <NameDialog title={m.new_file()} label={m.new_file_prompt()} confirmLabel={m.create()} onClose={() => setPending(null)} onSubmit={(name) => submitName('file', name)} />}
      {pending?.kind === 'new-folder' && <NameDialog title={m.new_folder()} label={m.new_folder_prompt()} confirmLabel={m.create()} onClose={() => setPending(null)} onSubmit={(name) => submitName('dir', name)} />}
      {pending?.kind === 'rename' && <NameDialog title={m.rename_title()} label={m.rename_prompt()} initial={pending.entry.name} confirmLabel={m.save()} onClose={() => setPending(null)} onSubmit={(name) => { setNotice(null); rename.mutate({ path: pending.entry.path, name }) }} />}
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(o) => { if (!o) setPending(null) }}
        title={pending?.kind === 'delete' ? (pending.entry.isDir ? m.delete_dir_confirm({ name: pending.entry.name }) : m.delete_confirm({ name: pending.entry.name })) : ''}
        confirmLabel={m.delete()}
        cancelLabel={m.cancel()}
        danger
        onConfirm={() => { if (pending?.kind === 'delete') { const { path, isDir } = pending.entry; setNotice(null); remove.mutate({ path, call: () => api.deleteEntry(sessionId, path, isDir) }) } }}
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

/** Name prompt for new file, new folder and rename; it closes on submit and the tree shows the result at once. */
function NameDialog({ title, label, initial = '', confirmLabel, onSubmit, onClose }: { title: string; label: string; initial?: string; confirmLabel: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSubmit(name.trim()); onClose() } }} className="flex flex-col gap-3">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={label} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!name.trim()}>{confirmLabel}</Button></div>
      </form>
    </Dialog>
  )
}
