import { useBootstrap } from '../../app/bootstrap'
import { AgentImportDialog } from './AgentImportDialog'
import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { PROFILE_DESCRIPTION_MAX, PROFILE_DISPLAY_NAME_MAX, type GatewayMode, type Profiles } from '@maudecode/talaria-web-contracts'
import { ArrowLeftRight, ArrowUpRight, ChevronRight, Download, Pencil, Plus, Trash2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useModelsQuery, useProfilesQuery, useSwitchProfile } from '../../app/queries'
import { catalogEntryById } from '../../lib/modelEntry'
import { catalogModelOptgroups } from '../../lib/modelOptgroups'
import { HubPage } from '../../shell/AppShell'
import { Mark, StatusDot } from '../../ui/Badge'
import { BackButton, Button, IconButton } from '../../ui/Button'
import { FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog, Dialog, DialogFooter } from '../../ui/Dialog'
import { Row, RowList } from '../../ui/List'
import { Monogram } from '../../ui/Monogram'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionButtons, RowActionsMenu } from '../../ui/RowActionsMenu'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'
import { SettingLink, SettingText, SettingValue, SettingValues, SettingsGroup, SettingsStats, SETTINGS_PAGE } from '../settings/SettingsRows'

// TAL-805: `gateway_running` labels rows from a server without `gateway_mode`; delete the fallback once every supported server ships the field.
const GATEWAY_MODE_LABEL: Record<GatewayMode, () => string> = {
  own: m.profile_gateway_running, served: m.profile_gateway_served, parked: m.profile_gateway_parked, standalone: m.profile_gateway_standalone, stopped: m.profile_gateway_stopped,
}

type Profile = Profiles['profiles'][number]

/** TAL-2143: the profile's own model and provider, else that it runs on the default model. */
const modelLine = (p: Profile): string => [p.model, p.provider].filter(Boolean).join(' · ') || m.profile_uses_default_model()

const gatewayLabel = (p: Profile): string | undefined => p.gateway_mode ? GATEWAY_MODE_LABEL[p.gateway_mode]()
  : p.gateway_running === undefined ? undefined : p.gateway_running ? m.profile_gateway_running() : m.profile_gateway_stopped()

type NewProfile = Record<string, unknown> & { name: string; default_model?: string | undefined }
interface ProfileEdit { name: string; display_name?: string; description?: string }
type ProfileAction = RowAction & { icon: NonNullable<RowAction['icon']> }

