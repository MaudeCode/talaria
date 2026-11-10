import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { loadBootstrap, useBootstrap } from '../../app/bootstrap'
import { useSaveSettings } from '../../app/queries'
import { Check, LogOut, Plus, Trash2 } from 'lucide-react'
import { IconButton } from '../../ui/Button'
import { RowContextMenu } from '../../ui/Menu'
import { TextInput } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { useSettingField } from './useSettingField'
import { useLogout } from '../auth/useLogout'
import { decodeCreationOptions, encodeAttestation, passkeysSupported } from '../auth/passkeys'
import { PrivacySettings } from './PrivacySettings'
import { cn } from '../../ui/cn'
import { SettingAction, SettingRow, SettingToggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'
import { useResourceEffects, useResourceMutation, withEffects } from '../sessions/useResourceMutation'

/** TAL-2100: Settings > Access, who can sign in to this server, then what leaves it (Privacy). */
export function AccessSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const { settings, bool } = useSettingField(['password_env_var', 'password_auth_enabled', 'auth_enabled', 'auth_disabled_acknowledged'])
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
  const { auth_enabled: authEnabled, passkey_feature_flag: passkeysOn } = bootstrap.auth
  return (
    // `@container`: the password form lays out by the page's width, not the window's (the Settings list may sit beside it).
    <div className={cn('@container', SETTINGS_PAGE)} data-section="access">
      {(canManage || passkeysOn || authEnabled) && (
        <SettingsGroup id="sign-in" title={m.settings_group_sign_in()} action={authEnabled ? <IconButton variant="ghost" label={m.system_logout()} onClick={() => { void logout() }}><LogOut aria-hidden="true" /></IconButton> : undefined}>
          {canManage && (bool('password_env_var')
            ? <SettingRow label={m.settings_label_password()} hint={m.password_env_var_locked()}><span className="text-sm text-muted">{m.password_env_var_set()}</span></SettingRow>
            : <SettingRow label={m.settings_label_password()} htmlFor="settingsPassword"><PasswordForm passwordAuthEnabled={bool('password_auth_enabled')} /></SettingRow>)}
          {canManage && !bool('auth_enabled') && <SettingToggle label={m.settings_label_auth_acknowledged()} hint={m.auth_acknowledged_label()} id="settingsAuthAck" settingKey="auth_disabled_acknowledged" />}
          {passkeysOn && <>
            <SettingAction label={m.system_passkeys()}>{passkeysSupported() && <IconButton variant="default" label={m.system_passkey_register()} onClick={() => registerPasskey.mutate()} disabled={registerPasskey.isPending}><Plus aria-hidden="true" /></IconButton>}</SettingAction>
            {withEffects(passkeys.data?.credentials ?? [], (k) => `passkey:${k.id}`, effects).map((k) => (
              <RowContextMenu key={k.id} label={m.system_passkeys()} actions={[{ label: m.delete(), run: () => deletePasskey.mutate(k.id), danger: true }]} trigger={<div>
                <SettingAction label={k.label || k.id}><IconButton variant="danger" label={m.delete()} onClick={() => deletePasskey.mutate(k.id)}><Trash2 aria-hidden="true" /></IconButton></SettingAction>
              </div>} />
            ))}
          </>}
        </SettingsGroup>
      )}
      <PrivacySettings />
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
    // One line once the page is 46rem wide; stacked under that, as on a phone.
    <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (pw.trim()) setPassword.mutate({ _set_password: pw.trim(), ...(currentPw ? { _current_password: currentPw } : {}) }) }} className="flex flex-col gap-2 @min-[46rem]:flex-row @min-[46rem]:items-center">
      {passwordAuthEnabled && <TextInput type="password" autoComplete="current-password" className="w-48" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder={m.current_password_placeholder()} aria-label={m.current_password_placeholder()} />}
      <TextInput id="settingsPassword" type="password" autoComplete="new-password" className="w-48" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={m.password_placeholder()} aria-label={m.settings_label_password()} />
      <div className="flex gap-1 whitespace-nowrap">
        <IconButton type="submit" variant="default" label={m.system_password_set()} disabled={!pw.trim() || setPassword.isPending}><Check aria-hidden="true" /></IconButton>
        {passwordAuthEnabled && <IconButton variant="danger" label={m.system_password_clear()} onClick={() => setPassword.mutate({ _clear_password: true, ...(currentPw ? { _current_password: currentPw } : {}) })}><Trash2 aria-hidden="true" /></IconButton>}
      </div>

    </form>
  )
}
