import { useState } from 'react'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { ProjectSchema } from '../../contracts'
import { FilterCheckboxItem, FilterMenu, FilterRadioItem } from '../../shell/FilterMenu'
import { MenuGroupLabel, MenuItem, MenuRadioGroup, MenuSeparator, MenuSubmenu } from '../../ui/Menu'
import { showErrorToast } from '../toast/errorToast'
import { ProjectDialogs, ProjectMenuItems, type ProjectDialog } from './ProjectMenuItems'
import { useResourceEffects, useResourceMutation } from './useResourceMutation'

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
          {projects.map((p) => <FilterRadioItem key={p.project_id} value={p.project_id}><ProjectName color={p.color} name={p.name} /></FilterRadioItem>)}
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
