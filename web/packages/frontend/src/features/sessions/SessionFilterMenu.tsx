import { useState, type ReactNode } from 'react'
import { Check, ListFilter } from 'lucide-react'
import type { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import type { ProjectSchema } from '../../contracts'
import { PANEL_HEAD_BTN } from '../../shell/PanelHead'
import { cn } from '../../ui/cn'
import { MENU_CHOICE, Menu, MenuCheckboxItem, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSubmenu } from '../../ui/Menu'
import { showErrorToast } from '../toast/errorToast'
import { ProjectDialogs, ProjectMenuItems, type ProjectDialog } from './ProjectMenuItems'
import { useResourceEffects, useResourceMutation } from './useResourceMutation'

/** The Unassigned choice of the project filter. */
export const NO_PROJECT = '__none__'
export type SessionSource = 'webui' | 'cli'

const CHECK = <Check size={14} className="hidden shrink-0 group-data-[checked]:block" aria-hidden="true" />

function FilterRow({ value, disabled, title, children }: { value: string; disabled?: boolean; title?: string; children: ReactNode }) {
  return <MenuRadioItem value={value} disabled={!!disabled} closeOnClick title={title} className={cn(MENU_CHOICE, 'group data-[disabled]:opacity-50')}>{children}<span className="flex-1" />{CHECK}</MenuRadioItem>
}

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
      <Menu
        align="end"
        // A phone's heading sits mid-drawer: moving over the trigger shows every row, where a flip would scroll half of them away.
        collisionAvoidance={{ side: 'shift' }}
        trigger={<button type="button" className={cn(PANEL_HEAD_BTN, 'has-tooltip--bottom-right data-[popup-open]:after:hidden pointer-coarse:-my-2 pointer-coarse:size-11 data-[filtered]:bg-accent-bg data-[filtered]:text-accent-text data-[filtered]:hover:bg-accent-bg data-[filtered]:hover:text-accent-text')} data-filtered={filtered ? '' : undefined} data-tooltip={label} aria-label={label}><ListFilter size={16} aria-hidden="true" /></button>}
      >
        {cliCount > 0 && (
          <>
            <MenuRadioGroup value={source} onValueChange={onSource}>
              <MenuGroupLabel>{m.chats_filter_source()}</MenuGroupLabel>
              <FilterRow value="webui">{m.sessions_source_webui({ n: webuiCount })}</FilterRow>
              <FilterRow value="cli">{m.sessions_source_cli({ n: cliCount })}</FilterRow>
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        )}
        <MenuRadioGroup value={project ?? ''} onValueChange={(next: string) => onProject(next || null)}>
          <MenuGroupLabel>{m.chats_filter_projects()}</MenuGroupLabel>
          <FilterRow value="">{m.project_all()}</FilterRow>
          {hasUnprojected && <FilterRow value={NO_PROJECT} title={m.project_unassigned_hint()}>{m.project_unassigned()}</FilterRow>}
          {newProject && <FilterRow value="project:new" disabled><ProjectName color={null} name={newProject} /></FilterRow>}
          {projects.map((p) => <FilterRow key={p.project_id} value={p.project_id}><ProjectName color={p.color} name={p.name} /></FilterRow>)}
        </MenuRadioGroup>
        <MenuItem onClick={() => { const name = window.prompt(m.project_new_prompt()); if (name?.trim()) createProject.mutate(name.trim()) }}>{m.project_new()}</MenuItem>
        {selected && <MenuSubmenu trigger={m.project_selected()}><ProjectMenuItems project={selected} onDialog={(kind) => setDialog({ id: selected.project_id, kind })} /></MenuSubmenu>}
        <MenuSeparator />
        <MenuCheckboxItem checked={showArchived} onCheckedChange={onShowArchived} closeOnClick className={cn(MENU_CHOICE, 'group')}>{m.session_show_archived()}<span className="flex-1" />{CHECK}</MenuCheckboxItem>
        <MenuItem onClick={onImport}>{m.import_session_json_tooltip()}</MenuItem>
      </Menu>
      {projects.map((p) => <ProjectDialogs key={p.project_id} project={p} dialog={dialog?.id === p.project_id ? dialog.kind : null} onDialog={(kind) => setDialog(kind ? { id: p.project_id, kind } : null)} onDeleted={() => { if (project === p.project_id) onProject(null) }} />)}
    </>
  )
}
