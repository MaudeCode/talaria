import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Download, Eye, EyeOff, File as FileIcon, Folder, RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { appUrl } from '../../lib/appRoot'
import { Button, IconButton } from '../../ui/Button'
import { ErrorState, LoadingState, formatBytes } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { Markdown } from '../chat/render/Markdown'
import { writePersisted } from '../../lib/persisted'
import { RightPanel } from '../../shell/RightPanel'

function joinPath(dir: string, name: string): string {
  return dir === '.' || dir === '' ? name : `${dir.replace(/\/$/, '')}/${name}`
}
function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? parts.join('/') : '.'
}

/** Right-hand workspace panel: directory tree, file preview/edit, git status badge. */
export function WorkspacePanel({ workspace, sessionId, open, onToggle, onClose }: { workspace: string; sessionId: string; open: boolean; onToggle: () => void; onClose: () => void }) {
  const qc = useQueryClient()
  const [dir, setDir] = useState('.')
  const [showHidden, setShowHidden] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => { writePersisted('hermes-webui-workspace-panel', open ? 'open' : 'closed') }, [open])
  const listing = useQuery({ queryKey: keys.files.list(workspace, dir, showHidden), queryFn: () => api.listDir(sessionId, dir, showHidden), staleTime: 10_000, enabled: open })
  const git = useQuery({ queryKey: keys.files.git(sessionId), queryFn: () => api.fetchGitInfo(sessionId), staleTime: 30_000, retry: false, enabled: open })
  const content = useQuery({ queryKey: keys.files.content(workspace, file ?? ''), queryFn: () => api.readFile(sessionId, file ?? ''), enabled: !!file && open, staleTime: 5_000 })
  const save = useMutation({ mutationFn: (text: string) => api.saveFile(sessionId, file ?? '', text), onSuccess: () => { showToast(m.ws_panel_saved()); setDraft(null); void qc.invalidateQueries({ queryKey: keys.files.content(workspace, file ?? '') }) }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  const entries = (listing.data?.entries ?? listing.data?.items ?? []).slice().sort((a, b) => Number(!!b.is_dir) - Number(!!a.is_dir) || a.name.localeCompare(b.name))
  const g = git.data?.git
  const isMarkdown = !!file && /\.(md|markdown)$/i.test(file)
  const text = draft ?? content.data?.content ?? ''
  return (
    <RightPanel
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      label={m.ws_panel_title()}
      panelId="workspace"
      title={m.ws_panel_title()}
      subtitle={`${workspace}${g?.is_git && g.branch ? ` · ${g.branch}${g.dirty ? ` (${g.dirty}±)` : ''}` : ''}`}
      actions={
        <>
          <IconButton label={showHidden ? m.ws_panel_hidden() : m.ws_panel_hidden()} active={showHidden} className="h-7 w-7" onClick={() => setShowHidden((h) => !h)}>{showHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}</IconButton>
          <IconButton label={m.refresh()} className="h-7 w-7" onClick={() => { void listing.refetch(); void git.refetch() }}><RefreshCw size={14} aria-hidden="true" /></IconButton>
        </>
      }
    >
      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1 text-xs">
            <Button variant="ghost" onClick={() => { setFile(null); setDraft(null) }}><ArrowUp size={12} aria-hidden="true" /> {m.back()}</Button>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{file}</span>
            <a className="text-muted hover:text-text" href={appUrl(api.rawFileUrl(sessionId, file)).href} download aria-label={m.download_folder()}><Download size={14} aria-hidden="true" /></a>
          </div>
          {content.isPending && <LoadingState />}
          {content.isError && <ErrorState error={content.error} onRetry={() => { void content.refetch() }} />}
          {content.data && content.data.binary && <div className="p-3 text-xs text-muted">{m.ws_panel_binary({ size: formatBytes(content.data.size) })}</div>}
          {content.data && !content.data.binary && (
            <div className="flex min-h-0 flex-1 flex-col">
              {isMarkdown && draft === null ? (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px]"><Markdown text={text} /></div>
              ) : (
                <textarea value={text} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={m.ws_panel_preview()} className="min-h-0 flex-1 resize-none bg-code-bg p-3 font-mono text-[12px] text-pre-text outline-none" />
              )}
              <div className="flex items-center gap-2 border-t border-border-subtle px-2 py-1.5">
                {isMarkdown && draft === null && <Button variant="ghost" onClick={() => setDraft(text)}>{m.edit()}</Button>}
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
            <IconButton label={m.ws_panel_up()} className="h-7 w-7" disabled={dir === '.'} onClick={() => setDir(parentOf(dir))}><ArrowUp size={14} aria-hidden="true" /></IconButton>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{dir}</span>
            <a className="text-muted hover:text-text" href={appUrl(api.folderDownloadUrl(sessionId, dir)).href} aria-label={m.ws_panel_download()}><Download size={14} aria-hidden="true" /></a>
          </div>
          <div className="file-tree min-h-0 flex-1 overflow-y-auto p-1" role="tree" aria-label={m.ws_panel_files()}>
            {listing.isPending && <LoadingState />}
            {listing.isError && <ErrorState error={listing.error} onRetry={() => { void listing.refetch() }} />}
            {listing.isSuccess && entries.length === 0 && <div className="p-3 text-xs text-muted">{m.ws_panel_empty()}</div>}
            {entries.map((e) => {
              const path = e.path ?? joinPath(dir, e.name)
              const isDir = !!e.is_dir || e.type === 'dir' || e.type === 'directory'
              return (
                <button key={path} type="button" role="treeitem" onClick={() => (isDir ? setDir(path) : setFile(path))} className={cn('file-item flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-text hover:bg-hover', e.hidden && 'opacity-60')} title={path}>
                  {isDir ? <Folder size={14} className="shrink-0 text-accent-text" aria-hidden="true" /> : <FileIcon size={14} className="shrink-0 text-muted" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {!isDir && e.size !== undefined && e.size !== null && <span className="text-[10px] text-muted">{formatBytes(e.size)}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </RightPanel>
  )
}
