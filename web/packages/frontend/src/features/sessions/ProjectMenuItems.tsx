import { lazy, Suspense, useState } from 'react'
import { useResourceMutation } from './useResourceMutation'
import { useNewChat } from './useNewChat'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { z } from 'zod'
import type { ProjectSchema } from '../../contracts'
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../ui/Menu'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
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
export type ProjectDialog = 'rename' | 'defaults' | 'delete'
// The editor loads on first open, keeping the catalog picker out of the sidebar's static bundle.
const ProjectDefaults = lazy(() => import('./ProjectDefaultsDialog').then((module) => ({ default: module.ProjectDefaults })))

/** A project's actions: new chat, defaults, rename, recolor and delete (TAL-565, TAL-1032). `ProjectDialogs` owns the dialogs they open, outside the closing menu. */
export function ProjectMenuItems({ project, onDialog }: { project: Project; onDialog: (dialog: ProjectDialog) => void }) {
  const newChat = useNewChat()
  const id = project.project_id
  // `project` is the displayed project, so a recolor keeps a rename the server has not confirmed yet.
  const recolor = useResourceMutation({ resource: () => `project:${id}`, effect: (color: string) => ({ fields: { color } }), mutationFn: (color) => api.renameProject(id, project.name, color), onError: (e) => showErrorToast(e) })
  return (
    <>
      <MenuItem onClick={() => { void newChat(id) }}>{m.project_new_chat()}</MenuItem>
      <MenuItem onClick={() => onDialog('defaults')}>{m.project_defaults()}</MenuItem>
      <MenuItem onClick={() => onDialog('rename')}>{m.rename()}</MenuItem>
      <MenuRadioGroup value={project.color ?? ''} onValueChange={(hex: string) => recolor.mutate(hex)} aria-label={m.project_color()} className="flex px-1">
        {PROJECT_COLORS.map((c) => (
          // A 32px target around a 16px dot keeps touch picks off the neighbouring color.
          <MenuRadioItem key={c.hex} value={c.hex} closeOnClick aria-label={c.name()} title={c.name()} className="group flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none data-[highlighted]:bg-hover">
            <span className="h-4 w-4 rounded-full group-data-[checked]:ring-2 group-data-[checked]:ring-text" style={{ background: c.hex }} aria-hidden="true" />
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem className="text-error" onClick={() => onDialog('delete')}>{m.delete()}</MenuItem>
    </>
  )
}

function ProjectRenameDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const id = project.project_id
  const [name, setName] = useState(project.name)
  const rename = useResourceMutation({ resource: () => `project:${id}`, effect: (name: string) => ({ fields: { name } }), mutationFn: (name) => api.renameProject(id, name), onError: (e) => showErrorToast(e) })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.project_rename()}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) { rename.mutate(name.trim()); onClose() } }} className="flex flex-col gap-3">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={m.project_new_prompt()} aria-label={m.project_new_prompt()} maxLength={128} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!name.trim()}>{m.save()}</Button></div>
      </form>
    </Dialog>
  )
}

/** One project's dialogs, mounted for every project so a defaults save outlives a change of the selected project. */
export function ProjectDialogs({ project, dialog, onDialog, onDeleted }: { project: Project; dialog: ProjectDialog | null; onDialog: (dialog: ProjectDialog | null) => void; onDeleted: () => void }) {
  // Mounted from the first open on, so a save outlives the closed editor and a refusal can reopen it.
  const [defaultsLoaded, setDefaultsLoaded] = useState(false)
  if (dialog === 'defaults' && !defaultsLoaded) setDefaultsLoaded(true)
  const id = project.project_id
  const del = useResourceMutation({ resource: () => `project:${id}`, effect: () => ({ remove: true }), mutationFn: () => api.deleteProject(id), onError: (e) => showErrorToast(e) })
  return (
    <>
      {dialog === 'rename' && <ProjectRenameDialog project={project} onClose={() => onDialog(null)} />}
      {defaultsLoaded && <Suspense fallback={null}><ProjectDefaults project={project} open={dialog === 'defaults'} onOpenChange={(open) => onDialog(open ? 'defaults' : null)} /></Suspense>}
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={(o) => { if (!o) onDialog(null) }} title={m.project_delete_confirm({ name: project.name })} description={m.project_delete_desc()} confirmLabel={m.project_delete()} cancelLabel={m.cancel()} danger onConfirm={() => { del.mutate(); onDeleted() }} />
    </>
  )
}