/** Settings > Profiles: the list, or with `name` (TAL-2085) that profile's detail. */
export function ProfilesPage({ name }: { name?: string | undefined } = {}) {
  const profiles = useProfilesQuery()
  const navigate = useNavigate()
  const canManage = useBootstrap().auth.can_manage_server
  const switchProfile = useSwitchProfile()
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const onError = (e: unknown) => showErrorToast(e)
  const del = useResourceMutation({ resource: (name: string) => `profile:${name}`, queryKey: keys.profiles, effect: () => ({ remove: true }), mutationFn: (name) => api.deleteProfile(name), onSuccess: () => showToast(m.profile_deleted_toast()), onError })
  // A new profile shows at once by its name; the server fills in the rest on its reread.
  const create = useResourceMutation({
    resource: ({ name }: NewProfile) => `profile:new:${name}`, queryKey: keys.profiles, exclusive: true,
    effect: ({ name, default_model }) => ({ fields: { name, model: default_model } }),
    mutationFn: (body) => api.createProfile(body), onSuccess: () => showToast(m.profile_created_toast()), onError,
  })
  // TAL-2093: the new name and description show at once; a refused save restores the server's values.
  const update = useResourceMutation({
    resource: ({ name }: ProfileEdit) => `profile:${name}`, queryKey: keys.profiles,
    effect: ({ display_name, description }) => ({ fields: { ...(display_name !== undefined ? { display_name } : {}), ...(description !== undefined ? { description } : {}) } }),
    mutationFn: (body) => api.updateProfile(body), onError,
  })
  const effects = useResourceEffects()
  const list = withCreated(withEffects(profiles.data?.profiles ?? [], (p) => `profile:${p.name}`, effects), 'profile', effects)
  const active = profiles.data?.active
  const summary = profiles.data?.summary
  // TAL-213: opening a Bot Chat always reasserts its profile (another tab may have moved the shared cookie).
  const openBotChat = (name: string) => switchProfile.mutate({ name, botChat: true })
  // TAL-2143: a click anywhere on a profile's block opens its detail; its name stays the link keyboards and the browser's link menu use.
  const openDetail = (profile: string) => { void navigate({ to: '/settings/$section', params: { section: 'profiles' }, search: { name: profile } }) }
  const toList = () => { void navigate({ to: '/settings/$section', params: { section: 'profiles' }, search: {} }) }
  // A profile the server has not created yet has no detail to open and nothing to use or delete.
  const confirmed = (p: Profile) => !!profiles.data?.profiles.some((row) => row.name === p.name)
  const actionsFor = (p: Profile): ProfileAction[] => {
    if (!confirmed(p)) return []
    const isActive = p.name === active
    return [
      ...(p.canonical_session ? [{ label: m.profile_open_bot_chat(), run: () => openBotChat(p.name), disabled: switchProfile.isPending, icon: ArrowUpRight }] : []),
      ...(!isActive ? [{ label: m.profile_use(), run: () => switchProfile.mutate({ name: p.name }), icon: ArrowLeftRight }] : []),
      ...(canManage && !profiles.data?.single_profile_mode ? [{ label: m.profile_edit(), run: () => setEditing(p.name), icon: Pencil }] : []),
      ...(!p.is_default && !isActive ? [{ label: m.profile_delete_title(), icon: Trash2, run: () => setDeleting(p.name), danger: true }] : []),
    ]
  }
  // A delete from the detail returns to the list at once; a refused delete brings the row back there.
  const confirmDelete = <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }} title={m.profile_delete_confirm_title({ name: deleting ?? '' })} description={m.profile_delete_confirm_body()} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => { if (!deleting) return; if (name !== undefined) toList(); del.mutate(deleting) }} />
  const editingProfile = editing === null ? undefined : list.find((p) => p.name === editing)
  const editDialog = editingProfile && <EditProfileDialog profile={editingProfile} onClose={() => setEditing(null)} onSubmit={(body) => { setEditing(null); update.mutate(body) }} />
  if (name !== undefined) {
    const profile = list.find((p) => p.name === name)
    return (
      <HubPage title={profile?.display_name || name} actions={<BackButton iconOnly onClick={toList} />}>
        {profiles.isPending && <LoadingState />}
        {profiles.isError && <ErrorState error={profiles.error} onRetry={() => { void profiles.refetch() }} />}
        {profiles.isSuccess && (profile
          ? <ProfileDetail profile={profile} isActive={profile.name === active} actions={actionsFor(profile)} />
          : (
            <ErrorState>
              <div className="font-medium text-text">{m.profile_detail_not_found({ name })}</div>
              <div><BackButton iconOnly label={m.profile_detail_back_to_list()} onClick={toList} /></div>
            </ErrorState>
          ))}
        {confirmDelete}
        {editDialog}
      </HubPage>
    )
  }
  return (
    <HubPage title={m.tab_profiles()} help={<ProfileConceptHelp />} actions={<>
      {canManage && <IconButton variant="ghost" tooltipSide="bottom" label={m.profile_import()} onClick={() => setImporting(true)}><Download aria-hidden="true" /></IconButton>}
      {!profiles.data?.single_profile_mode && <IconButton variant="primary" tooltipSide="bottom" label={m.profile_create()} onClick={() => setCreating(true)}><Plus aria-hidden="true" /></IconButton>}
    </>}>
      {importing && <AgentImportDialog key={active} onClose={() => setImporting(false)} />}
      {profiles.isPending && <LoadingState />}
      {profiles.isError && <ErrorState error={profiles.error} onRetry={() => { void profiles.refetch() }} />}
      {profiles.isSuccess && list.length === 0 && <EmptyState compact>{m.profile_no_configuration()}</EmptyState>}
      {summary && <SettingsStats label={m.tab_profiles()} stats={[
        { id: 'profiles', label: m.tab_profiles(), value: String(summary.total) },
        { id: 'active', label: m.profile_stat_active_here(), value: summary.active_name, title: summary.active_name },
        { id: 'gateways', label: m.profile_stat_gateways_running(), value: String(summary.gateways_running), mode: m.profile_stat_gateways_of({ total: summary.total }) },
      ]} />}
      {/* `@container`: the gateway state shows once the list, not the window, is 601px wide (the Settings list may sit beside it). */}
      <RowList id="profilesPanel" className="@container">
        {list.map((p) => {
          const actions = actionsFor(p)
          const gateway = gatewayLabel(p)
          const use = actions.find((a) => a.label === m.profile_use())
          return (
            <RowContextMenu key={p.name} label={m.profile_row_menu()} actions={actions} trigger={<Row className={cn('group', confirmed(p) && 'cursor-pointer')} data-profile={p.name} onClick={(e) => { if (confirmed(p) && !(e.target as Element).closest('a, button, [role="menu"], [role="dialog"], [role="alertdialog"]')) openDetail(p.name) }}>
              <div className="flex items-center gap-3">
                <Monogram name={p.display_name || p.name} />
                <div className="min-w-0 flex-1">
                  <ProfileHeading profile={p} isActive={p.name === active} link={confirmed(p)} className="text-sm" />
                  <div className="mt-0.5 truncate text-xs text-muted">{modelLine(p)}</div>
                </div>
                {gateway && p.gateway_state && <span className="hidden min-w-0 @min-[601px]:flex"><StatusDot state={p.gateway_state}>{gateway}</StatusDot></span>}
                {use && <RowActionButtons actions={[use]} />}
                {/* The menu's trigger shows on hover and focus where a pointer hovers; right-click and long-press open the same menu. */}
                {actions.length > 0 && <span className="flex [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-data-popup-open:opacity-100"><RowActionsMenu label={m.profile_row_menu()} actions={actions} /></span>}
                <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
              </div>
            </Row>} />
          )
        })}
      </RowList>
      {creating && <CreateProfileDialog existing={list.map((p) => p.name)} onClose={() => setCreating(false)} onSubmit={(body) => { setCreating(false); create.mutate(body) }} />}
      {confirmDelete}
      {editDialog}
    </HubPage>
  )
}

