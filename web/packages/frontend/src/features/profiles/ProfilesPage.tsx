import { useBootstrap } from '../../app/bootstrap'
import { AgentImportDialog } from './AgentImportDialog'
import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { GatewayMode, Profiles } from '@maudecode/talaria-web-contracts'
import { Import, Plus, Trash2, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useModelsQuery, useProfilesQuery, useSwitchProfile } from '../../app/queries'
import { catalogEntryById } from '../../lib/modelEntry'
import { catalogModelOptgroups } from '../../lib/modelOptgroups'
import { HubPage } from '../../shell/AppShell'
import { PanelHeadButton } from '../../shell/PanelHead'
import { Badge } from '../../ui/Badge'
import { BackButton, Button, IconButton, buttonClass } from '../../ui/Button'
import { FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Row, RowList } from '../../ui/List'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionsMenu } from '../../ui/RowActionsMenu'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'
import { appUrl } from '../../lib/appRoot'
import { SettingLink, SettingValue, SettingValues, SettingsGroup } from '../settings/SettingsRows'

// TAL-805: `gateway_running` labels rows from a server without `gateway_mode`; delete the fallback once every supported server ships the field.
const GATEWAY_MODE_LABEL: Record<GatewayMode, () => string> = {
  own: m.profile_gateway_running, served: m.profile_gateway_served, parked: m.profile_gateway_parked, standalone: m.profile_gateway_standalone, stopped: m.profile_gateway_stopped,
}

type Profile = Profiles['profiles'][number]

const gatewayLabel = (p: Profile): string | undefined => p.gateway_mode ? GATEWAY_MODE_LABEL[p.gateway_mode]()
  : p.gateway_running === undefined ? undefined : p.gateway_running ? m.profile_gateway_running() : m.profile_gateway_stopped()

type NewProfile = Record<string, unknown> & { name: string; default_model?: string | undefined }
type ProfileAction = RowAction & { title?: string; Icon?: LucideIcon }

/** Settings > Profiles: the list, or with `name` (TAL-2085) that profile's detail. */
export function ProfilesPage({ name }: { name?: string | undefined } = {}) {
  const profiles = useProfilesQuery()
  const navigate = useNavigate()
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
  const toList = () => { void navigate({ to: '/settings/$section', params: { section: 'profiles' }, search: {} }) }
  // A profile the server has not created yet has no detail to open and nothing to use or delete.
  const confirmed = (p: Profile) => !!profiles.data?.profiles.some((row) => row.name === p.name)
  const actionsFor = (p: Profile): ProfileAction[] => {
    if (!confirmed(p)) return []
    const isActive = p.name === active
    return [
      ...(p.canonical_session ? [{ label: m.profile_open_bot_chat(), run: () => openBotChat(p.name), disabled: switchProfile.isPending }] : []),
      ...(!isActive ? [{ label: m.profile_use(), title: m.profile_switch_title(), run: () => switchProfile.mutate(p.name, { onSuccess: () => { showToast(m.profile_switched({ name: p.name })); window.location.reload() } }) }] : []),
      ...(!p.is_default && !isActive ? [{ label: m.profile_delete_title(), Icon: Trash2, run: () => setDeleting(p.name), danger: true }] : []),
    ]
  }
  // A delete from the detail returns to the list at once; a refused delete brings the row back there.
  const confirmDelete = <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }} title={m.profile_delete_confirm_title({ name: deleting ?? '' })} description={m.profile_delete_confirm_body()} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => { if (!deleting) return; if (name !== undefined) toList(); del.mutate(deleting) }} />
  if (name !== undefined) {
    const profile = list.find((p) => p.name === name)
    return (
      <HubPage title={profile?.display_name || name} actions={<BackButton onClick={toList} />}>
        {profiles.isPending && <LoadingState />}
        {profiles.isError && <ErrorState error={profiles.error} onRetry={() => { void profiles.refetch() }} />}
        {profiles.isSuccess && (profile
          ? <ProfileDetail profile={profile} isActive={profile.name === active} actions={actionsFor(profile)} />
          : (
            <ErrorState>
              <div className="font-medium text-text">{m.profile_detail_not_found({ name })}</div>
              <div><Link to="/settings/$section" params={{ section: 'profiles' }} search={{}} className={buttonClass()}>{m.profile_detail_back_to_list()}</Link></div>
            </ErrorState>
          ))}
        {confirmDelete}
      </HubPage>
    )
  }
  return (
    <HubPage title={m.tab_profiles()} help={<ProfileConceptHelp />} actions={<>
      {canImport && <PanelHeadButton label={m.profile_import()} onClick={() => setImporting(true)}><Import size={16} aria-hidden="true" /></PanelHeadButton>}
      {!profiles.data?.single_profile_mode && <PanelHeadButton label={m.profile_create()} className="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}
    </>}>
      {importing && <AgentImportDialog key={active} onClose={() => setImporting(false)} />}
      {profiles.isPending && <LoadingState />}
      {profiles.isError && <ErrorState error={profiles.error} onRetry={() => { void profiles.refetch() }} />}
      {profiles.isSuccess && list.length === 0 && <EmptyState>{m.profile_no_configuration()}</EmptyState>}
      <RowList id="profilesPanel">
        {list.map((p) => {
          const actions = actionsFor(p)
          const gateway = gatewayLabel(p)
          return (
            <RowContextMenu key={p.name} label={m.profile_row_menu()} actions={actions} trigger={<Row data-profile={p.name}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <ProfileHeading profile={p} isActive={p.name === active} link={confirmed(p)} className="text-sm" />
                  {p.description && <div className="mt-0.5 truncate text-xs text-muted" title={p.description}>{p.description}</div>}
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                    {p.model && <span>{p.provider ? `${p.provider} · ` : ''}{p.model}</span>}
                    {p.has_env ? <span>{m.profile_api_keys_configured()}</span> : <span>{m.profile_no_configuration()}</span>}
                    {gateway && <span>{gateway}</span>}
                    {(p.enabled_skills ?? p.skill_count) !== undefined && <span>{m.profile_skill_count({ count: p.enabled_skills ?? p.skill_count ?? 0 })}</span>}
                  </div>
                </div>
                <RowActionsMenu label={m.profile_row_menu()} actions={actions} />
              </div>
            </Row>} />
          )
        })}
      </RowList>
      {creating && <CreateProfileDialog existing={list.map((p) => p.name)} onClose={() => setCreating(false)} onSubmit={(body) => { setCreating(false); create.mutate(body) }} />}
      {confirmDelete}
    </HubPage>
  )
}

