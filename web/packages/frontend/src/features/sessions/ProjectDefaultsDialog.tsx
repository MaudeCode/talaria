/** TAL-1032: a project's chat defaults editor, loaded on first open (see ProjectChip). */
import { useState } from 'react'
import { X } from 'lucide-react'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { ProjectSchema } from '../../contracts'
import { Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { useModelsQuery, useWorkspacesQuery } from '../../app/queries'
import { catalogEntryById } from '../../lib/modelEntry'
import { useResourceMutation } from './useResourceMutation'
import { showErrorToast } from '../toast/errorToast'
import { catalogModelOptgroups } from '../../lib/modelOptgroups'

type Project = z.infer<typeof ProjectSchema>
/** The editable bindings; `model` is a catalog entry id, or the saved bare model while it stays untouched. */
interface Defaults { workspaces: string[]; default_workspace: string; model: string }
/** One save: the request, the project as it shows until the server confirms, and the draft a refusal reopens. */
interface DefaultsSave { body: Parameters<typeof api.bindProject>[0]; shown: Partial<Project>; draft: Defaults }
const savedModel = (project: Project) => project.model_option_id ?? project.model ?? ''

/** TAL-1032: a project's bound workspaces, the one new chats start in, and their model. Every choice comes from the saved workspace list and the model catalog. */
function ProjectDefaultsDialog({ project, initial, onCancel, onSave }: { project: Project; initial: Defaults | null; onCancel: () => void; onSave: (save: DefaultsSave) => void }) {
  const [draft, setDraft] = useState<Defaults>(() => initial ?? { workspaces: project.workspaces ?? [], default_workspace: project.default_workspace ?? '', model: savedModel(project) })
  const workspaces = useWorkspacesQuery()
  const models = useModelsQuery()
  const save = () => {
    // An untouched model re-sends the saved pair, so a choice the catalog no longer offers survives other edits.
    const untouched = draft.model === savedModel(project)
    const entry = untouched ? undefined : catalogEntryById(models.data, draft.model)
    const model = untouched ? project.model ?? null : draft.model || null
    const provider = untouched ? project.model_provider ?? null : model ? entry?.provider_id ?? null : null
    const body = { project_id: project.project_id, workspaces: draft.workspaces, default_workspace: draft.default_workspace || null, model, model_provider: provider }
    const shown = { workspaces: draft.workspaces, default_workspace: draft.default_workspace || null, model: untouched ? model : entry?.bare_id ?? model, model_provider: provider, model_option_id: untouched ? project.model_option_id ?? null : draft.model || null }
    onSave({ body, shown, draft })
  }
  const saved = workspaces.data?.workspaces ?? []
  const nameOf = (path: string) => saved.find((w) => w.path === path)?.name ?? path
  const addable = saved.filter((w) => !draft.workspaces.includes(w.path))
  const remove = (path: string) => setDraft((d) => ({ ...d, workspaces: d.workspaces.filter((w) => w !== path), default_workspace: d.default_workspace === path ? '' : d.default_workspace }))
  // A saved model the catalog no longer offers stays listed under its own name until the user picks another.
  const unavailable = project.model && !project.model_option_id ? project.model : null
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }} title={m.project_defaults()}>
      <form onSubmit={(e) => { e.preventDefault(); save() }} className="flex flex-col gap-3">
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

/**
 * The project's defaults editor and its save. The project shows the saved defaults at once; a refusal rolls them back and
 * reopens the editor on the draft. ProjectChip keeps this mounted after the first open, so a save outlives the closed editor.
 */
export function ProjectDefaults({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState<Defaults | null>(null)
  const [opened, setOpened] = useState(open)
  // Closing forgets the draft, so a menu open starts on the saved defaults; a refusal restores its draft after the close.
  if (opened !== open) { setOpened(open); if (!open) setDraft(null) }
  const bind = useResourceMutation({
    resource: () => `project:${project.project_id}`,
    effect: ({ shown }: DefaultsSave) => ({ fields: shown }),
    mutationFn: ({ body }) => api.bindProject(body), onError: (e) => showErrorToast(e),
  })
  const save = (next: DefaultsSave) => {
    onOpenChange(false)
    bind.mutate(next, { onError: () => { onOpenChange(true); setDraft(next.draft) } })
  }
  return open ? <ProjectDefaultsDialog project={project} initial={draft} onCancel={() => onOpenChange(false)} onSave={save} /> : null
}
