import { useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { WebUpdateChannel } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { useSaveSettings } from '../../app/queries'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Switch, FieldRow, TextInput, HelpTip } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { useSettingField } from './useSettingField'
import { useLogout } from '../auth/useLogout'
import { decodeCreationOptions, encodeAttestation, passkeysSupported } from '../auth/passkeys'
import { loadBootstrap } from '../../app/bootstrap'
import type { z } from 'zod'
import type { UpdateApplySchema, UpdateTargetSchema, UpdateVersionSchema } from '../../contracts'
import { useUpdateProgress } from '../notifications/UpdateNotificationCenter'
import { McpSection } from './McpSection'
import { WhatsNewReplay } from '../whats-new/WhatsNew'
import { useResourceEffects, useResourceMutation, withEffects } from '../sessions/useResourceMutation'
import { markServerStopped } from '../notices/useRuntimeNotices'

const CHANNEL_LABELS: Record<WebUpdateChannel, () => string> = { stable: m.settings_update_channel_stable, nightly: m.settings_update_channel_nightly, experimental: m.settings_update_channel_experimental }

export function SystemSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const { settings, save, str, bool, set } = useSettingField(['update_channel', 'update_channels', 'agent_update_channel', 'password_env_var', 'ignore_agent_updates', 'webui_version', 'check_for_updates', 'auto_apply_updates', 'agent_version', 'summarize_updates_automatically', 'password_auth_enabled', 'auth_enabled', 'auth_disabled_acknowledged'])
  const health = useQuery({ queryKey: keys.health.system, queryFn: api.fetchSystemHealth, staleTime: 30_000 })
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, staleTime: 15_000 })
  const updates = useQuery({ queryKey: keys.updates.check, queryFn: () => api.fetchUpdatesCheck(), staleTime: 30_000, refetchInterval: 30_000 })
  const passkeys = useQuery({ queryKey: ['auth', 'passkeys'], queryFn: api.passkeysList, staleTime: 30_000, enabled: bootstrap.auth.passkey_feature_flag })
  const logout = useLogout()
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const fail = (e: unknown) => showErrorToast(e)
  // A refused restart (TAL-1627) rereads the capability, so the control disappears with the error.
  const restart = useMutation({ mutationFn: api.restartAgent, onSuccess: () => { showToast(m.saved()) }, onError: fail, onSettled: () => { void qc.invalidateQueries({ queryKey: keys.health.agent }) } })
  const shutdown = useMutation({ mutationFn: api.shutdownServer, onSuccess: () => markServerStopped(qc), onError: fail })
  // The chosen channel is held locally until its save settles; the cache only catches up on success,
  // and a later save (e.g. ignore-agent) must not make the Select snap back meanwhile.
  const [channelDraft, setChannelDraft] = useState<string>()
  const channel = channelDraft ?? str('update_channel', 'stable')
  const webChannels = (settings.data as { update_channels?: WebUpdateChannel[] } | undefined)?.update_channels ?? []
  const setChannel = (v: string) => { setChannelDraft(v); save.mutate({ update_channel: v }, { onError: fail, onSettled: () => { setChannelDraft(undefined); void qc.invalidateQueries({ queryKey: keys.updates.check }) } }) }
  const [agentChannelDraft, setAgentChannelDraft] = useState<string>()
  const agentChannel = agentChannelDraft ?? str('agent_update_channel', 'stable')
  const setAgentChannel = (v: string) => { setAgentChannelDraft(v); save.mutate({ agent_update_channel: v }, { onError: fail, onSettled: () => { setAgentChannelDraft(undefined); void qc.invalidateQueries({ queryKey: keys.updates.check }) } }) }
  const [agentConfirmation, setAgentConfirmation] = useState<{ result: z.infer<typeof UpdateApplySchema>; request: ApplyRequest } | null>(null)
  const acceptedAgentConfirmation = useRef(false)
  // The server reads persisted settings (channel, ignore-agent) for the forced check, so let every
  // in-flight settings save settle first; the cache then holds whatever actually persisted.
  const settledChannel = () => { const v = qc.getQueryData<Record<string, unknown>>(keys.settings)?.update_channel; return typeof v === 'string' ? v : undefined }
  const settledAgentChannel = (): 'stable' | 'experimental' => qc.getQueryData<Record<string, unknown>>(keys.settings)?.agent_update_channel === 'experimental' ? 'experimental' : 'stable'
  const waitForSettings = async () => { while (qc.isMutating({ mutationKey: keys.settings })) await new Promise((r) => setTimeout(r, 50)) }
  const checkNow = useMutation({
    mutationFn: async () => {
      await waitForSettings()
      return api.checkUpdatesNow(settledChannel(), settledAgentChannel())
    },
    onSuccess: (d) => qc.setQueryData(keys.updates.check, d),
    onError: fail,
  })
  // The Updating dialog reports each apply; one mutation per target keeps the other target's action available.
  const progress = useUpdateProgress()
  // `version` names a listed Stable release (TAL-946); without it the server installs the newest.
  const applyTarget = (target: 'webui' | 'agent') => ({
    mutationFn: async (request: ApplyRequest) => {
      await waitForSettings()
      const version = request.version ? { version: request.version } : {}
      return target === 'webui' ? api.applyUpdates('apply', settledChannel() ?? channel, 'webui', version)
        : api.applyUpdates('apply', undefined, 'agent', { agent_channel: request.agentChannel ?? settledAgentChannel(), ...(request.confirmedRevision ? { confirmed_agent_revision: request.confirmedRevision } : {}), ...(request.refreshToken ? { agent_refresh_token: request.refreshToken } : {}), ...version })
    },
    onMutate: () => { progress?.begin(target) },
    onSuccess: (r: z.infer<typeof UpdateApplySchema>, request: ApplyRequest) => {
      if (r.confirmation_required && r.candidate_revision && r.agent_channel) {
        progress?.dismiss()
        acceptedAgentConfirmation.current = false
        setAgentConfirmation({ result: r, request: { ...request, agentChannel: r.agent_channel } })
      } else progress?.settle(target, r)
      void qc.invalidateQueries({ queryKey: keys.updates.check })
      void qc.invalidateQueries({ queryKey: keys.updateNotifications })
    },
    onError: (error: unknown) => { progress?.settle(target, { failure: error }); void qc.invalidateQueries({ queryKey: keys.updateNotifications }) },
  })
  const applyWeb = useMutation(applyTarget('webui'))
  const applyAgent = useMutation(applyTarget('agent'))
  /** One version's Install button; the one being applied reads Updating. */
  const install = (apply: typeof applyWeb) => (v: UpdateVersion) => (
    <Button onClick={() => apply.mutate({ version: v.ref })} disabled={apply.isPending} aria-label={m.system_install_version({ version: v.version })}>{apply.isPending && apply.variables.version === v.ref ? m.update_updating() : m.system_install()}</Button>
  )
  const registerPasskey = useMutation({
    mutationFn: async () => {
      const opt = await api.passkeyRegisterOptions()
      const cred = await navigator.credentials.create({ publicKey: decodeCreationOptions(opt.publicKey as unknown as Parameters<typeof decodeCreationOptions>[0]) })
      if (!cred) throw new Error('Passkey cancelled')
      return api.passkeyRegister(encodeAttestation(cred as PublicKeyCredential))
    },
    onSuccess: () => { showToast(m.system_passkey_registered()); void qc.invalidateQueries({ queryKey: ['auth', 'passkeys'] }); void loadBootstrap() },
    onError: fail,
  })
  const effects = useResourceEffects()
  const deletePasskey = useResourceMutation({ resource: (id: string) => `passkey:${id}`, effect: () => ({ remove: true }), queryKey: ['auth', 'passkeys'], mutationFn: (id) => api.passkeyDelete(id), onError: fail })
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  const canManage = bootstrap.auth.can_manage_server
  const passwordLocked = bool('password_env_var')
  const webUpdate = updates.data?.webui
  const agentUpdate = updates.data?.agent
  // One failed poll is a transport blip, not a failed check: keep rendering the last server payload
  // while it still answers the selected channels.
  const cachedCurrent = updates.data !== undefined && (updates.data.channel ?? channel) === channel && (updates.data.agent_channel ?? agentChannel) === agentChannel
  const webStatus = pathStatus(webUpdate, WEB, { failed: updates.isError && !cachedCurrent, pending: updates.isPending })
  const agentStatus = pathStatus(agentUpdate, AGENT, { failed: updates.isError && !cachedCurrent, pending: updates.isPending })
  const heading = 'text-[15px] font-semibold text-text'
  return (
    <div className="flex flex-col gap-9" data-section="system">
      <section aria-labelledby="systemUpdatesHeading" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="systemUpdatesHeading" className={heading}>{m.system_updates()}<HelpTip label={m.field_help_about({ label: m.system_updates() })}>{m.system_updates_intro()}</HelpTip></h2>
          <Button onClick={() => checkNow.mutate()} disabled={checkNow.isPending}>{checkNow.isPending ? m.settings_checking() : bool('ignore_agent_updates') ? m.system_check_web() : m.system_check_both()}</Button>
        </div>
        <div className="grid gap-x-10 gap-y-8 [grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr))]">
          <UpdatePath id="systemWebPath" title={WEB} installed={webUpdate?.current_version ?? str('webui_version', bootstrap.webui_version)} installedAction={<WhatsNewReplay />} status={webStatus}
            channel={<Select id="settingsUpdateChannel" aria-label={m.settings_label_web_update_channel()} disabled={!canManage} value={channel} onValueChange={setChannel}>
              {webChannels.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]()}</option>)}
            </Select>}
            action={canManage && webUpdate?.can_apply ? <Button variant="primary" onClick={() => applyWeb.mutate({})} disabled={applyWeb.isPending}>{applyWeb.isPending && !applyWeb.variables.version ? m.update_updating() : webUpdate.state === 'finish' ? m.system_finish_update() : m.system_apply_web_update()}</Button> : null}
            folded={canManage ? webUpdate?.versions.filter((v) => v.folded) : undefined} install={install(applyWeb)}
            manualLink={webUpdate?.manual_link === true}
            summary={webUpdate?.summary_available ? <UpdateSummary target="webui" name={WEB} info={webUpdate} /> : null}>
            <FieldRow label={m.settings_label_auto_apply_updates()} hint={m.system_auto_apply_hint()} htmlFor="settingsAutoApplyUpdates" inline><Switch id="settingsAutoApplyUpdates" disabled={!canManage || !bool('check_for_updates', true)} checked={bool('auto_apply_updates')} onCheckedChange={(checked) => set({ auto_apply_updates: checked })} /></FieldRow>
          </UpdatePath>
          <UpdatePath id="systemAgentPath" title={AGENT} installed={agentUpdate?.current_version ?? str('agent_version', '—')} status={agentStatus}
            channel={<Select id="settingsAgentUpdateChannel" aria-label={m.settings_label_agent_update_channel()} disabled={!canManage} value={agentChannel} onValueChange={setAgentChannel}>
              <option value="stable">{m.settings_update_channel_stable()}</option>
              <option value="experimental">{m.settings_update_channel_experimental()}</option>
            </Select>}
            action={canManage && agentUpdate?.can_apply ? <Button variant="primary" onClick={() => applyAgent.mutate({})} disabled={applyAgent.isPending}>{applyAgent.isPending && !applyAgent.variables.version ? m.update_updating() : m.system_apply_agent_update()}</Button> : null}
            folded={canManage ? agentUpdate?.versions.filter((v) => v.folded) : undefined} install={install(applyAgent)}
            /* Before TAL-946 the server sent no `support_label`; `unsupported` answers only for one that predates `support` (TAL-350). */
            support={agentUpdate?.can_apply ? agentSupport(agentUpdate) : null}
            installedNote={agentUpdate?.current_support === 'unchecked' ? m.system_agent_installed_unchecked() : null}
            summary={agentUpdate?.summary_available ? <UpdateSummary target="agent" name={AGENT} info={agentUpdate} /> : null}>
            <FieldRow label={m.settings_label_ignore_agent_updates()} hint={m.system_agent_manual_hint()} htmlFor="settingsIgnoreAgentUpdates" inline><Switch id="settingsIgnoreAgentUpdates" checked={bool('ignore_agent_updates')} onCheckedChange={(checked) => save.mutate({ ignore_agent_updates: checked }, { onError: fail, onSettled: () => { void qc.invalidateQueries({ queryKey: keys.updates.check }) } })} /></FieldRow>
          </UpdatePath>
        </div>
        <div className="border-t border-border-subtle pt-1">
          <FieldRow label={m.settings_label_summarize_updates_automatically()} htmlFor="settingsSummarizeUpdatesAutomatically" inline><Switch id="settingsSummarizeUpdatesAutomatically" disabled={!canManage || !bool('check_for_updates', true)} checked={bool('summarize_updates_automatically', true)} onCheckedChange={(checked) => set({ summarize_updates_automatically: checked })} /></FieldRow>
          <FieldRow label={m.settings_label_check_updates()} hint={m.system_check_updates_hint()} htmlFor="settingsCheckUpdates" inline><Switch id="settingsCheckUpdates" disabled={!canManage} checked={bool('check_for_updates', true)} onCheckedChange={(checked) => set({ check_for_updates: checked })} /></FieldRow>
        </div>
      </section>
      <section aria-labelledby="systemHealthHeading">
        <h2 id="systemHealthHeading" className={heading}>{m.system_health()}</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">{WEB}</dt>
          <dd className="text-text">{health.data?.status ?? '—'}{health.data?.disk?.percent !== undefined ? <span className="text-muted">{', '}{m.system_disk_used({ n: health.data.disk.percent.toFixed(0) })}</span> : null}</dd>
          <dd className="text-xs text-muted">{health.data?.checked_at ? formatDate(health.data.checked_at) : null}</dd>
          <dt className="text-muted">{AGENT}</dt>
          <dd className="text-text">{agent.data?.alive === true ? 'ok' : agent.data?.alive === false ? (agent.data.details?.reason ?? 'down') : agent.data?.details?.state ?? '—'}</dd>
          <dd>{canManage && <GatewayRestart lifecycle={agent.data?.gateway_lifecycle} pending={restart.isPending} onRestart={() => restart.mutate()} />}</dd>
        </dl>
      </section>
      <McpSection heading={heading} />
      {(canManage || bootstrap.auth.passkey_feature_flag || bootstrap.auth.auth_enabled) && <section aria-labelledby="systemAccessHeading" className="flex flex-col gap-4">
        <h2 id="systemAccessHeading" className={heading}>{m.system_access()}</h2>
      {canManage && (
        <div>
          <h3 className="mb-1.5 text-sm font-medium text-text">{m.settings_label_password()}</h3>
          {passwordLocked ? (
            <p className="text-xs text-muted">{m.password_env_var_locked()}</p>
          ) : (
            <PasswordForm passwordAuthEnabled={bool('password_auth_enabled')} />
          )}
          {!bool('auth_enabled') && (
            <FieldRow label={m.auth_acknowledged_label()} htmlFor="settingsAuthAck" inline><Switch id="settingsAuthAck" checked={bool('auth_disabled_acknowledged')} onCheckedChange={(checked) => set({ auth_disabled_acknowledged: checked })} /></FieldRow>
          )}
        </div>
      )}
      {bootstrap.auth.passkey_feature_flag && (
        <div>
          <h3 className="mb-1.5 text-sm font-medium text-text">{m.system_passkeys()}</h3>
          <ul className="text-sm">
            {withEffects(passkeys.data?.credentials ?? [], (k) => `passkey:${k.id}`, effects).map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 py-1"><span>{k.label || k.id}</span><Button variant="ghost" className="text-error" onClick={() => deletePasskey.mutate(k.id)}>{m.delete()}</Button></li>
            ))}
          </ul>
          {passkeysSupported() && <Button onClick={() => registerPasskey.mutate()} disabled={registerPasskey.isPending}>{m.system_passkey_register()}</Button>}
        </div>
      )}
        {bootstrap.auth.auth_enabled && <div><Button onClick={() => { void logout() }}>{m.system_logout()}</Button></div>}
      </section>}
      {canManage && (
        <section aria-labelledby="systemStopHeading" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-error/40 px-4 py-3">
          <h2 id="systemStopHeading" className="text-sm font-semibold text-error">{m.system_shutdown()}<HelpTip label={m.field_help_about({ label: m.system_shutdown() })}>{m.system_shutdown_hint()}</HelpTip></h2>
          <Button variant="ghost" className="text-error" onClick={() => setConfirmShutdown(true)}>{m.system_shutdown()}</Button>
        </section>
      )}
      <ConfirmDialog open={confirmShutdown} onOpenChange={setConfirmShutdown} title={m.system_shutdown()} description={m.system_shutdown_confirm()} confirmLabel={m.system_shutdown()} cancelLabel={m.cancel()} danger onConfirm={() => shutdown.mutate()} />
      <ConfirmDialog open={agentConfirmation !== null} onOpenChange={(open) => { if (!open && agentConfirmation) { const pending = agentConfirmation; setAgentConfirmation(null); if (acceptedAgentConfirmation.current) { acceptedAgentConfirmation.current = false; return } if (pending.result.notification_id) void api.cancelUpdateNotification(pending.result.notification_id).catch(fail).finally(() => qc.invalidateQueries({ queryKey: keys.updateNotifications })) } }} title={agentConfirmation?.result.refresh_confirmation ? m.system_agent_refresh_title() : m.system_agent_unsupported_title()} description={agentConfirmation ? agentConfirmation.result.refresh_confirmation ? m.system_agent_refresh_warning({ services: agentConfirmation.result.refresh_confirmation.services.join(', '), revision: agentConfirmation.result.candidate_revision?.slice(0, 12) ?? '' }) : `${m.system_agent_unsupported_warning()} ${m.system_agent_unsupported_identity({ version: agentConfirmation.result.supported_version ?? '—', supported: (agentConfirmation.result.supported_revision ?? '—').slice(0, 12), candidate: (agentConfirmation.result.candidate_revision ?? '').slice(0, 12) })}` : ''} confirmLabel={agentConfirmation?.result.refresh_confirmation ? m.system_agent_refresh_confirm() : m.system_agent_update_anyway()} cancelLabel={m.cancel()} danger onConfirm={() => { if (agentConfirmation) { const pending = agentConfirmation; acceptedAgentConfirmation.current = true; setAgentConfirmation(null); applyAgent.mutate({ ...pending.request, ...(pending.result.refresh_confirmation ? { refreshToken: pending.result.refresh_confirmation.token } : pending.result.candidate_revision ? { confirmedRevision: pending.result.candidate_revision } : {}) }) } }} />
    </div>
  )
}