/** A profile's name line: the display name, else the name, then the name muted, and its Default and Active badges. `link` opens its detail. */
function ProfileHeading({ profile: p, isActive, link, className }: { profile: Profile; isActive: boolean; link: boolean; className: string }) {
  const names = <>
    {p.display_name && <span className="truncate">{p.display_name}</span>}
    <span className={cn('truncate', p.display_name && 'text-xs font-normal text-muted')}>{p.name}</span>
  </>
  return (
    <div className={cn('flex min-w-0 items-baseline gap-2 font-semibold text-text', className)}>
      {link
        ? <Link to="/settings/$section" params={{ section: 'profiles' }} search={{ name: p.name }} className="flex min-w-0 items-baseline gap-2 hover:underline">{names}</Link>
        : names}
      {p.is_default && <Badge tone="border-border text-muted">{m.profile_default_badge()}</Badge>}
      {isActive && <Badge tone="border-accent text-accent-text">{m.profile_active()}</Badge>}
    </div>
  )
}

/** TAL-2085: every field the server sent for one profile, read-only, with its actions beside the name and in its context menu. */
function ProfileDetail({ profile: p, isActive, actions }: { profile: Profile; isActive: boolean; actions: ProfileAction[] }) {
  const navigate = useNavigate()
  const gateway = gatewayLabel(p)
  const enabled = p.enabled_skills ?? p.skill_count
  const skills = enabled === undefined ? undefined
    : p.total_skills === undefined ? m.profile_skill_count({ count: enabled }) : m.profile_detail_skills_of({ enabled, total: p.total_skills })
  const pending = p.pending_writes
  const agent = gateway !== undefined || skills !== undefined || p.has_env !== undefined || pending !== undefined
  return (
    <div className="flex flex-col gap-7" data-profile-detail={p.name}>
      <RowContextMenu label={m.profile_row_menu()} actions={actions} trigger={<div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <ProfileHeading profile={p} isActive={isActive} link={false} className="text-base" />
          {p.description && <p className="mt-1 text-sm text-muted">{p.description}</p>}
        </div>
        {actions.length > 0 && (
          <div className="flex items-center gap-3 sm:ml-auto">
            {actions.map(({ label, title, Icon, run, disabled }) => Icon
              ? <IconButton key={label} label={label} onClick={run} disabled={disabled}><Icon size={14} aria-hidden="true" /></IconButton>
              : <Button key={label} onClick={run} disabled={disabled} title={title}>{label}</Button>)}
          </div>
        )}
      </div>} />
      {(p.model || p.provider || isActive) && (
        <SettingsGroup id="profile-model" title={m.profile_detail_model()}>
          {(p.model || p.provider) && (
            <SettingValues>
              {p.model && <SettingValue label={m.profile_default_model_label()}>{p.model}</SettingValue>}
              {p.provider && <SettingValue label={m.profile_detail_provider()}>{p.provider}</SettingValue>}
            </SettingValues>
          )}
          {isActive && <SettingLink label={m.profile_detail_models_link()} onClick={() => { void navigate({ to: '/settings/$section', params: { section: 'models' } }) }} />}
        </SettingsGroup>
      )}
      {agent && (
        <SettingsGroup id="profile-agent" title={m.profile_detail_agent()}>
          <SettingValues>
            {gateway !== undefined && <SettingValue label={m.profile_detail_gateway()}>{gateway}</SettingValue>}
            {skills !== undefined && <SettingValue label={m.profile_detail_skills()}>{skills}</SettingValue>}
            {p.has_env !== undefined && <SettingValue label={m.profile_detail_api_keys()}>{p.has_env ? m.profile_detail_api_keys_set() : m.profile_detail_api_keys_unset()}</SettingValue>}
            {pending !== undefined && <SettingValue label={m.profile_detail_pending_writes()}><span className="tabular-nums">{pending}</span></SettingValue>}
          </SettingValues>
          {pending !== undefined && pending > 0 && <SettingLink label={m.profile_detail_review_skills()} onClick={() => { void navigate({ to: '/skills' }) }} />}
        </SettingsGroup>
      )}
      {p.path && (
        <SettingsGroup id="profile-location" title={m.profile_detail_location()}>
          <SettingValues>
            <SettingValue label={m.profile_detail_path()}><span className="select-text font-mono text-xs">{p.path}</span></SettingValue>
          </SettingValues>
        </SettingsGroup>
      )}
    </div>
  )
}

