import { useEffect, useState } from 'react'
import { Folder, FolderX, Plus } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useSaveSettings, useWorkspacesQuery } from '../../app/queries'
import { isDefiniteRefusal } from '../../contracts/common'
import { HubPage } from '../../shell/AppShell'
import { Mark, StatusDot } from '../../ui/Badge'
import { Button, IconButton } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { ConfirmDialog, Dialog, DialogFooter } from '../../ui/Dialog'
import { Row, RowList } from '../../ui/List'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionsMenu } from '../../ui/RowActionsMenu'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showErrorToast } from '../toast/errorToast'
import { newResource, useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'

/** An Add space draft; `error` is the server's refusal of the last try (TAL-2141). */
interface AddDraft { path: string; name: string; error?: string }

export function WorkspacesPage() {
  const ws = useWorkspacesQuery()
  const [adding, setAdding] = useState<AddDraft | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const onError = (e: unknown) => showErrorToast(e)
  const owner = { queryKey: keys.workspaces, onError }
  const remove = useResourceMutation({ ...owner, resource: (path: string) => `workspace:${path}`, effect: () => ({ remove: true }), mutationFn: (path) => api.removeWorkspace(path) })
  const rename = useResourceMutation({ ...owner, resource: ({ path }: { path: string; name: string }) => `workspace:${path}`, effect: ({ name }) => ({ fields: { name } }), mutationFn: ({ path, name }) => api.renameWorkspace(path, name) })
  const reorder = useResourceMutation({ ...owner, resource: () => 'workspace-order', effect: (paths: string[]) => ({ value: paths }), mutationFn: (paths) => api.reorderWorkspaces(paths) })
  // TAL-2141: the default is the `default_workspace` setting, saved through the shared settings write; the list shows it until a fresh read confirms.
  const saveSettings = useSaveSettings()
  const makeDefault = useResourceMutation({ ...owner, resource: () => 'workspace-default', effect: (path: string) => ({ value: path }), mutationFn: (path) => saveSettings.mutateAsync({ default_workspace: path }) })
  // The server picks the name of an added space; until it answers, the row shows what was typed. A refusal reopens the dialog with it.
  const add = useResourceMutation({ queryKey: keys.workspaces, exclusive: true, resource: ({ resource }: { resource: string } & AddDraft) => resource, effect: ({ path, name }) => ({ fields: { path, name: name || path } }), mutationFn: ({ path, name }) => api.addWorkspace(path, name || undefined) })
  const effects = useResourceEffects<string[] | string>()
  const order = effects['workspace-order']?.value as string[] | undefined
  const pendingDefault = effects['workspace-default']?.value as string | undefined
  const shown = withCreated(withEffects(ws.data?.workspaces ?? [], (w) => `workspace:${w.path}`, effects), 'workspace', effects)
  const list = order ? [...shown].sort((a, b) => rank(order, a.path) - rank(order, b.path)) : shown
  const confirmed = new Set((ws.data?.workspaces ?? []).map((w) => w.path))
  const move = (index: number, delta: number) => {
    const next = [...list]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const a = next[index]
    const b = next[target]
    if (!a || !b) return
    next[index] = b
    next[target] = a
    reorder.mutate(next.map((w) => w.path).filter((path) => confirmed.has(path)))
  }
  const submitAdd = (draft: AddDraft) => {
    setAdding(null)
    add.mutate({ resource: newResource('workspace'), ...draft }, {
      onError: (e) => { if (isDefiniteRefusal(e)) setAdding({ ...draft, error: e instanceof Error ? e.message : String(e) }); else showErrorToast(e) },
    })
  }
  return (
    <HubPage title={m.tab_workspaces()} help={m.workspace_desc()} actions={<IconButton variant="primary" tooltipSide="bottom" label={m.workspace_add_space()} onClick={() => setAdding({ path: '', name: '' })}><Plus aria-hidden="true" /></IconButton>}>
      {ws.isPending && <LoadingState />}
      {ws.isError && <ErrorState error={ws.error} onRetry={() => { void ws.refetch() }} />}
      {ws.isSuccess && list.length === 0 && <EmptyState compact>{m.workspace_no_workspaces()}</EmptyState>}
      <RowList id="workspacesPanel">
        {list.map((w, i) => {
          const isDefault = pendingDefault === undefined ? w.is_default === true : w.path === pendingDefault
          // A space still being added has no server entry to move, rename or remove yet.
          const actions: RowAction[] = confirmed.has(w.path) ? [
            ...(isDefault ? [] : [{ label: m.workspace_make_default(), run: () => makeDefault.mutate(w.path) }]),
            { label: m.workspace_move_up(), run: () => move(i, -1), disabled: i === 0 },
            { label: m.workspace_move_down(), run: () => move(i, 1), disabled: i === list.length - 1 },
            { label: m.rename(), run: () => setRenaming({ path: w.path, name: w.name }) },
            { label: m.remove(), run: () => setRemoving(w.path), danger: true, ...(isDefault ? { disabled: true, title: m.workspace_remove_default_title() } : {}) },
          ] : []
          const path = w.display_path ?? w.path
          const RowIcon = w.exists === false ? FolderX : Folder
          return <RowContextMenu key={w.path} label={m.workspace_row_menu()} actions={actions} trigger={
            <Row data-workspace-row={w.path}>
              <div className="flex items-center gap-3">
                <RowIcon size={18} aria-hidden="true" className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-sm font-semibold text-text"><span className="truncate">{w.name}</span>{isDefault && <Mark>{m.workspace_default()}</Mark>}</div>
                  {w.exists === false
                    ? <div className="flex min-w-0" title={w.path}><StatusDot state="warning">{m.workspace_folder_not_found({ path })}</StatusDot></div>
                    : <div dir="rtl" className="truncate text-left font-mono text-xs text-muted" title={w.path}><bdi dir="ltr">{path}</bdi></div>}
                </div>
                {w.chat_count !== undefined && <span className="hidden shrink-0 text-xs tabular-nums text-muted min-[601px]:inline">{m.workspace_chat_count({ count: w.chat_count })}</span>}
                <RowActionsMenu label={m.workspace_row_menu()} actions={actions} />
              </div>
            </Row>} />
        })}
      </RowList>
      {adding && <AddWorkspaceDialog draft={adding} onClose={() => setAdding(null)} onSubmit={submitAdd} />}
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null) }} title={m.workspace_remove_confirm()} confirmLabel={m.remove()} cancelLabel={m.cancel()} danger onConfirm={() => { if (removing) remove.mutate(removing) }} />
      {renaming && <RenameWorkspaceDialog workspace={renaming} onClose={() => setRenaming(null)} onSubmit={(name) => { rename.mutate({ path: renaming.path, name }); setRenaming(null) }} />}
    </HubPage>
  )
}

