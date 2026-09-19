import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useProfilesQuery, useSwitchProfile } from '../../app/queries'
import { HubPage } from '../../shell/AppShell'
import { PanelHeadButton } from '../../shell/Sidebar'
import { Button, IconButton } from '../../ui/Button'
import { FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

export function ProfilesPage() {
  const qc = useQueryClient()
  const profiles = useProfilesQuery()
  const switchProfile = useSwitchProfile()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const del = useMutation({ mutationFn: (name: string) => api.deleteProfile(name), onSuccess: () => { showToast(m.profile_deleted_toast()); void qc.invalidateQueries({ queryKey: keys.profiles }) }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  const list = profiles.data?.profiles ?? []
  const active = profiles.data?.active
  return (
    <HubPage title={m.tab_profiles()} actions={!profiles.data?.single_profile_mode && <PanelHeadButton label={m.profile_create()} className="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}>
      <div className="mb-4 rounded-lg border border-border bg-surface p-3 text-sm">
        <div className="font-medium text-text">{m.profile_concept_title()}</div>
        <div className="mt-1 text-xs text-muted">{m.profile_concept_subtitle()}</div>
        <ul className="mt-2 list-disc pl-5 text-xs text-muted">
          <li>{m.profile_concept_desc_profiles()}</li>
          <li>{m.profile_concept_desc_workspaces()}</li>
          <li>{m.profile_concept_desc_together()}</li>
        </ul>
      </div>
      {profiles.isPending && <LoadingState />}
      {profiles.isError && <ErrorState error={profiles.error} onRetry={() => { void profiles.refetch() }} />}
      {profiles.isSuccess && list.length === 0 && <EmptyState>{m.profile_no_configuration()}</EmptyState>}
      <ul className="flex flex-col gap-2" id="profilesPanel">
        {list.map((p) => {
          const isActive = p.name === active
          return (
            <li key={p.name} className={cn('flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5', isActive && 'border-accent-bg-strong')} data-profile={p.name}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  <span className="truncate">{p.name}</span>
                  {p.is_default && <span className="text-xs text-muted">{m.profile_default_label()}</span>}
                  {isActive && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-text">{m.profile_active()}</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                  {p.model && <span>{p.provider ? `${p.provider} · ` : ''}{p.model}</span>}
                  {p.has_env ? <span>{m.profile_api_keys_configured()}</span> : <span>{m.profile_no_configuration()}</span>}
                  {p.gateway_running !== undefined && <span>{p.gateway_running ? m.profile_gateway_running() : m.profile_gateway_stopped()}</span>}
                  {(p.enabled_skills ?? p.skill_count) !== undefined && <span>{m.profile_skill_count({ count: p.enabled_skills ?? p.skill_count ?? 0 })}</span>}
                </div>
              </div>
              {!isActive && <Button onClick={() => switchProfile.mutate(p.name, { onSuccess: () => { showToast(m.profile_switched({ name: p.name })); window.location.reload() } })} title={m.profile_switch_title()}>{m.profile_use()}</Button>}
              {!p.is_default && !isActive && <IconButton label={m.profile_delete_title()} onClick={() => setDeleting(p.name)}><Trash2 size={14} aria-hidden="true" /></IconButton>}
            </li>
          )
        })}
      </ul>
      {creating && <CreateProfileDialog existing={list.map((p) => p.name)} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void qc.invalidateQueries({ queryKey: keys.profiles }) }} />}
      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }} title={m.profile_delete_confirm_title({ name: deleting ?? '' })} description={m.profile_delete_confirm_body()} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => { if (deleting) del.mutate(deleting) }} />
    </HubPage>
  )
}

function CreateProfileDialog({ existing, onClose, onCreated }: { existing: string[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => api.createProfile({ name: name.trim(), clone_from: cloneFrom || undefined, clone_config: !!cloneFrom, default_model: model.trim() || undefined }),
    onSuccess: (res) => { if (res.error) setError(res.error); else { showToast(m.profile_created_toast()); onCreated() } },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim())
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.profile_create()}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate() }} className="flex flex-col gap-1">
        <FieldRow label={m.profile_name_label()} htmlFor="profileName"><TextInput id="profileName" autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={m.profile_name_placeholder()} aria-invalid={name !== '' && !valid} /></FieldRow>
        <FieldRow label={m.profile_clone_from()} htmlFor="profileClone">
          <Select id="profileClone" value={cloneFrom} onValueChange={(v) => setCloneFrom(v)} className="w-full">
            <option value="">{m.profile_no_clone()}</option>
            {existing.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </FieldRow>
        <FieldRow label={m.profile_default_model_label()} htmlFor="profileModel"><TextInput id="profileModel" value={model} onChange={(e) => setModel(e.target.value)} placeholder={m.model_custom_placeholder()} /></FieldRow>
        {error && <div role="alert" className="text-sm text-error">{error}</div>}
        <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!valid || create.isPending}>{m.create()}</Button></div>
      </form>
    </Dialog>
  )
}
