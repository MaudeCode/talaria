import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { Button } from '../../ui/Button'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog } from '../../ui/Dialog'
import { ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { useSettingField } from './useSettingField'
import { useLogout } from '../auth/useLogout'
import { decodeCreationOptions, encodeAttestation, passkeysSupported } from '../auth/passkeys'
import { loadBootstrap } from '../../app/bootstrap'

export function SystemSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const { settings, save, str, bool, set } = useSettingField()
  const health = useQuery({ queryKey: keys.health.system, queryFn: api.fetchSystemHealth, staleTime: 30_000 })
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, staleTime: 15_000 })
  const updates = useQuery({ queryKey: keys.updates.check, queryFn: () => api.fetchUpdatesCheck(), staleTime: 60_000 })
  const passkeys = useQuery({ queryKey: ['auth', 'passkeys'], queryFn: api.passkeysList, staleTime: 30_000, enabled: bootstrap.auth.passkey_feature_flag === true })
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
  const setChannel = (v: string) => { setChannelDraft(v); save.mutate({ update_channel: v }, { onError: fail, onSettled: () => setChannelDraft(undefined) }) }
  // The server reads persisted settings (channel, ignore-agent) for the forced check, so let every
  // in-flight settings save settle first; the cache then holds whatever actually persisted.
  const settledChannel = () => { const v = qc.getQueryData<Record<string, unknown>>(keys.settings)?.update_channel; return typeof v === 'string' ? v : undefined }
  const checkNow = useMutation({
    mutationFn: async () => {
      while (qc.isMutating({ mutationKey: keys.settings })) await new Promise((r) => setTimeout(r, 50))
      return api.checkUpdatesNow(settledChannel())
    },
    onSuccess: (d) => qc.setQueryData(keys.updates.check, d),
    onError: fail,
  })
  const apply = useMutation({ mutationFn: (action: 'apply' | 'force' | 'clear_lock') => api.applyUpdates(action), onSuccess: (r) => { showToast(r.message ?? r.status ?? m.saved()); void qc.invalidateQueries({ queryKey: keys.updates.check }) }, onError: fail })
  const registerPasskey = useMutation({
    mutationFn: async () => {
      const opt = await api.passkeyRegisterOptions()
      if (!opt.publicKey) throw new Error(opt.error ?? 'Passkey unavailable')
      const cred = await navigator.credentials.create({ publicKey: decodeCreationOptions(opt.publicKey as Parameters<typeof decodeCreationOptions>[0]) })
      if (!cred) throw new Error('Passkey cancelled')
      return api.passkeyRegister(encodeAttestation(cred as PublicKeyCredential))
    },
    onSuccess: () => { showToast(m.system_passkey_registered()); void qc.invalidateQueries({ queryKey: ['auth', 'passkeys'] }); void loadBootstrap() },
    onError: fail,
  })
  const deletePasskey = useMutation({ mutationFn: (id: string) => api.passkeyDelete(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auth', 'passkeys'] }) }, onError: fail })
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  const canManage = bootstrap.auth.can_manage_server !== false
  const passwordLocked = bool('password_env_var')
  return (
    <div className="flex flex-col gap-5" data-section="system">
      <section>
        <h2 className="mb-1 text-sm font-semibold text-text">{m.system_versions()}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">{m.system_webui_version()}</dt><dd className="font-mono text-text">{str('webui_version', bootstrap.webui_version)}</dd>
          <dt className="text-muted">{m.system_agent_version()}</dt><dd className="font-mono text-text">{str('agent_version', '—')}</dd>
        </dl>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-semibold text-text">{m.system_updates()}</h2>
        <FieldRow label={m.settings_label_check_updates()} htmlFor="settingsCheckUpdates" inline><Switch id="settingsCheckUpdates" checked={bool('check_for_updates', true)} onCheckedChange={(checked) => set({ check_for_updates: checked })} /></FieldRow>
        <FieldRow label={m.settings_label_update_channel()} htmlFor="settingsUpdateChannel" inline>
          <Select id="settingsUpdateChannel" value={channel} onValueChange={setChannel}>
            <option value="stable">{m.settings_update_channel_stable()}</option>
            <option value="experimental">{m.settings_update_channel_experimental()}</option>
          </Select>
        </FieldRow>
        <FieldRow label={m.settings_label_ignore_agent_updates()} htmlFor="settingsIgnoreAgentUpdates" inline><Switch id="settingsIgnoreAgentUpdates" checked={bool('ignore_agent_updates')} onCheckedChange={(checked) => set({ ignore_agent_updates: checked })} /></FieldRow>
        <FieldRow label={m.settings_label_whats_new_summary()} htmlFor="settingsWhatsNew" inline><Switch id="settingsWhatsNew" checked={bool('whats_new_summary_enabled')} onCheckedChange={(checked) => set({ whats_new_summary_enabled: checked })} /></FieldRow>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          {updates.data?.disabled ? <span>—</span> : updates.data?.webui?.behind ? <span className="text-accent-text">{m.system_update_available({ name: 'webui', n: updates.data.webui.behind })}</span> : updates.data ? <span>{m.system_up_to_date()}</span> : null}
          {updates.data?.agent?.behind ? <span className="text-accent-text">{m.system_update_available({ name: 'agent', n: updates.data.agent.behind })}</span> : null}
          <Button onClick={() => checkNow.mutate()} disabled={checkNow.isPending}>{checkNow.isPending ? m.settings_checking() : m.system_check_updates()}</Button>
          {canManage && (updates.data?.webui?.behind || updates.data?.agent?.behind) ? <Button variant="primary" onClick={() => apply.mutate('apply')} disabled={apply.isPending}>{m.system_apply_update()}</Button> : null}
        </div>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-semibold text-text">{m.system_health()}</h2>
        {health.data && (
          <div className="text-xs text-muted">
            {health.data.status ?? '—'}{health.data.checked_at ? ` · ${formatDate(health.data.checked_at)}` : ''}
            {health.data.disk?.percent !== undefined && <span> · disk {health.data.disk.percent.toFixed(0)}%</span>}
          </div>
        )}
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          <span>{m.system_agent_health()}: {agent.data?.alive === true ? 'ok' : agent.data?.alive === false ? (agent.data.details?.reason ?? 'down') : agent.data?.details?.state ?? '—'}</span>
          {canManage && <Button onClick={() => restart.mutate()} disabled={restart.isPending}>{m.system_restart_agent()}</Button>}
        </div>
      </section>
      {canManage && (
        <section>
          <h2 className="mb-1 text-sm font-semibold text-text">{m.settings_label_password()}</h2>
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
        </section>
      )}
      {bootstrap.auth.passkey_feature_flag && (
        <section>
          <h2 className="mb-1 text-sm font-semibold text-text">{m.system_passkeys()}</h2>
          <ul className="text-sm">
            {(passkeys.data?.passkeys ?? []).map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 py-1"><span>{k.name ?? k.id}</span><Button variant="ghost" className="text-error" onClick={() => deletePasskey.mutate(k.id)}>{m.delete()}</Button></li>
            ))}
          </ul>
          {passkeysSupported() && <Button onClick={() => registerPasskey.mutate()} disabled={registerPasskey.isPending}>{m.system_passkey_register()}</Button>}
        </section>
      )}
      <section className="flex flex-wrap gap-2">
        {bootstrap.auth.auth_enabled && <Button onClick={() => { void logout() }}>{m.system_logout()}</Button>}
        {canManage && <Button variant="ghost" className="text-error" onClick={() => setConfirmShutdown(true)}>{m.system_shutdown()}</Button>}
      </section>
      <ConfirmDialog open={confirmShutdown} onOpenChange={setConfirmShutdown} title={m.system_shutdown()} description={m.system_shutdown_confirm()} confirmLabel={m.system_shutdown()} cancelLabel={m.cancel()} danger onConfirm={() => shutdown.mutate()} />
    </div>
  )
}