/**
 * Closes on Create: the profile shows at once while the server creates it. The dialog unmounts on close, so the
 * API key leaves component state with it; only the request body carries it.
 */
function CreateProfileDialog({ existing, onClose, onSubmit }: { existing: string[]; onClose: () => void; onSubmit: (body: NewProfile) => void }) {
  const models = useModelsQuery()
  const [name, setName] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim())
  const submit = () => onSubmit({
    name: name.trim(), clone_from: cloneFrom || undefined, clone_config: !!cloneFrom,
    default_model: model || undefined, model_provider: catalogEntryById(models.data, model)?.provider_id || undefined,
    api_key: apiKey || undefined, base_url: baseUrl || undefined,
  })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.profile_create()}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) submit() }} className="flex flex-col gap-1">
        <FieldRow label={m.profile_name_label()} htmlFor="profileName"><TextInput id="profileName" autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={m.profile_name_placeholder()} aria-invalid={name !== '' && !valid} /></FieldRow>
        <FieldRow label={m.profile_clone_from()} htmlFor="profileClone">
          <Select id="profileClone" value={cloneFrom} onValueChange={(v) => setCloneFrom(v)} className="w-full">
            <option value="">{m.profile_no_clone()}</option>
            {existing.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </FieldRow>
        <FieldRow label={m.profile_default_model_label()} htmlFor="profileModel">
          <Select id="profileModel" value={model} onValueChange={setModel} className="w-full">
            <option value="">{m.profile_no_default_model()}</option>
            {catalogModelOptgroups(models.data)}
          </Select>
        </FieldRow>
        <FieldRow label={m.profile_api_key_label()} htmlFor="profileApiKey"><TextInput id="profileApiKey" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={m.profile_api_key_placeholder()} /></FieldRow>
        <FieldRow label={m.profile_base_url_label()} htmlFor="profileBaseUrl"><TextInput id="profileBaseUrl" inputMode="url" autoComplete="off" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={m.profile_base_url_placeholder()} /></FieldRow>
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
