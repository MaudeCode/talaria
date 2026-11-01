import { useState } from 'react'
import { useResourceMutation } from './useResourceMutation'
import { useNewChat } from './useNewChat'
import { MoreHorizontal, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { z } from 'zod'
import type { ProjectSchema } from '../../contracts'
import { ContextMenu, Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../ui/Menu'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { useModelsQuery, useWorkspacesQuery } from '../../app/queries'
import { catalogEntryById, catalogModelOptgroups } from '../../lib/modelEntry'
import { cn } from '../../ui/cn'
import { showErrorToast } from '../toast/errorToast'

/** The App's project palette (`ProjectCreationPalette.approvedColors`), offered in the same order. */
const PROJECT_COLORS: { hex: string; name: () => string }[] = [
  { hex: '#7cb9ff', name: m.project_color_sky },
  { hex: '#f5c542', name: m.project_color_gold },
  { hex: '#e94560', name: m.project_color_red },
  { hex: '#50c878', name: m.project_color_green },
  { hex: '#c084fc', name: m.project_color_violet },
  { hex: '#fb923c', name: m.project_color_orange },
  { hex: '#67e8f9', name: m.project_color_cyan },
  { hex: '#f472b6', name: m.project_color_pink },
]

type Project = z.infer<typeof ProjectSchema>
/** TAL-1032: the editable bindings; `model` is a catalog entry id, or the saved bare model while it stays untouched. */
interface Defaults { workspaces: string[]; default_workspace: string; model: string }
const savedModel = (project: Project) => project.model_option_id ?? project.model ?? ''
const defaultsOf = (project: Project): Defaults => ({ workspaces: project.workspaces ?? [], default_workspace: project.default_workspace ?? '', model: savedModel(project) })

/** A sidebar project filter chip; right-click, long-press or the selected chip's actions button opens new chat, defaults, rename, recolor and delete (TAL-565, TAL-1032). */
export function ProjectChip({ project, active, onSelect, onDeleted }: { project: Project; active: boolean; onSelect: () => void; onDeleted: () => void }) {
  const [dialog, setDialog] = useState<'rename' | 'defaults' | 'delete' | null>(null)
  const [defaults, setDefaults] = useState<Defaults>(() => defaultsOf(project))
  const newChat = useNewChat()
  const models = useModelsQuery()
  const [name, setName] = useState(project.name)
  const id = project.project_id
  const fail = (e: unknown) => showErrorToast(e)
  // `project` is the displayed project, so a recolor keeps a rename the server has not confirmed yet.
  const rename = useResourceMutation({ resource: () => `project:${id}`, effect: (name: string) => ({ fields: { name } }), mutationFn: (name) => api.renameProject(id, name), onError: fail })
  const recolor = useResourceMutation({ resource: () => `project:${id}`, effect: (color: string) => ({ fields: { color } }), mutationFn: (color) => api.renameProject(id, project.name, color), onError: fail })
  // The project shows the saved defaults at once; a refusal rolls them back and reopens the editor on the draft.
  const bind = useResourceMutation({
    resource: () => `project:${id}`,
    effect: ({ shown }: { body: Parameters<typeof api.bindProject>[0]; shown: Partial<Project>; draft: Defaults }) => ({ fields: shown }),
    mutationFn: ({ body }) => api.bindProject(body), onError: fail,
  })
  const saveDefaults = (draft: Defaults) => {
    // An untouched model re-sends the saved pair, so a choice the catalog no longer offers survives other edits.
    const untouched = draft.model === savedModel(project)
    const entry = untouched ? undefined : catalogEntryById(models.data, draft.model)
    const model = untouched ? project.model ?? null : draft.model || null
    const provider = untouched ? project.model_provider ?? null : model ? entry?.provider_id ?? null : null
    const body = { project_id: id, workspaces: draft.workspaces, default_workspace: draft.default_workspace || null, model, model_provider: provider }
    const shown = { workspaces: draft.workspaces, default_workspace: draft.default_workspace || null, model: untouched ? model : entry?.bare_id ?? model, model_provider: provider, model_option_id: untouched ? project.model_option_id ?? null : draft.model || null }
    setDialog(null)
    bind.mutate({ body, shown, draft }, { onError: () => { setDefaults(draft); setDialog('defaults') } })
  }
  const del = useResourceMutation({ resource: () => `project:${id}`, effect: () => ({ remove: true }), mutationFn: () => api.deleteProject(id), onError: fail })
  const items = (
    <>
      <MenuItem onClick={() => { void newChat(id) }}>{m.project_new_chat()}</MenuItem>
      <MenuItem onClick={() => { setDefaults(defaultsOf(project)); setDialog('defaults') }}>{m.project_defaults()}</MenuItem>
      <MenuItem onClick={() => { setName(project.name); setDialog('rename') }}>{m.rename()}</MenuItem>
      <MenuRadioGroup value={project.color ?? ''} onValueChange={(hex: string) => recolor.mutate(hex)} aria-label={m.project_color()} className="flex px-1">
        {PROJECT_COLORS.map((c) => (
          // A 32px target around a 16px dot keeps touch picks off the neighbouring color.
          <MenuRadioItem key={c.hex} value={c.hex} closeOnClick aria-label={c.name()} title={c.name()} className="group flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none data-[highlighted]:bg-hover">
            <span className="h-4 w-4 rounded-full group-data-[checked]:ring-2 group-data-[checked]:ring-text" style={{ background: c.hex }} aria-hidden="true" />
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem className="text-error" onClick={() => setDialog('delete')}>{m.delete()}</MenuItem>
    </>
  )
  return (
    <>
      <ContextMenu
        label={m.project_menu()}
        trigger={
          <span role="button" tabIndex={0} className={cn('project-chip', active && 'active')} onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() }}>
            {project.color && <span className="color-dot" style={{ background: project.color }} aria-hidden="true" />}
            <span>{project.name}</span>
          </span>
        }
      >
        {items}
      </ContextMenu>
      {/* The selected chip also gets a visible trigger, for keyboard, touch and assistive-technology users who never right-click. */}
      {active && (
        <Menu label={m.project_menu()} trigger={<button type="button" className="project-chip" aria-label={m.project_menu()} title={m.project_menu()}><MoreHorizontal size={12} aria-hidden="true" /></button>}>
          {items}
        </Menu>
      )}
      {dialog === 'rename' && (
        <Dialog open onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.project_rename()}>
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) { rename.mutate(name.trim()); setDialog(null) } }} className="flex flex-col gap-3">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={m.project_new_prompt()} aria-label={m.project_new_prompt()} maxLength={128} />
            <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!name.trim()}>{m.save()}</Button></div>
          </form>
        </Dialog>
      )}
      {dialog === 'defaults' && <ProjectDefaultsDialog project={project} initial={defaults} onCancel={() => setDialog(null)} onSave={saveDefaults} />}
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.project_delete_confirm({ name: project.name })} description={m.project_delete_desc()} confirmLabel={m.project_delete()} cancelLabel={m.cancel()} danger onConfirm={() => { del.mutate(); onDeleted() }} />
    </>
  )
}

