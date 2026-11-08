import { m } from '../../paraglide/messages.js'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'
import { NAV_ITEMS, FIXED_TABS } from '../../shell/nav'
import { useProviderQuotas, useSetSidebarQuotaPins, useSidebarQuotaPins } from '../../lib/useProviderQuotas'
import { quotaSourceName } from '../insights/QuotaMeter'
import { SettingToggle as Toggle, SettingsGroup } from './SettingsRows'

/** TAL-1870: pins the sidebar's quota sources from the server's projection. */
function SidebarQuotaSources() {
  const { quotas } = useProviderQuotas()
  const setPins = useSetSidebarQuotaPins()
  const sources = quotas.data?.sources
  const { ids: pinned, canPin } = useSidebarQuotaPins(quotas.data)
  return (
    <FieldRow label={m.settings_label_sidebar_quotas()} hint={m.settings_desc_sidebar_quotas()} htmlFor="settingsSidebarQuotas">
      <div id="settingsSidebarQuotas" className="flex flex-wrap gap-3">
        {quotas.isPending && <LoadingState compact />}
        {quotas.isError && !sources && <ErrorState error={quotas.error} onRetry={() => { void quotas.refetch() }} />}
        {sources?.length === 0 && <span className="text-sm text-muted">{m.insights_quotas_empty()}</span>}
        {sources?.map((s) => {
          const on = pinned.includes(s.source_id)
          return (
            <label key={s.source_id} className="flex items-center gap-1.5 text-sm">
              <Switch checked={on} disabled={!on && !canPin} onCheckedChange={(checked) => { setPins.mutate(checked ? [...pinned, s.source_id] : pinned.filter((id) => id !== s.source_id)) }} /> {s.display_name ?? quotaSourceName(s)}
            </label>
          )
        })}
      </div>
    </FieldRow>
  )
}

/** TAL-1691: Settings > Sidebar, what the chats list, the tabs and the workspace panel show. */
export function SidebarSection() {
  const { settings, set, setAsync, bool, num } = useSettingField(['pinned_sessions_limit', 'show_cli_sessions', 'hidden_tabs'])
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className="flex flex-col gap-7" data-section="sidebar">
      <SettingsGroup id="chats" title={m.settings_group_chats_list()}>
        <FieldRow label={m.settings_label_pinned_limit()} hint={m.settings_desc_pinned_limit()} htmlFor="settingsPinnedLimit" inline>
          <TextInput id="settingsPinnedLimit" type="number" retainDraft min={1} max={50} className="w-20" value={num('pinned_sessions_limit', 3)} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n > 0) return setAsync({ pinned_sessions_limit: n }) }} />
        </FieldRow>
        <Toggle label={m.settings_label_session_endless_scroll()} settingKey="session_endless_scroll" fallback />
        <Toggle label={m.settings_label_session_jump_buttons()} settingKey="session_jump_buttons" fallback />
        <Toggle label={m.settings_label_conversation_outline()} settingKey="show_conversation_outline" />
        <Toggle label={m.settings_label_project_quick_create()} settingKey="project_quick_create_buttons" />
        <FieldRow label={m.settings_label_external_sessions()} htmlFor="settings-show_cli_sessions" inline><Switch id="settings-show_cli_sessions" checked={bool('show_cli_sessions')} onCheckedChange={(checked) => set({ show_cli_sessions: checked })} /></FieldRow>
        <Toggle label={m.settings_label_claude_code_sessions()} settingKey="show_claude_code_sessions" />
        <Toggle label={m.settings_label_cron_sessions()} settingKey="show_cron_sessions" />
        <Toggle label={m.settings_label_webhook_sessions()} settingKey="show_webhook_sessions" />
        <Toggle label={m.settings_label_kanban_sessions()} settingKey="show_kanban_sessions" />
        <Toggle label={m.settings_label_previous_messaging_sessions()} settingKey="show_previous_messaging_sessions" />
      </SettingsGroup>
      <SettingsGroup id="tabs" title={m.settings_group_tabs()}>
        <FieldRow label={m.settings_label_tab_visibility()} htmlFor="settingsHiddenTabs">
          <div id="settingsHiddenTabs" className="flex flex-wrap gap-3">
            {NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map((n) => {
              const hidden = (settings.data.hidden_tabs ?? []).includes(n.id)
              return (
                <label key={n.id} className="flex items-center gap-1.5 text-sm">
                  <Switch checked={!hidden} onCheckedChange={(checked) => { const cur = new Set(settings.data.hidden_tabs ?? []); if (checked) cur.delete(n.id); else cur.add(n.id); set({ hidden_tabs: [...cur] }) }} /> {n.label()}
                </label>
              )
            })}
          </div>
        </FieldRow>
        <Toggle label={m.settings_label_show_titlebar_profile()} settingKey="show_titlebar_profile" fallback />
        <Toggle label={m.settings_label_sidebar_feedback()} settingKey="show_sidebar_feedback" />
        <Toggle label={m.settings_label_quota_chip()} settingKey="show_quota_chip" fallback />
        <SidebarQuotaSources />
      </SettingsGroup>
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