/** A profile's name line: the display name, else the name, then the name muted where it differs, and its Default and Active marks. `link` opens its detail. */
function ProfileHeading({ profile: p, isActive, link, className }: { profile: Profile; isActive: boolean; link: boolean; className: string }) {
  const shown = p.display_name || p.name
  const names = <>
    <span className="truncate">{shown}</span>
    {shown !== p.name && <span className="truncate text-xs font-normal text-muted">{p.name}</span>}
  </>
  return (
    <div className={cn('flex min-w-0 items-baseline gap-2 font-semibold text-text', className)}>
      {link
        ? <Link to="/settings/$section" params={{ section: 'profiles' }} search={{ name: p.name }} className="flex min-w-0 items-baseline gap-2 hover:underline">{names}</Link>
        : names}
      {p.is_default && <Mark>{m.profile_default_badge()}</Mark>}
      {isActive && <Mark>{m.profile_active()}</Mark>}
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
    <div className={SETTINGS_PAGE} data-profile-detail={p.name}>
      <RowContextMenu label={m.profile_row_menu()} actions={actions} trigger={<div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <ProfileHeading profile={p} isActive={isActive} link={false} className="text-base" />
          {p.description && <p className="mt-1 text-sm text-muted">{p.description}</p>}
        </div>
        {actions.length > 0 && <div className="sm:ml-auto"><RowActionButtons actions={actions} /></div>}
      </div>} />
      {/* TAL-2093: the root profile's assistant is named by the server-wide `bot_name` setting; a named profile goes by its own name. */}
      {p.is_default && (
        <SettingsGroup id="profile-identity" title={m.profile_detail_identity()}>
          <SettingText label={m.profile_detail_assistant_name()} id="settingsBotName" settingKey="bot_name" fallback="Hermes" maxLength={64} parse={(draft) => draft.trim() || 'Hermes'} />
        </SettingsGroup>
      )}
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
          {/* Reviews resolve against the active profile, and the count sums skill and memory writes, so both pages are offered there only. */}
          {isActive && pending !== undefined && pending > 0 && <>
            <SettingLink label={m.profile_detail_review_skills()} onClick={() => { void navigate({ to: '/skills' }) }} />
            <SettingLink label={m.profile_detail_review_memory()} onClick={() => { void navigate({ to: '/memory' }) }} />
          </>}
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

/** TAL-2093: closes on Save; the header shows the new values while the server writes them. Bot Mode's roster title, when set, is the shown name, so the name field is locked. */
function EditProfileDialog({ profile, onClose, onSubmit }: { profile: Profile; onClose: () => void; onSubmit: (body: ProfileEdit) => void }) {
  const overridden = !!profile.display_name_overridden
  const [displayName, setDisplayName] = useState(profile.display_name ?? '')
  const [description, setDescription] = useState(profile.description ?? '')
  const submit = () => onSubmit({ name: profile.name, ...(overridden ? {} : { display_name: displayName.trim() }), description: description.trim() })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.profile_edit_title({ name: profile.name })}>
      <form onSubmit={(e) => { e.preventDefault(); submit() }} className="flex flex-col gap-1">
        <FieldRow label={m.profile_edit_display_name()} hint={overridden ? m.profile_edit_display_name_overridden() : undefined} htmlFor="profileDisplayName">
          <TextInput id="profileDisplayName" autoFocus={!overridden} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={profile.name} maxLength={PROFILE_DISPLAY_NAME_MAX} disabled={overridden} />
        </FieldRow>
        <FieldRow label={m.profile_edit_description()} htmlFor="profileDescription">
          <TextInput id="profileDescription" autoFocus={overridden} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={PROFILE_DESCRIPTION_MAX} />
        </FieldRow>
        <DialogFooter className="mt-3"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary">{m.save()}</Button></DialogFooter>
      </form>
    </Dialog>
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
        <DialogFooter className="mt-3"><Button onClick={onClose}>{m.cancel()}</Button><Button type="submit" variant="primary" disabled={!valid}>{m.create()}</Button></DialogFooter>

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