type GatewayLifecycle = NonNullable<Awaited<ReturnType<typeof api.fetchAgentHealth>>['gateway_lifecycle']>

/** TAL-1627: restart only when the server says Web controls the monitored Gateway; otherwise its reason, read-only. An older server sends no capability, so nothing is offered. */
function GatewayRestart({ lifecycle, pending, onRestart }: { lifecycle: GatewayLifecycle | undefined; pending: boolean; onRestart: () => void }) {
  if (lifecycle?.managed === true) return <Button onClick={onRestart} disabled={pending}>{m.system_restart_agent()}</Button>
  if (!lifecycle) return null
  return (
    <HelpTip label={m.system_gateway_restart_unavailable()}>
      {lifecycle.reason === 'external_gateway' ? m.system_gateway_external()
        : lifecycle.start_command ? <>{m.system_gateway_start_once()}<code className="mt-1 block break-words font-mono">{lifecycle.start_command}</code></>
          : m.system_gateway_unconfirmed()}
    </HelpTip>
  )
}

// Credential drafts stay inside the form, as in the provider setup forms.
function PasswordForm({ passwordAuthEnabled }: { passwordAuthEnabled: boolean }) {
  const [pw, setPw] = useState('')
  const [currentPw, setCurrentPw] = useState('')
  const qc = useQueryClient()
  const saveSettings = useSaveSettings()
  const setPassword = useMutation({ mutationFn: (body: Record<string, unknown>) => saveSettings.mutateAsync(body), onSuccess: async () => { showToast(m.system_password_updated()); setPw(''); setCurrentPw(''); await loadBootstrap(); void qc.invalidateQueries() }, onError: (e) => showErrorToast(e) })
  return (
    <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (pw.trim()) setPassword.mutate({ _set_password: pw.trim(), ...(currentPw ? { _current_password: currentPw } : {}) }) }} className="flex flex-col gap-2">
      {passwordAuthEnabled && <TextInput type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder={m.current_password_placeholder()} aria-label={m.current_password_placeholder()} />}
      <TextInput type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={m.password_placeholder()} aria-label={m.settings_label_password()} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!pw.trim() || setPassword.isPending}>{m.system_password_set()}</Button>
        {passwordAuthEnabled && <Button variant="ghost" className="text-error" onClick={() => setPassword.mutate({ _clear_password: true, ...(currentPw ? { _current_password: currentPw } : {}) })}>{m.system_password_clear()}</Button>}
      </div>
    </form>
  )
}

