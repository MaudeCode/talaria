import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, TextInput } from '../../ui/Field'
import { Button } from '../../ui/Button'
import { LoadingState, ErrorState } from '../../ui/States'
import { useBootstrap } from '../../app/bootstrap'
import { useSettingField } from './useSettingField'
import { SettingToggle as Toggle } from './SettingsRows'

/** TAL-1691: System > Privacy, what leaves the server and how links and the assistant are presented. */
export function PrivacySettings() {
  const { settings, str, set } = useSettingField(['bot_name', 'trusted_link_hosts'])
  const [botName, setBotName] = useState<string | null>(null)
  const [trustedHosts, setTrustedHosts] = useState<string | null>(null)
  // Link safety applies to every user of the server; only an owner may change it.
  const canManage = useBootstrap().auth.can_manage_server
  if (settings.isPending) return <LoadingState compact />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className="flex flex-col divide-y divide-border-subtle">
      <Toggle label={m.settings_label_sync_insights()} settingKey="sync_to_insights" />
      <Toggle label={m.settings_label_api_redact()} settingKey="api_redact_enabled" fallback disabled={!canManage} />
      <Toggle label={m.settings_label_confirm_external_links()} settingKey="confirm_external_links" fallback disabled={!canManage} />
      <FieldRow label={m.settings_label_trusted_link_hosts()} hint={m.settings_desc_trusted_link_hosts()} htmlFor="settingsTrustedLinkHosts">
        <form className="flex items-start gap-2" onSubmit={(e) => { e.preventDefault(); if (trustedHosts !== null) { const submitted = trustedHosts; set({ trusted_link_hosts: submitted.split('\n') }, () => setTrustedHosts((draft) => draft === submitted ? null : draft)) } }}>
          <textarea id="settingsTrustedLinkHosts" disabled={!canManage} rows={3} spellCheck={false} autoCapitalize="none" placeholder="docs.example.com" className="min-h-9 w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-text placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50" value={trustedHosts ?? (settings.data.trusted_link_hosts ?? []).join('\n')} onChange={(e) => setTrustedHosts(e.target.value)} />
          <Button type="submit" disabled={!canManage || trustedHosts === null}>{m.save()}</Button>
        </form>
      </FieldRow>
      <FieldRow label={m.settings_label_bot_name()} htmlFor="settingsBotName">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (botName !== null) { const submitted = botName; set({ bot_name: submitted.trim() || 'Hermes' }, () => setBotName((draft) => draft === submitted ? null : draft)) } }}>
          <TextInput id="settingsBotName" value={botName ?? str('bot_name', 'Hermes')} onChange={(e) => setBotName(e.target.value)} maxLength={64} />
          <Button type="submit" disabled={botName === null}>{m.save()}</Button>
        </form>
      </FieldRow>
    </div>
  )
}
