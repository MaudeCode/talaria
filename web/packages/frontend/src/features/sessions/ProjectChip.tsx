import { lazy, Suspense, useState } from 'react'
import { useResourceMutation } from './useResourceMutation'
import { useNewChat } from './useNewChat'
import { MoreHorizontal } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { z } from 'zod'
import type { ProjectSchema } from '../../contracts'
import { ContextMenu, Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../ui/Menu'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
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
// The editor loads on first open, keeping the catalog picker out of the sidebar's static bundle.
const ProjectDefaults = lazy(() => import('./ProjectDefaultsDialog').then((module) => ({ default: module.ProjectDefaults })))

/** A sidebar project filter chip; right-click, long-press or the selected chip's actions button opens new chat, defaults, rename, recolor and delete (TAL-565, TAL-1032). */
export function ProjectChip({ project, active, onSelect, onDeleted }: { project: Project; active: boolean; onSelect: () => void; onDeleted: () => void }) {
  const [dialog, setDialog] = useState<'rename' | 'defaults' | 'delete' | null>(null)
  // Mounted from the first open on, so a save outlives the closed editor and a refusal can reopen it.
  const [defaultsLoaded, setDefaultsLoaded] = useState(false)
  const newChat = useNewChat()
  const [name, setName] = useState(project.name)
  const id = project.project_id
  const fail = (e: unknown) => showErrorToast(e)
  // `project` is the displayed project, so a recolor keeps a rename the server has not confirmed yet.
  const rename = useResourceMutation({ resource: () => `project:${id}`, effect: (name: string) => ({ fields: { name } }), mutationFn: (name) => api.renameProject(id, name), onError: fail })
  const recolor = useResourceMutation({ resource: () => `project:${id}`, effect: (color: string) => ({ fields: { color } }), mutationFn: (color) => api.renameProject(id, project.name, color), onError: fail })
  const del = useResourceMutation({ resource: () => `project:${id}`, effect: () => ({ remove: true }), mutationFn: () => api.deleteProject(id), onError: fail })
  const items = (
    <>
      <MenuItem onClick={() => { void newChat(id) }}>{m.project_new_chat()}</MenuItem>
      <MenuItem onClick={() => { setDefaultsLoaded(true); setDialog('defaults') }}>{m.project_defaults()}</MenuItem>
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
      {defaultsLoaded && <Suspense fallback={null}><ProjectDefaults project={project} open={dialog === 'defaults'} onOpenChange={(open) => setDialog(open ? 'defaults' : null)} /></Suspense>}
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.project_delete_confirm({ name: project.name })} description={m.project_delete_desc()} confirmLabel={m.project_delete()} cancelLabel={m.cancel()} danger onConfirm={() => { del.mutate(); onDeleted() }} />
    </>
  )
}
