import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { z } from 'zod'
import type { ProjectSchema } from '../../contracts'
import { ContextMenu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../ui/Menu'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { cn } from '../../ui/cn'
import { showToast } from '../toast/toast'

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

/** A sidebar project filter chip; right-click or long-press opens rename, recolor and delete (TAL-565). */
export function ProjectChip({ project, active, onSelect, onDeleted }: { project: z.infer<typeof ProjectSchema>; active: boolean; onSelect: () => void; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [name, setName] = useState(project.name)
  const id = project.project_id
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const refresh = () => { void qc.invalidateQueries({ queryKey: keys.projects }) }
  const rename = useMutation({ mutationFn: () => api.renameProject(id, name.trim()), onSuccess: () => { setDialog(null); refresh() }, onError: fail })
  const recolor = useMutation({ mutationFn: (color: string) => api.renameProject(id, project.name, color), onSuccess: refresh, onError: fail })
  // Deleting unassigns the project's conversations, so the session rows change too.
  const del = useMutation({ mutationFn: () => api.deleteProject(id), onSuccess: () => { onDeleted(); refresh(); void qc.invalidateQueries({ queryKey: keys.sessions.all }) }, onError: fail })
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
        <MenuItem onClick={() => { setName(project.name); setDialog('rename') }}>{m.rename()}</MenuItem>
        <MenuRadioGroup value={project.color ?? ''} onValueChange={(hex: string) => recolor.mutate(hex)} aria-label={m.project_color()} className="flex gap-1.5 px-2.5 py-1.5">
          {PROJECT_COLORS.map((c) => (
            <MenuRadioItem key={c.hex} value={c.hex} closeOnClick aria-label={c.name()} title={c.name()} className="h-4 w-4 shrink-0 cursor-pointer rounded-full outline-none data-[checked]:ring-2 data-[checked]:ring-text data-[highlighted]:ring-2 data-[highlighted]:ring-muted" style={{ background: c.hex }} />
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem className="text-error" onClick={() => setDialog('delete')}>{m.delete()}</MenuItem>
      </ContextMenu>
      {dialog === 'rename' && (
        <Dialog open onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.project_rename()}>
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate() }} className="flex flex-col gap-3">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={m.project_new_prompt()} aria-label={m.project_new_prompt()} maxLength={128} />
            <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={rename.isPending || !name.trim()}>{m.save()}</Button></div>
          </form>
        </Dialog>
      )}
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={(o) => { if (!o) setDialog(null) }} title={m.project_delete_confirm({ name: project.name })} description={m.project_delete_desc()} confirmLabel={m.project_delete()} cancelLabel={m.cancel()} danger onConfirm={() => del.mutate()} />
    </>
  )
}
