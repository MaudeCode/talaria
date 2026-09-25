import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Switch, FieldRow, TextInput, HelpTip } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog } from '../../ui/Dialog'
import { ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { useSettingField } from './useSettingField'
import { useLogout } from '../auth/useLogout'
import { decodeCreationOptions, encodeAttestation, passkeysSupported } from '../auth/passkeys'
import { loadBootstrap } from '../../app/bootstrap'
import type { z } from 'zod'
import type { UpdateTargetSchema } from '../../contracts'

export function SystemSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const { settings, save, str, bool, set } = useSettingField()
  const health = useQuery({ queryKey: keys.health.system, queryFn: api.fetchSystemHealth, staleTime: 30_000 })
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, staleTime: 15_000 })
  const updates = useQuery({ queryKey: keys.updates.check, queryFn: () => api.fetchUpdatesCheck(), staleTime: 30_000, refetchInterval: 30_000 })
  const passkeys = useQuery({ queryKey: ['auth', 'passkeys'], queryFn: api.passkeysList, staleTime: 30_000, enabled: bootstrap.auth.passkey_feature_flag })
  const logout = useLogout()
  const [pw, setPw] = useState('')
  const [currentPw, setCurrentPw] = useState('')
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const setPassword = useMutation({ mutationFn: (body: Record<string, unknown>) => api.saveSettings(body), onSuccess: async () => { showToast(m.system_password_updated()); setPw(''); setCurrentPw(''); await loadBootstrap(); void qc.invalidateQueries() }, onError: fail })
  const restart = useMutation({ mutationFn: api.restartAgent, onSuccess: () => { showToast(m.saved()); void qc.invalidateQueries({ queryKey: keys.health.agent }) }, onError: fail })
  const shutdown = useMutation({ mutationFn: api.shutdownServer, onSuccess: () => showToast(m.system_shutdown()), onError: fail })
  // The chosen channel is held locally until its save settles; the cache only catches up on success,
  // and a later save (e.g. ignore-agent) must not make the Select snap back meanwhile.
  const [channelDraft, setChannelDraft] = useState<string>()
  const channel = channelDraft ?? str('update_channel', 'stable')
  const setChannel = (v: string) => { setChannelDraft(v); save.mutate({ update_channel: v }, { onError: fail, onSettled: () => { setChannelDraft(undefined); void qc.invalidateQueries({ queryKey: keys.updates.check }) } }) }
  const [agentChannelDraft, setAgentChannelDraft] = useState<string>()
  const agentChannel = agentChannelDraft ?? str('agent_update_channel', 'stable')
  const setAgentChannel = (v: string) => { setAgentChannelDraft(v); save.mutate({ agent_update_channel: v }, { onError: fail, onSettled: () => { setAgentChannelDraft(undefined); void qc.invalidateQueries({ queryKey: keys.updates.check }) } }) }
  const [agentConfirmation, setAgentConfirmation] = useState<{ revision: string; supported: string; version: string; channel: 'stable' | 'experimental' } | null>(null)
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
  const apply = useMutation({
    mutationFn: async (request: { target: 'webui' | 'agent'; confirmedRevision?: string; agentChannel?: 'stable' | 'experimental' }) => {
      await waitForSettings()
      return request.target === 'webui' ? api.applyUpdates('apply', settledChannel() ?? channel, 'webui')
        : api.applyUpdates('apply', undefined, 'agent', { agent_channel: request.agentChannel ?? settledAgentChannel(), ...(request.confirmedRevision ? { confirmed_agent_revision: request.confirmedRevision } : {}) })
    },
    onSuccess: (r) => {
      if (r.confirmation_required && r.candidate_revision && r.agent_channel) {
        setAgentConfirmation({ revision: r.candidate_revision, supported: r.supported_revision ?? '—', version: r.supported_version ?? '—', channel: r.agent_channel })
      } else if (r.ok === false) fail(new Error(r.message ?? r.error ?? m.settings_update_check_failed()))
      else showToast(r.message ?? r.status ?? m.saved())
      void qc.invalidateQueries({ queryKey: keys.updates.check })
    }, onError: fail,
  })
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
  const deletePasskey = useMutation({ mutationFn: (id: string) => api.passkeyDelete(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auth', 'passkeys'] }) }, onError: fail })
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  const canManage = bootstrap.auth.can_manage_server
  const passwordLocked = bool('password_env_var')
  const webUpdate = updates.data?.webui
  const canApplyWeb = ((webUpdate?.behind ?? 0) > 0 || webUpdate?.metadata_repair === true) && !webUpdate?.error && !webUpdate?.manual_update && (!webUpdate?.no_git || webUpdate?.install_kind === 'npm')
  const agentUpdate = updates.data?.agent
  const canApplyAgent = (agentUpdate?.behind ?? 0) > 0 && !agentUpdate?.error && !agentUpdate?.manual_update && !agentUpdate?.no_git && !bool('ignore_agent_updates') && !updates.data?.disabled
  const updatesOff = updates.data?.disabled === true
  // One failed poll is a transport blip, not a failed check: keep rendering the last server payload.
  const webStatus = pathStatus(webUpdate, WEB, { off: updatesOff, failed: updates.isError && !updates.data, pending: updates.isPending, dirtyBlocks: true })
  const agentStatus = pathStatus(agentUpdate, AGENT, { off: updatesOff || bool('ignore_agent_updates'), failed: updates.isError && !updates.data, pending: updates.isPending, dirtyBlocks: false })
  const heading = 'text-[15px] font-semibold text-text'
  return (
    <div className="flex flex-col gap-9" data-section="system">
      <section aria-labelledby="systemUpdatesHeading" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="systemUpdatesHeading" className={heading}>{m.system_updates()}<HelpTip label={m.field_help_about({ label: m.system_updates() })}>{m.system_updates_intro()}</HelpTip></h2>
          <Button onClick={() => checkNow.mutate()} disabled={checkNow.isPending}>{checkNow.isPending ? m.settings_checking() : bool('ignore_agent_updates') ? m.system_check_web() : m.system_check_both()}</Button>
        </div>
        <div className="grid gap-x-10 gap-y-8 [grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr))]">
          <UpdatePath id="systemWebPath" title={WEB} installed={webUpdate?.current_version ?? str('webui_version', bootstrap.webui_version)} status={webStatus}
            channel={<Select id="settingsUpdateChannel" aria-label={m.settings_label_web_update_channel()} disabled={!canManage} value={channel} onValueChange={setChannel}>
              <option value="stable">{m.settings_update_channel_stable()}</option>
              <option value="experimental">{m.settings_update_channel_experimental()}</option>
            </Select>}
            action={canManage && canApplyWeb ? <Button variant="primary" onClick={() => apply.mutate({ target: 'webui' })} disabled={apply.isPending}>{webUpdate?.metadata_repair ? m.system_finish_update() : m.system_apply_web_update()}</Button> : null}
            manualLink={webUpdate?.manual_update && (webUpdate.error || webUpdate.dirty || webUpdate.behind !== 0)}>
            <FieldRow label={m.settings_label_auto_apply_updates()} hint={m.system_auto_apply_hint()} htmlFor="settingsAutoApplyUpdates" inline><Switch id="settingsAutoApplyUpdates" disabled={!canManage || !bool('check_for_updates', true)} checked={bool('auto_apply_updates')} onCheckedChange={(checked) => set({ auto_apply_updates: checked })} /></FieldRow>
          </UpdatePath>
          <UpdatePath id="systemAgentPath" title={AGENT} installed={agentUpdate?.current_version ?? str('agent_version', '—')} status={agentStatus}
            channel={<Select id="settingsAgentUpdateChannel" aria-label={m.settings_label_agent_update_channel()} disabled={!canManage} value={agentChannel} onValueChange={setAgentChannel}>
              <option value="stable">{m.settings_update_channel_stable()}</option>
              <option value="experimental">{m.settings_update_channel_experimental()}</option>
            </Select>}
            action={canManage && canApplyAgent ? <Button variant="primary" onClick={() => apply.mutate({ target: 'agent' })} disabled={apply.isPending}>{m.system_apply_agent_update()}</Button> : null}
            warning={canApplyAgent && agentUpdate?.unsupported === true ? m.system_agent_unsupported_warning() : null}>
            <FieldRow label={m.settings_label_ignore_agent_updates()} hint={m.system_agent_manual_hint()} htmlFor="settingsIgnoreAgentUpdates" inline><Switch id="settingsIgnoreAgentUpdates" checked={bool('ignore_agent_updates')} onCheckedChange={(checked) => set({ ignore_agent_updates: checked })} /></FieldRow>
          </UpdatePath>
        </div>
        <div className="border-t border-border-subtle pt-1">
          <FieldRow label={m.settings_label_check_updates()} hint={m.system_check_updates_hint()} htmlFor="settingsCheckUpdates" inline><Switch id="settingsCheckUpdates" disabled={!canManage} checked={bool('check_for_updates', true)} onCheckedChange={(checked) => set({ check_for_updates: checked })} /></FieldRow>
          <FieldRow label={m.settings_label_whats_new_summary()} htmlFor="settingsWhatsNew" inline><Switch id="settingsWhatsNew" checked={bool('whats_new_summary_enabled')} onCheckedChange={(checked) => set({ whats_new_summary_enabled: checked })} /></FieldRow>
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
          <dd>{canManage && <Button onClick={() => restart.mutate()} disabled={restart.isPending}>{m.system_restart_agent()}</Button>}</dd>
        </dl>
      </section>
      {(canManage || bootstrap.auth.passkey_feature_flag || bootstrap.auth.auth_enabled) && <section aria-labelledby="systemAccessHeading" className="flex flex-col gap-4">
        <h2 id="systemAccessHeading" className={heading}>{m.system_access()}</h2>
      {canManage && (
        <div>
          <h3 className="mb-1.5 text-sm font-medium text-text">{m.settings_label_password()}</h3>
          {passwordLocked ? (
            <p className="text-xs text-muted">{m.password_env_var_locked()}</p>
          ) : (
            <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (pw.trim()) setPassword.mutate({ _set_password: pw.trim(), ...(currentPw ? { _current_password: currentPw } : {}) }) }} className="flex flex-col gap-2">
              {bool('password_auth_enabled') && <TextInput type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder={m.current_password_placeholder()} aria-label={m.current_password_placeholder()} />}
              <TextInput type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={m.password_placeholder()} aria-label={m.settings_label_password()} />
              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={!pw.trim() || setPassword.isPending}>{m.system_password_set()}</Button>
                {bool('password_auth_enabled') && <Button variant="ghost" className="text-error" onClick={() => setPassword.mutate({ _clear_password: true, ...(currentPw ? { _current_password: currentPw } : {}) })}>{m.system_password_clear()}</Button>}
              </div>
            </form>
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
            {(passkeys.data?.credentials ?? []).map((k) => (
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
      <ConfirmDialog open={agentConfirmation !== null} onOpenChange={(open) => { if (!open) setAgentConfirmation(null) }} title={m.system_agent_unsupported_title()} description={agentConfirmation ? `${m.system_agent_unsupported_warning()} ${m.system_agent_unsupported_identity({ version: agentConfirmation.version, supported: agentConfirmation.supported.slice(0, 12), candidate: agentConfirmation.revision.slice(0, 12) })}` : ''} confirmLabel={m.system_agent_update_anyway()} cancelLabel={m.cancel()} danger onConfirm={() => { if (agentConfirmation) apply.mutate({ target: 'agent', confirmedRevision: agentConfirmation.revision, agentChannel: agentConfirmation.channel }) }} />
    </div>
  )
}

const WEB = 'Talaria Web'
const AGENT = 'Hermes Agent'
type Target = z.infer<typeof UpdateTargetSchema>
type Tone = 'update' | 'ok' | 'warn' | 'quiet'
interface PathStatus { tone: Tone; text: string; target?: string | undefined; detail?: string | undefined }

/** One component's update state in the words its channel uses: Stable names releases, Experimental counts commits. */
// Web refuses dirty checkouts; Agent updates stash local changes and restore them, so only Web reports dirty as blocking.
function pathStatus(t: Target | null | undefined, name: string, { off, failed, pending, dirtyBlocks }: { off: boolean; failed: boolean; pending: boolean; dirtyBlocks: boolean }): PathStatus {
  const latest = typeof t?.latest_version === 'string' ? t.latest_version : undefined
  const release = t?.release_based === true
  const message = typeof t?.message === 'string' ? t.message : undefined
  if (off) return { tone: 'quiet', text: m.system_checks_off({ name }) }
  if (pending && !t) return { tone: 'quiet', text: m.system_checking_named({ name }) }
  if (failed || t?.error) return { tone: 'warn', text: m.system_check_failed_named({ name }), detail: t?.error }
  if (!t) return { tone: 'quiet', text: m.system_status_unknown_named({ name }) }
  if (t.dirty && dirtyBlocks) return { tone: 'warn', text: m.system_local_changes_named({ name }), detail: message }
  if (t.metadata_repair) return { tone: 'update', text: m.system_finish_named({ name }), target: latest, detail: message }
  if (t.manual_update) return { tone: 'warn', text: m.system_manual_named({ name }), target: (t.behind ?? 0) > 0 && release ? latest : undefined, detail: message }
  if ((t.behind ?? 0) > 0) return release
    ? { tone: 'update', text: m.system_release_ready({ name, version: latest ?? '—' }), target: latest, detail: installedUnverified(t) ? m.system_installed_unverified() : undefined }
    : { tone: 'update', text: m.system_commits_behind({ name, n: t.behind ?? 0 }) }
  if (t.behind === 0) return { tone: 'ok', text: m.system_up_to_date_named({ name }) }
  if (t.no_git && t.install_kind !== 'npm') return { tone: 'quiet', text: m.system_manual_named({ name }) }
  return { tone: 'quiet', text: m.system_status_unknown_named({ name }) }
}

/** Stable Agent reports a bare 12-hex revision when its checkout sits on no release tag. */
const installedUnverified = (t: Target) => !t.current_version || /^[0-9a-f]{12}$/.test(t.current_version)

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

/** A component's update path: installed version, then where its channel leads, with its own controls underneath. */
function UpdatePath({ id, title, installed, status, channel, action, warning, manualLink, children }: {
  id: string; title: string; installed: string; status: PathStatus; channel: ReactNode; action: ReactNode; warning?: string | null; manualLink?: unknown; children: ReactNode
}) {
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
          {!next ? <p role="status" className="mt-1 text-xs text-muted">{status.text}</p> : null}
        </PathNode>
        {next ? (
          <PathNode tone={status.tone}>
            {status.target ? <div className="font-mono text-sm text-text break-all">{status.target}</div> : null}
            <p role="status" className={cn('text-xs', status.tone === 'update' ? 'text-accent-text' : status.tone === 'warn' ? 'text-warning' : 'text-muted')}>{status.text}</p>
            {status.detail ? <p className="mt-0.5 text-xs text-muted">{status.detail}</p> : null}
            {manualLink ? <a className="inline-flex min-h-11 items-center text-xs text-accent-text underline" href="https://github.com/MaudeCode/talaria/releases" target="_blank" rel="noreferrer">{m.system_manual_updates()}</a> : null}
            {warning ? <p role="status" className="mt-1 text-xs text-warning">{warning}</p> : null}
            {action ? <div className="mt-2">{action}</div> : null}
          </PathNode>
        ) : null}
      </ol>
      <div className="self-end border-t border-border-subtle">{children}</div>
    </section>
  )
}
