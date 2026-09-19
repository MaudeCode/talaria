import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useWorkspacesQuery } from '../../app/queries'
import { HubPage } from '../../shell/AppShell'
import { PanelHeadButton } from '../../shell/Sidebar'
import { Button, IconButton } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

export function WorkspacesPage() {
  const qc = useQueryClient()
  const ws = useWorkspacesQuery()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.workspaces })
  const onError = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const remove = useMutation({ mutationFn: (path: string) => api.removeWorkspace(path), onSuccess: () => { void invalidate() }, onError })
  const rename = useMutation({ mutationFn: ({ path, name }: { path: string; name: string }) => api.renameWorkspace(path, name), onSuccess: () => { setRenaming(null); void invalidate() }, onError })
  const reorder = useMutation({ mutationFn: (paths: string[]) => api.reorderWorkspaces(paths), onSuccess: () => { void invalidate() }, onError })
  const list = ws.data?.workspaces ?? []
  const move = (index: number, delta: number) => {
    const next = [...list]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const a = next[index]
    const b = next[target]
    if (!a || !b) return
    next[index] = b
    next[target] = a
    reorder.mutate(next.map((w) => w.path))
  }
  return (
    <HubPage title={m.tab_workspaces()} actions={<PanelHeadButton label={m.workspace_add()} className="primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}>
      <p className="mb-3 text-sm text-muted">{m.workspace_desc()}</p>
      {ws.isPending && <LoadingState />}
      {ws.isError && <ErrorState error={ws.error} onRetry={() => { void ws.refetch() }} />}
      {ws.isSuccess && list.length === 0 && <EmptyState>{m.workspace_no_workspaces()}</EmptyState>}
      <ul className="flex flex-col gap-2" id="workspacesPanel">
        {list.map((w, i) => (
          <li key={w.path} className={cn('flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2', ws.data?.last === w.path && 'border-accent-bg-strong')}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-text"><span className="truncate">{w.name ?? w.path}</span>{ws.data?.last === w.path && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent-text">{m.workspace_current()}</span>}</div>
              <div className="truncate font-mono text-[11px] text-muted">{w.path}</div>
            </div>
            <IconButton label={m.workspace_move_up()} onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp size={14} aria-hidden="true" /></IconButton>
            <IconButton label={m.workspace_move_down()} onClick={() => move(i, 1)} disabled={i === list.length - 1}><ArrowDown size={14} aria-hidden="true" /></IconButton>
            <IconButton label={m.rename()} onClick={() => setRenaming({ path: w.path, name: w.name ?? '' })}><Pencil size={14} aria-hidden="true" /></IconButton>
            <IconButton label={m.remove()} onClick={() => setRemoving(w.path)}><Trash2 size={14} aria-hidden="true" /></IconButton>
          </li>
        ))}
      </ul>
      {adding && <AddWorkspaceDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void invalidate() }} />}
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null) }} title={m.workspace_remove_confirm()} confirmLabel={m.remove()} cancelLabel={m.cancel()} danger onConfirm={() => { if (removing) remove.mutate(removing) }} />
      {renaming && (
        <Dialog open onOpenChange={(o) => { if (!o) setRenaming(null) }} title={m.workspace_rename_prompt()}>
          <form onSubmit={(e) => { e.preventDefault(); rename.mutate(renaming) }} className="flex flex-col gap-3">
            <TextInput autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} placeholder={m.workspace_name_placeholder()} aria-label={m.workspace_rename_prompt()} />
            <div className="flex justify-end gap-2"><Button onClick={() => setRenaming(null)}>{m.cancel()}</Button><Button type="submit" variant="primary">{m.save()}</Button></div>
          </form>
        </Dialog>
      )}
    </HubPage>
  )
}

function AddWorkspaceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      if (!path) { setSuggestions((s) => (s.length ? [] : s)); return }
      api.suggestWorkspaces(path).then((r) => setSuggestions(r.suggestions.slice(0, 8))).catch(() => setSuggestions([]))
    }, 200)
    return () => clearTimeout(t)
  }, [path])
  const add = useMutation({
    mutationFn: () => api.addWorkspace(path.trim(), name.trim() || undefined),
    onSuccess: (res) => { const err = 'error' in res ? res.error : undefined; if (typeof err === 'string' && err) setError(err); else onAdded() },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.workspace_add()}>
      <form onSubmit={(e) => { e.preventDefault(); if (path.trim()) add.mutate() }} className="flex flex-col gap-3">
        <TextInput autoFocus list="workspaceSuggestions" value={path} onChange={(e) => setPath(e.target.value)} placeholder={m.workspace_add_path_placeholder()} aria-label={m.workspace_add_path_placeholder()} />
        <datalist id="workspaceSuggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={m.workspace_name_placeholder()} aria-label={m.workspace_name_placeholder()} />
        {error && <div role="alert" className="text-sm text-error">{error}</div>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={add.isPending}>{m.add()}</Button></div>
      </form>
    </Dialog>
  )
}
