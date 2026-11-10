import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { loadBootstrap, useBootstrap } from '../../app/bootstrap'
import { useSaveSettings } from '../../app/queries'
import { Button } from '../../ui/Button'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { useSettingField } from './useSettingField'
import { useLogout } from '../auth/useLogout'
import { decodeCreationOptions, encodeAttestation, passkeysSupported } from '../auth/passkeys'
import { PrivacySettings } from './PrivacySettings'
import { useResourceEffects, useResourceMutation, withEffects } from '../sessions/useResourceMutation'

/** TAL-2100: Settings > Access, who can sign in to this server, then what leaves it (Privacy). */
export function AccessSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const { settings, bool, set } = useSettingField(['password_env_var', 'password_auth_enabled', 'auth_enabled', 'auth_disabled_acknowledged'])
  const passkeys = useQuery({ queryKey: ['auth', 'passkeys'], queryFn: api.passkeysList, staleTime: 30_000, enabled: bootstrap.auth.passkey_feature_flag })
  const logout = useLogout()
  const fail = (e: unknown) => showErrorToast(e)
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
  const subheading = 'mb-1.5 text-sm font-medium text-text'
  return (
    <div className="flex flex-col gap-9" data-section="access">
      {canManage && (
        <div>
          <h2 className={subheading}>{m.settings_label_password()}</h2>
          {bool('password_env_var') ? (
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
          <h2 className={subheading}>{m.system_passkeys()}</h2>
          <ul className="text-sm">
            {withEffects(passkeys.data?.credentials ?? [], (k) => `passkey:${k.id}`, effects).map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 py-1"><span>{k.label || k.id}</span><Button variant="ghost-danger" onClick={() => deletePasskey.mutate(k.id)}>{m.delete()}</Button></li>
            ))}
          </ul>
          {passkeysSupported() && <Button onClick={() => registerPasskey.mutate()} disabled={registerPasskey.isPending}>{m.system_passkey_register()}</Button>}
        </div>
      )}
      {bootstrap.auth.auth_enabled && <div><Button onClick={() => { void logout() }}>{m.system_logout()}</Button></div>}
      <section aria-labelledby="accessPrivacyHeading" className="flex flex-col" data-group="privacy">
        <h2 id="accessPrivacyHeading" className="text-[15px] font-semibold text-text">{m.settings_group_privacy()}</h2>
        <PrivacySettings />
      </section>
    </div>
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
        {passwordAuthEnabled && <Button variant="ghost-danger" onClick={() => setPassword.mutate({ _clear_password: true, ...(currentPw ? { _current_password: currentPw } : {}) })}>{m.system_password_clear()}</Button>}
      </div>
    </form>
  )
}
