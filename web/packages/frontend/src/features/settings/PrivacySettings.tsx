import { ChartLine, ExternalLink, EyeOff, Link } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { LoadingState, ErrorState } from '../../ui/States'
import { useBootstrap } from '../../app/bootstrap'
import { useSettingField } from './useSettingField'
import { SettingText, SettingToggle as Toggle, SettingsGroup } from './SettingsRows'

/** TAL-1691: Settings › Access › Privacy, what leaves the server and how links are presented. */
export function PrivacySettings() {
  const { settings } = useSettingField(['trusted_link_hosts', 'trusted_link_hosts_count'])
  // Link safety applies to every user of the server; only an owner may change it.
  const canManage = useBootstrap().auth.can_manage_server
  const hostCount = settings.data?.trusted_link_hosts_count
  if (settings.isPending) return <LoadingState compact />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <SettingsGroup id="privacy" title={m.settings_group_privacy()}>
      <Toggle label={m.settings_label_sync_insights()} settingKey="sync_to_insights" icon={ChartLine} />
      <Toggle label={m.settings_label_api_redact()} settingKey="api_redact_enabled" fallback disabled={!canManage} icon={EyeOff} />
      <Toggle label={m.settings_label_confirm_external_links()} settingKey="confirm_external_links" fallback disabled={!canManage} icon={ExternalLink} />
      {/* TAL-2143: closed to the server's count of its normalized hosts, one per line. */}
      <SettingText label={m.settings_label_trusted_link_hosts()} hint={m.settings_desc_trusted_link_hosts()} id="settingsTrustedLinkHosts" settingKey="trusted_link_hosts" icon={Link} multiline placeholder="docs.example.com" disabled={!canManage}
        parse={(draft) => draft.split('\n')} format={(hosts) => (Array.isArray(hosts) ? hosts : []).join('\n')} summary={hostCount === undefined ? '' : hostCount ? m.settings_trusted_link_hosts_count({ count: hostCount }) : m.settings_trusted_link_hosts_none()} />
    </SettingsGroup>
  )
}
