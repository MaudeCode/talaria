import { useBootstrap } from '../../app/bootstrap'
import { AgentImportDialog } from './AgentImportDialog'
import { useState } from 'react'
import type { GatewayMode } from '@maudecode/talaria-web-contracts'
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
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'
import { appUrl } from '../../lib/appRoot'

// TAL-805: `gateway_running` labels rows from a server without `gateway_mode`; delete the fallback once every supported server ships the field.
const GATEWAY_MODE_LABEL: Record<GatewayMode, () => string> = {
  own: m.profile_gateway_running, served: m.profile_gateway_served, parked: m.profile_gateway_parked, standalone: m.profile_gateway_standalone, stopped: m.profile_gateway_stopped,
}

type NewProfile = Record<string, unknown> & { name: string; default_model?: string | undefined }

export function ProfilesPage() {
  const profiles = useProfilesQuery()
  const canImport = useBootstrap().auth.can_manage_server
  const switchProfile = useSwitchProfile()
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const onError = (e: unknown) => showErrorToast(e)
  const del = useResourceMutation({ resource: (name: string) => `profile:${name}`, queryKey: keys.profiles, effect: () => ({ remove: true }), mutationFn: (name) => api.deleteProfile(name), onSuccess: () => showToast(m.profile_deleted_toast()), onError })
  // A new profile shows at once by its name; the server fills in the rest on its reread.
  const create = useResourceMutation({
    resource: ({ name }: NewProfile) => `profile:new:${name}`, queryKey: keys.profiles, exclusive: true,
    effect: ({ name, default_model }) => ({ fields: { name, model: default_model } }),
    mutationFn: (body) => api.createProfile(body), onSuccess: () => showToast(m.profile_created_toast()), onError,
  })
  const effects = useResourceEffects()
  const list = withCreated(withEffects(profiles.data?.profiles ?? [], (p) => `profile:${p.name}`, effects), 'profile', effects)
  const active = profiles.data?.active
  // TAL-213: the server resolves each profile's canonical Bot Chat. Opening it always reasserts the profile (another tab
  // may have moved the shared cookie) and opens the chat from the row the switch just resolved.
  const openBotChat = (name: string) => {
    switchProfile.mutate(name, {
      onSuccess: (res) => {
        const sessionId = res.profiles.find((p) => p.name === name)?.canonical_session?.tip_session_id
        if (sessionId) window.location.assign(appUrl(`session/${encodeURIComponent(sessionId)}`).href)
        else window.location.reload()
      },
      onError: (e) => showErrorToast(e),
    })
  }
  return (
    <HubPage title={m.tab_profiles()} help={<ProfileConceptHelp />} actions={!profiles.data?.single_profile_mode && <PanelHeadButton label={m.profile_create()} className="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}>
      {canImport && <div className="flex justify-end"><Button className="min-h-11" onClick={() => setImporting(true)}>{m.profile_import()}</Button></div>}
      {importing && <AgentImportDialog key={active} onClose={() => setImporting(false)} />}
      {profiles.isPending && <LoadingState />}
      {profiles.isError && <ErrorState error={profiles.error} onRetry={() => { void profiles.refetch() }} />}
      {profiles.isSuccess && list.length === 0 && <EmptyState>{m.profile_no_configuration()}</EmptyState>}
      <ul className="flex flex-col gap-2" id="profilesPanel">
        {list.map((p) => {
          const isActive = p.name === active
          const provisional = !profiles.data?.profiles.some((confirmedProfile) => confirmedProfile.name === p.name)
          return (
            <li key={p.name} className={cn('flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5', isActive && 'border-accent-bg-strong')} data-profile={p.name}>
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  {p.display_name && <span className="truncate">{p.display_name}</span>}
                  <span className={cn('truncate', p.display_name && 'text-xs font-normal text-muted')}>{p.name}</span>
                  {p.is_default && <span className="text-xs text-muted">{m.profile_default_label()}</span>}
                  {isActive && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-text">{m.profile_active()}</span>}
                </div>
                {p.description && <div className="mt-0.5 truncate text-xs text-muted" title={p.description}>{p.description}</div>}
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                  {p.model && <span>{p.provider ? `${p.provider} · ` : ''}{p.model}</span>}
                  {p.has_env ? <span>{m.profile_api_keys_configured()}</span> : <span>{m.profile_no_configuration()}</span>}
                  {p.gateway_mode ? <span>{GATEWAY_MODE_LABEL[p.gateway_mode]()}</span> : p.gateway_running !== undefined && <span>{p.gateway_running ? m.profile_gateway_running() : m.profile_gateway_stopped()}</span>}
                  {(p.enabled_skills ?? p.skill_count) !== undefined && <span>{m.profile_skill_count({ count: p.enabled_skills ?? p.skill_count ?? 0 })}</span>}
                </div>
              </div>
              {/* A profile the server has not created yet has nothing to open, use or delete. */}
              {!provisional && (
                <div className="ml-auto flex items-center gap-3">
                  {p.canonical_session && <Button onClick={() => openBotChat(p.name)} disabled={switchProfile.isPending}>{m.profile_open_bot_chat()}</Button>}
                  {!isActive && <Button onClick={() => switchProfile.mutate(p.name, { onSuccess: () => { showToast(m.profile_switched({ name: p.name })); window.location.reload() } })} title={m.profile_switch_title()}>{m.profile_use()}</Button>}
                  {!p.is_default && !isActive && <IconButton label={m.profile_delete_title()} onClick={() => setDeleting(p.name)}><Trash2 size={14} aria-hidden="true" /></IconButton>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {creating && <CreateProfileDialog existing={list.map((p) => p.name)} onClose={() => setCreating(false)} onSubmit={(body) => { setCreating(false); create.mutate(body) }} />}
      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }} title={m.profile_delete_confirm_title({ name: deleting ?? '' })} description={m.profile_delete_confirm_body()} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => { if (deleting) del.mutate(deleting) }} />
    </HubPage>
  )
}

/** Closes on Create: the profile shows at once while the server creates it. */
function CreateProfileDialog({ existing, onClose, onSubmit }: { existing: string[]; onClose: () => void; onSubmit: (body: NewProfile) => void }) {
  const [name, setName] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [model, setModel] = useState('')
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim())
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.profile_create()}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ name: name.trim(), clone_from: cloneFrom || undefined, clone_config: !!cloneFrom, default_model: model.trim() || undefined }) }} className="flex flex-col gap-1">
        <FieldRow label={m.profile_name_label()} htmlFor="profileName"><TextInput id="profileName" autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={m.profile_name_placeholder()} aria-invalid={name !== '' && !valid} /></FieldRow>
        <FieldRow label={m.profile_clone_from()} htmlFor="profileClone">
          <Select id="profileClone" value={cloneFrom} onValueChange={(v) => setCloneFrom(v)} className="w-full">
            <option value="">{m.profile_no_clone()}</option>
            {existing.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </FieldRow>
        <FieldRow label={m.profile_default_model_label()} htmlFor="profileModel"><TextInput id="profileModel" value={model} onChange={(e) => setModel(e.target.value)} placeholder={m.model_custom_placeholder()} /></FieldRow>
        <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!valid}>{m.create()}</Button></div>
      </form>
    </Dialog>
  )
}

function ProfileConceptHelp() {
  return (
    <>
      <div className="font-medium">{m.profile_concept_title()}</div>
      <div className="mt-1">{m.profile_concept_subtitle()}</div>
      <ul className="mt-2 list-disc pl-4">
        <li>{m.profile_concept_desc_profiles()}</li>
        <li>{m.profile_concept_desc_workspaces()}</li>
        <li>{m.profile_concept_desc_together()}</li>
      </ul>
    </>
  )
}