/** A space's place in a pending order; spaces the order does not name keep their place after it. */
const rank = (order: string[], path: string) => { const i = order.indexOf(path); return i < 0 ? order.length : i }

/** Closes on submit, before the server resolves the write. */
function RenameWorkspaceDialog({ workspace, onClose, onSubmit }: { workspace: { path: string; name: string }; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(workspace.name)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.workspace_rename_prompt()}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(name) }} className="flex flex-col gap-3">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={m.workspace_name_placeholder()} aria-label={m.workspace_rename_prompt()} />
        <DialogFooter><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary">{m.save()}</Button></DialogFooter>
      </form>
    </Dialog>
  )
}

/**
 * TAL-2141: the path input browses the server's folders from `GET /api/workspaces/suggest`: a listbox under it, reachable
 * with the arrow keys, where choosing a folder descends into it and ".." goes up. The server names each row and the value it
 * puts in the input. Closes on submit, before the server answers.
 */
function AddWorkspaceDialog({ draft, onClose, onSubmit }: { draft: AddDraft; onClose: () => void; onSubmit: (draft: AddDraft) => void }) {
  const [path, setPath] = useState(draft.path)
  const [name, setName] = useState(draft.name)
  const [error, setError] = useState(draft.error)
  const [browse, setBrowse] = useState<Awaited<ReturnType<typeof api.suggestWorkspaces>> | null>(null)
  const [active, setActive] = useState(-1)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api.suggestWorkspaces(path).then((r) => { if (live) setBrowse(r) }).catch(() => { if (live) setBrowse(null) })
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [path])
  const options = [
    ...(browse?.parent != null ? [{ label: '..', title: m.workspace_parent_directory(), target: browse.parent }] : []),
    ...(browse?.folders ?? []).slice(0, 8).map((f) => ({ label: f.name, title: f.path, target: f.target })),
  ]
  const edit = (next: string) => { setPath(next); setActive(-1); setError(undefined) }
  const trimmed = path.trim()
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.workspace_add_space()}>
      <form onSubmit={(e) => { e.preventDefault(); if (trimmed) onSubmit({ path: trimmed, name: name.trim() }) }} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <TextInput autoFocus role="combobox" aria-expanded={options.length > 0} aria-controls="workspaceFolders" aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `workspaceFolder-${active}` : undefined} aria-invalid={error ? true : undefined}
            value={path} onChange={(e) => edit(e.target.value)} placeholder={m.workspace_add_path_placeholder()} aria-label={m.workspace_add_path_placeholder()}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)) }
              else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)) }
              else if (e.key === 'Enter' && options[active]) { e.preventDefault(); edit(options[active].target) }
            }} />
          {error && <p role="alert" className="text-xs text-error">{error}</p>}
        </div>
        <ul role="listbox" id="workspaceFolders" aria-label={m.workspace_folders()} className="flex flex-col">
          {options.map((o, i) => (
            <li key={o.target + o.label} id={`workspaceFolder-${i}`} role="option" aria-selected={i === active} title={o.title}
              onMouseDown={(e) => e.preventDefault()} onClick={() => edit(o.target)}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text hover:bg-hover aria-selected:bg-hover pointer-coarse:min-h-11">
              <Folder size={16} aria-hidden="true" className="shrink-0 text-muted" /><span className="truncate">{o.label}</span>
            </li>
          ))}
        </ul>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={browse?.default_name || m.workspace_name_placeholder()} aria-label={m.workspace_name_placeholder()} />
        <DialogFooter><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!trimmed}>{m.add()}</Button></DialogFooter>
      </form>
    </Dialog>
  )
}
