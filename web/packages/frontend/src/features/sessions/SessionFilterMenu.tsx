import { Fragment, useState } from 'react'
import { Plus } from 'lucide-react'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { useSetting } from '../../app/queries'
import type { ProjectSchema } from '../../contracts'
import { FilterCheckboxItem, FilterMenu, FilterRadioItem } from '../../shell/FilterMenu'
import { MenuGroupLabel, MenuItem, MenuRadioGroup, MenuSeparator, MenuSubmenu } from '../../ui/Menu'
import { showErrorToast } from '../toast/errorToast'
import { ProjectDialogs, ProjectMenuItems, type ProjectDialog } from './ProjectMenuItems'
import { useResourceEffects, useResourceMutation } from './useResourceMutation'
import { useNewChat } from './useNewChat'

/** The Unassigned choice of the project filter. */
export const NO_PROJECT = '__none__'
export type SessionSource = 'webui' | 'cli'

const ProjectName = ({ color, name }: { color: string | null | undefined; name: string }) => <>
  <span className="session-project-dot" style={{ background: color ?? 'var(--blue)' }} aria-hidden="true" />
  <span className="min-w-0 truncate">{name}</span>
</>

/** The Chats heading's one filter control, after the App's `SessionFilterControls`: source, project, the selected project's actions, archived rows and import (TAL-1869). */
export function SessionFilterMenu({ source, onSource, webuiCount, cliCount, project, onProject, projects, hasUnprojected, showArchived, onShowArchived, onImport }: {
  source: SessionSource
  onSource: (source: SessionSource) => void
  webuiCount: number
  cliCount: number
  project: string | null
  onProject: (project: string | null) => void
  projects: z.infer<typeof ProjectSchema>[]
  hasUnprojected: boolean
  showArchived: boolean
  onShowArchived: (show: boolean) => void
  onImport: () => void
}) {
  const [dialog, setDialog] = useState<{ id: string; kind: ProjectDialog } | null>(null)
  const quickCreate = useSetting('project_quick_create_buttons') === true
  const newChat = useNewChat()
  const createProject = useResourceMutation({
    resource: () => 'project:new',
    effect: (name: string) => ({ fields: { name } }),
    exclusive: true,
    mutationFn: (name) => api.createProject(name),
    onError: (e) => showErrorToast(e),
  })
  const newName = useResourceEffects()['project:new']?.fields?.name
  // The provisional row gives way as soon as the server's list carries the created project.
  const newProject = typeof newName === 'string' && !projects.some((p) => p.name === newName) ? newName : null
  const selected = projects.find((p) => p.project_id === project)
  const filtered = (cliCount > 0 && source === 'cli') || !!project || showArchived
  const label = filtered ? m.chats_filtered() : m.chats_filter()
  return (
    <>
      <FilterMenu label={label} filtered={filtered}>
        {cliCount > 0 && (
          <>
            <MenuRadioGroup value={source} onValueChange={onSource}>
              <MenuGroupLabel>{m.chats_filter_source()}</MenuGroupLabel>
              <FilterRadioItem value="webui">{m.sessions_source_webui({ n: webuiCount })}</FilterRadioItem>
              <FilterRadioItem value="cli">{m.sessions_source_cli({ n: cliCount })}</FilterRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        )}
        <MenuRadioGroup value={project ?? ''} onValueChange={(next: string) => onProject(next || null)}>
          <MenuGroupLabel>{m.chats_filter_projects()}</MenuGroupLabel>
          <FilterRadioItem value="">{m.project_all()}</FilterRadioItem>
          {hasUnprojected && <FilterRadioItem value={NO_PROJECT} title={m.project_unassigned_hint()}>{m.project_unassigned()}</FilterRadioItem>}
          {newProject && <FilterRadioItem value="project:new" disabled><ProjectName color={null} name={newProject} /></FilterRadioItem>}
          {projects.map((p) => {
            const item = <FilterRadioItem value={p.project_id}><ProjectName color={p.color} name={p.name} /></FilterRadioItem>
            // TAL-2153: `project_quick_create_buttons` ends each project row in its own New chat item.
            return quickCreate ? <div key={p.project_id} role="none" className="grid grid-cols-[minmax(0,1fr)_auto] items-center">
              {item}
              <MenuItem aria-label={m.project_new_chat_in({ project: p.name })} title={m.project_new_chat_in({ project: p.name })} className="size-7 justify-center p-0 pointer-coarse:size-11" onClick={() => { void newChat(p.project_id) }}><Plus size={14} className="shrink-0" aria-hidden="true" /></MenuItem>
            </div> : <Fragment key={p.project_id}>{item}</Fragment>
          })}
        </MenuRadioGroup>
        <MenuItem onClick={() => { const name = window.prompt(m.project_new_prompt()); if (name?.trim()) createProject.mutate(name.trim()) }}>{m.project_new()}</MenuItem>
        {selected && <MenuSubmenu trigger={m.project_selected()}><ProjectMenuItems project={selected} onDialog={(kind) => setDialog({ id: selected.project_id, kind })} /></MenuSubmenu>}
        <MenuSeparator />
        <FilterCheckboxItem checked={showArchived} onCheckedChange={onShowArchived}>{m.session_show_archived()}</FilterCheckboxItem>
        <MenuItem onClick={onImport}>{m.import_session_json_tooltip()}</MenuItem>
      </FilterMenu>
      {projects.map((p) => <ProjectDialogs key={p.project_id} project={p} dialog={dialog?.id === p.project_id ? dialog.kind : null} onDialog={(kind) => setDialog(kind ? { id: p.project_id, kind } : null)} onDeleted={() => { if (project === p.project_id) onProject(null) }} />)}
    </>
  )
}