const WEB = 'Talaria Web'
const AGENT = 'Hermes Agent'
type Target = z.infer<typeof UpdateTargetSchema>
type UpdateVersion = z.infer<typeof UpdateVersionSchema>
interface ApplyRequest { refreshToken?: string; version?: string; confirmedRevision?: string; agentChannel?: 'stable' | 'experimental' }
type Tone = 'update' | 'ok' | 'warn' | 'quiet'
interface Support { label: string; unchecked: boolean }

/** The newest Agent target's one-line support status. */
function agentSupport(t: Target): Support | null {
  const unchecked = (t.support ?? (t.unsupported === true ? 'unchecked' : 'supported')) === 'unchecked'
  const label = t.support_label ?? (unchecked ? m.system_agent_unsupported_warning() : null)
  return label ? { label, unchecked } : null
}
const versionSupport = (v: UpdateVersion): Support | null => (v.support_label ? { label: v.support_label, unchecked: v.support === 'unchecked' } : null)
interface PathStatus { tone: Tone; text: string; target?: string | undefined; detail?: string | undefined }

/** One component's update state in the words its channel uses: Stable names releases, Experimental counts commits. */
function pathStatus(t: Target | null | undefined, name: string, { failed, pending }: { failed: boolean; pending: boolean }): PathStatus {
  if (pending && !t) return { tone: 'quiet', text: m.system_checking_named({ name }) }
  if (failed) return { tone: 'warn', text: m.system_check_failed_named({ name }), detail: t?.error }
  if (!t) return { tone: 'quiet', text: m.system_status_unknown_named({ name }) }
  const target = t.target_version ?? undefined
  const detail = typeof t.message === 'string' ? t.message : undefined
  switch (t.state) {
    case 'off': return { tone: 'quiet', text: m.system_checks_off({ name }) }
    case 'check_failed': return { tone: 'warn', text: m.system_check_failed_named({ name }), detail: t.error }
    case 'local_changes': return { tone: 'warn', text: m.system_local_changes_named({ name }), detail }
    case 'finish': return { tone: 'update', text: m.system_finish_named({ name }), target, detail }
    case 'manual': return { tone: 'warn', text: m.system_manual_named({ name }), target, detail }
    case 'release_ready': return { tone: 'update', text: m.system_release_ready({ name }), target, detail: t.installed_unverified ? m.system_installed_unverified() : undefined }
    case 'commits_behind': return { tone: 'update', text: m.system_commits_behind({ name, n: t.behind ?? 0 }) }
    case 'up_to_date': return { tone: 'ok', text: m.system_up_to_date_named({ name }) }
    case 'unknown': return { tone: 'quiet', text: m.system_status_unknown_named({ name }) }
  }
}