/** TAL-1032: a project's bound workspaces, the one new chats start in, and their model. Every choice comes from the saved workspace list and the model catalog. */
function ProjectDefaultsDialog({ project, initial, onCancel, onSave }: { project: Project; initial: Defaults; onCancel: () => void; onSave: (draft: Defaults) => void }) {
  const [draft, setDraft] = useState(initial)
  const workspaces = useWorkspacesQuery()
  const models = useModelsQuery()
  const saved = workspaces.data?.workspaces ?? []
  const nameOf = (path: string) => saved.find((w) => w.path === path)?.name ?? path
  const addable = saved.filter((w) => !draft.workspaces.includes(w.path))
  const remove = (path: string) => setDraft((d) => ({ ...d, workspaces: d.workspaces.filter((w) => w !== path), default_workspace: d.default_workspace === path ? '' : d.default_workspace }))
  // A saved model the catalog no longer offers stays listed under its own name until the user picks another.
  const unavailable = project.model && !project.model_option_id ? project.model : null
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }} title={m.project_defaults()}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(draft) }} className="flex flex-col gap-3">
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
          <section className="flex flex-col gap-1.5" aria-labelledby="projectDefaultsWorkspaces">
            <h3 id="projectDefaultsWorkspaces" className="text-sm font-medium">{m.project_workspaces()}</h3>
            {draft.workspaces.length > 0 && (
              <ul className="flex flex-col">
                {draft.workspaces.map((path) => (
                  <li key={path} className="flex min-w-0 items-center gap-2 py-0.5">
                    <span className="flex min-w-0 flex-1 flex-col" title={path}><span className="truncate text-sm">{nameOf(path)}</span><span className="truncate font-mono text-[10px] text-muted">{path}</span></span>
                    <button type="button" className="icon-btn h-8 w-8 shrink-0" aria-label={m.project_workspace_remove({ name: nameOf(path) })} title={m.remove()} onClick={() => remove(path)}><X size={14} aria-hidden="true" /></button>
                  </li>
                ))}
              </ul>
            )}
            {addable.length > 0 && (
              <Select value="" onValueChange={(path) => setDraft((d) => ({ ...d, workspaces: [...d.workspaces, path] }))} placeholder={m.workspace_add()} aria-label={m.workspace_add()} className="w-full">
                {addable.map((w) => <option key={w.path} value={w.path}>{w.name}</option>)}
              </Select>
            )}
          </section>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {m.project_default_workspace()}
            <Select value={draft.default_workspace} onValueChange={(v) => setDraft((d) => ({ ...d, default_workspace: v }))} aria-label={m.project_default_workspace()} className="w-full">
              <option value="">{m.project_profile_default()}</option>
              {draft.workspaces.map((path) => <option key={path} value={path}>{nameOf(path)}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {m.project_default_model()}
            <Select value={draft.model} onValueChange={(v) => setDraft((d) => ({ ...d, model: v }))} aria-label={m.project_default_model()} className="w-full">
              <option value="">{m.project_profile_default()}</option>
              {unavailable && <option value={unavailable}>{`${unavailable} · ${project.model_provider ?? ''} · ${m.catalog_unavailable()}`}</option>}
              {catalogModelOptgroups(models.data)}
            </Select>
          </label>
        </div>
        <div className="flex justify-end gap-2"><Button onClick={onCancel}>{m.cancel()}</Button><Button type="submit" variant="primary">{m.save()}</Button></div>
      </form>
    </Dialog>
  )
}
