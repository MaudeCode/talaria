import { m } from '../../paraglide/messages.js'
import { Switch } from '../../ui/Field'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'
import { NAV_ITEMS, FIXED_TABS } from '../../shell/nav'
import { useProviderQuotas, useSetSidebarQuotaPins, useSidebarQuotaPins } from '../../lib/useProviderQuotas'
import { quotaSourceName } from '../insights/QuotaMeter'
import { SettingNumber, SettingRow, SettingSelect, SettingToggle as Toggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

/** TAL-1870, TAL-2075: pins the sidebar's quota sources from the server's projection, one switch row per source. */
function SidebarQuotaSources() {
  const { quotas } = useProviderQuotas()
  const setPins = useSetSidebarQuotaPins()
  const sources = quotas.data?.sources
  const { ids: pinned, canPin } = useSidebarQuotaPins(quotas.data)
  return (
    <SettingsGroup id="quotas" title={m.settings_group_quotas()} hint={m.settings_desc_sidebar_quotas()}>
      {quotas.isPending && <LoadingState compact />}
      {quotas.isError && !sources && <ErrorState error={quotas.error} onRetry={() => { void quotas.refetch() }} />}
      {sources?.length === 0 && <span className="py-2 text-sm text-muted">{m.insights_quotas_empty()}</span>}
      {sources?.map((s) => {
        const on = pinned.includes(s.source_id)
        const id = `settingsSidebarQuota-${s.source_id}`
        return (
          <SettingRow key={s.source_id} label={s.display_name ?? quotaSourceName(s)} htmlFor={id}>
            <Switch id={id} checked={on} disabled={!on && !canPin} onCheckedChange={(checked) => { setPins.mutate(checked ? [...pinned, s.source_id] : pinned.filter((p) => p !== s.source_id)) }} />
          </SettingRow>
        )
      })}
    </SettingsGroup>
  )
}

/** TAL-1691, TAL-2100, TAL-2075: Settings > Navigation, what the chats list, the sidebar and the workspace panel show. */
export function SidebarSection() {
  const { settings, set } = useSettingField(['hidden_tabs'])
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className={SETTINGS_PAGE} data-section="navigation">
      <SettingsGroup id="chats" title={m.settings_group_chats_list()}>
        <SettingNumber label={m.settings_label_pinned_limit()} hint={m.settings_desc_pinned_limit()} id="settingsPinnedLimit" settingKey="pinned_sessions_limit" fallback={3} max={50} />
        <SettingSelect label={m.settings_label_sidebar_density()} id="settingsSidebarDensity" settingKey="sidebar_density" fallback="compact" options={[
          { value: 'compact', label: m.settings_sidebar_density_compact() },
          { value: 'detailed', label: m.settings_sidebar_density_detailed() },
        ]} />
        <Toggle label={m.settings_label_project_quick_create()} settingKey="project_quick_create_buttons" />
      </SettingsGroup>
      <SettingsGroup id="sessions" title={m.settings_group_sessions_shown()}>
        <Toggle label={m.settings_label_external_sessions()} settingKey="show_cli_sessions" />
        <Toggle label={m.settings_label_claude_code_sessions()} settingKey="show_claude_code_sessions" />
        <Toggle label={m.settings_label_cron_sessions()} settingKey="show_cron_sessions" />
        <Toggle label={m.settings_label_webhook_sessions()} settingKey="show_webhook_sessions" />
        <Toggle label={m.settings_label_kanban_sessions()} settingKey="show_kanban_sessions" />
        <Toggle label={m.settings_label_previous_messaging_sessions()} settingKey="show_previous_messaging_sessions" />
      </SettingsGroup>
      <SettingsGroup id="destinations" title={m.settings_group_destinations()}>
        {NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map((n) => {
          const hidden = (settings.data.hidden_tabs ?? []).includes(n.id)
          const id = `settingsHiddenTab-${n.id}`
          return (
            <SettingRow key={n.id} label={n.label()} htmlFor={id}>
              <Switch id={id} checked={!hidden} onCheckedChange={(checked) => { const cur = new Set(settings.data.hidden_tabs ?? []); if (checked) cur.delete(n.id); else cur.add(n.id); set({ hidden_tabs: [...cur] }) }} />
            </SettingRow>
          )
        })}
      </SettingsGroup>
      <SettingsGroup id="buttons" title={m.settings_group_buttons()}>
        <Toggle label={m.settings_label_sidebar_feedback()} settingKey="show_sidebar_feedback" />
        <Toggle label={m.settings_label_show_titlebar_profile()} settingKey="show_titlebar_profile" />
      </SettingsGroup>
      <SidebarQuotaSources />
      <SettingsGroup id="workspace" title={m.settings_group_workspace_panel()}>
        <Toggle label={m.settings_label_workspace_panel_open()} settingKey="workspace_panel_open" />
        <Toggle label={m.settings_label_workspace_todos_tab()} settingKey="workspace_todos_tab" />
        <Toggle label={m.settings_label_new_chat_on_workspace_switch()} settingKey="new_chat_on_workspace_switch" />
        <Toggle label={m.settings_label_terminal_auto_expand()} settingKey="terminal_auto_expand_on_output" />
        <Toggle label={m.settings_label_terminal_screen_reader()} hint={m.settings_desc_terminal_screen_reader()} settingKey="screen_reader_mode" />
      </SettingsGroup>
    </div>
  )
}