/** "Summarize with AI" and its dialog: the server's summary of this target's pending update, requested only once the dialog opens. */
function UpdateSummary({ target, name, info }: { target: 'webui' | 'agent'; name: string; info: Target }) {
  const [open, setOpen] = useState(false)
  const summary = useQuery({ queryKey: [...keys.updates.summary, target, info.current_sha, info.latest_sha, info.target_version, info.behind], queryFn: () => api.fetchUpdatesSummary(target), enabled: open, staleTime: Infinity, retry: false })
  return (
    <>
      <Button onClick={() => setOpen(true)}>{m.system_summarize_with_ai()}</Button>
      <Dialog open={open} onOpenChange={setOpen} title={m.system_summary_title({ name })} description={summary.data?.current_version && summary.data.target_version ? `${summary.data.current_version} → ${summary.data.target_version}` : undefined} className="w-[min(92vw,600px)]">
        <div className="max-h-[60vh] overflow-y-auto text-sm">
          {summary.isPending ? <p role="status" className="text-muted">{m.system_whats_new_loading()}</p>
            : summary.isError ? (
              <div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-muted">{m.system_whats_new_failed()}</p><Button onClick={() => { void summary.refetch() }}>{m.retry()}</Button></div>
            ) : (
              <div className="flex flex-col gap-4">
                {summary.data.summary_sections.map((section) => (
                  <section key={section.title}>
                    <h3 className="font-medium text-text">{section.title}</h3>
                    <ul className="mt-1 list-disc pl-5 text-muted">{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
                  </section>
                ))}
              </div>
            )}
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={() => setOpen(false)}>{m.close()}</Button></div>
      </Dialog>
    </>
  )
}

const NODE: Record<Tone | 'installed', string> = {
  installed: 'border-text bg-text',
  update: 'border-accent bg-accent',
  ok: 'border-success bg-success',
  warn: 'border-warning bg-transparent',
  quiet: 'border-border2 bg-transparent',
}

function PathNode({ tone, children }: { tone: Tone | 'installed'; children: ReactNode }) {
  return (
    <li className="relative pb-4 last:pb-0">
      <span aria-hidden="true" className={cn('absolute top-[5px] -left-[22px] size-[11px] rounded-full border-2', NODE[tone])} />
      {children}
    </li>
  )
}

function SupportLine({ support }: { support: Support | null }) {
  return support ? <p className={cn('mt-0.5 text-xs', support.unchecked ? 'text-warning' : 'text-muted')}>{support.label}</p> : null
}

/**
 * A component's update path: installed version, then where its channel leads, with its own controls underneath.
 * Older installable releases (TAL-946) fold into one node between them; opening it is this device's choice.
 */
function UpdatePath({ id, title, installed, installedNote, installedAction, status, channel, action, folded = [], install, support, manualLink, summary, children }: {
  id: string; title: string; installed: string; installedNote?: string | null; installedAction?: ReactNode; status: PathStatus; channel: ReactNode; action: ReactNode
  folded?: UpdateVersion[] | undefined; install: (version: UpdateVersion) => ReactNode; support?: Support | null; manualLink?: unknown; summary?: ReactNode; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const next = status.tone !== 'ok'
  return (
    <section aria-labelledby={`${id}Heading`} data-update-path={id} className="row-span-3 grid min-w-0 grid-rows-subgrid gap-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}Heading`} className="text-sm font-semibold text-text">{title}</h3>
        {channel}
      </div>
      <ol className={cn('ml-[5px] self-start border-l pl-4', next && status.tone === 'update' ? 'border-accent' : 'border-border')}>
        <PathNode tone={next ? 'installed' : 'ok'}>
          <div className="text-[11px] text-muted">{m.system_path_installed()}</div>
          <div className="font-mono text-sm text-text break-all">{installed}</div>
          {installedNote ? <p className="mt-1 text-xs text-warning">{installedNote}</p> : null}
          {installedAction}
          {!next ? <p role="status" className="mt-1 text-xs text-muted">{status.text}</p> : null}
        </PathNode>
        {next && folded.length ? (
          <PathNode tone="quiet">
            <Button variant="ghost" className="-my-3 -ml-3 min-h-11" aria-expanded={open} onClick={() => setOpen(!open)}>
              {m.system_more_versions({ n: folded.length })}{open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            </Button>
          </PathNode>
        ) : null}
        {/* Oldest first, so the path reads down toward the newest release. */}
        {next && open ? [...folded].reverse().map((v) => (
          <PathNode key={v.ref} tone="quiet">
            <div className="font-mono text-sm text-text break-all">{v.version}</div>
            <SupportLine support={versionSupport(v)} />
            <div className="mt-2">{install(v)}</div>
          </PathNode>
        )) : null}
        {next ? (
          <PathNode tone={status.tone}>
            {status.target ? <div className="font-mono text-sm text-text break-all">{status.target}</div> : null}
            <p role="status" className={cn('text-xs', status.tone === 'update' ? 'text-accent-text' : status.tone === 'warn' ? 'text-warning' : 'text-muted')}>{status.text}</p>
            {status.detail ? <p className="mt-0.5 text-xs text-muted">{status.detail}</p> : null}
            {manualLink ? <a className="inline-flex min-h-11 items-center text-xs text-accent-text underline" href="https://github.com/MaudeCode/talaria/releases" target="_blank" rel="noreferrer">{m.system_manual_updates()}</a> : null}
            <SupportLine support={support ?? null} />
            {action || summary ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}{summary}</div> : null}
          </PathNode>
        ) : null}
      </ol>
      <div className="self-end border-t border-border-subtle">{children}</div>
    </section>
  )
}
