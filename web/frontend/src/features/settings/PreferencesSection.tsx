import { m } from '../../paraglide/messages.js'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { useSettingField } from './useSettingField'
import { useModelsQuery, useSetDefaultModel } from '../../app/queries'
import { showToast } from '../toast/toast'
import { LoadingState, ErrorState } from '../../ui/States'
import { NAV_ITEMS, FIXED_TABS } from '../../shell/nav'
import { useState } from 'react'
import { Button } from '../../ui/Button'

function Toggle({ label, hint, settingKey, fallback = false }: { label: string; hint?: string; settingKey: string; fallback?: boolean }) {
  const { bool, set } = useSettingField()
  const id = `settings-${settingKey}`
  return (
    <FieldRow label={label} htmlFor={id} {...(hint ? { hint } : {})} inline>
      <Switch id={id} checked={bool(settingKey, fallback)} onCheckedChange={(checked) => set({ [settingKey]: checked })} />
    </FieldRow>
  )
}

export function PreferencesSection() {
  const { settings, str, set, bool, num } = useSettingField()
  const models = useModelsQuery()
  const setDefault = useSetDefaultModel()
  const [botName, setBotName] = useState<string | null>(null)
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className="flex flex-col divide-y divide-border-subtle" data-section="preferences">
      <FieldRow label={m.settings_label_model()} hint={m.settings_default_model_hint()} htmlFor="settingsModel" inline>
        <Select id="settingsModel" value={str('default_model')} onValueChange={(v) => { const group = models.data?.groups.find((g) => g.models.some((mm) => mm.id === v)); setDefault.mutate({ model: v, provider: group?.provider_id ?? group?.provider ?? null }, { onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') }) }}>
          {(models.data?.groups ?? []).map((g) => (
            <optgroup key={g.provider} label={g.provider}>
              {g.models.map((mm) => <option key={mm.id} value={mm.id}>{mm.label ?? mm.id}</option>)}
            </optgroup>
          ))}
          {!models.data?.groups.some((g) => g.models.some((mm) => mm.id === str('default_model'))) && str('default_model') && <option value={str('default_model')}>{str('default_model')}</option>}
        </Select>
      </FieldRow>
      <FieldRow label={m.settings_label_send_key()} htmlFor="settingsSendKey" inline>
        <Select id="settingsSendKey" value={str('send_key', 'enter')} onValueChange={(v) => set({ send_key: v })}>
          <option value="enter">{m.settings_send_key_enter()}</option>
          <option value="ctrl+enter">{m.settings_send_key_ctrl_enter()}</option>
        </Select>
      </FieldRow>
      <FieldRow label={m.settings_label_bot_name()} htmlFor="settingsBotName">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (botName !== null) { set({ bot_name: botName.trim() || 'Hermes' }); setBotName(null) } }}>
          <TextInput id="settingsBotName" value={botName ?? str('bot_name', 'Hermes')} onChange={(e) => setBotName(e.target.value)} maxLength={64} />
          <Button type="submit" disabled={botName === null}>{m.save()}</Button>
        </form>
      </FieldRow>
      <Toggle label={m.settings_label_workspace_panel_open()} settingKey="workspace_panel_open" />
      <Toggle label={m.settings_label_workspace_todos_tab()} settingKey="workspace_todos_tab" />
      <Toggle label={m.settings_label_session_jump_buttons()} settingKey="session_jump_buttons" fallback />
      <Toggle label={m.settings_label_session_endless_scroll()} settingKey="session_endless_scroll" fallback />
      <Toggle label={m.settings_label_show_titlebar_profile()} settingKey="show_titlebar_profile" fallback />
      <Toggle label={m.settings_label_project_quick_create()} settingKey="project_quick_create_buttons" />
      <Toggle label={m.settings_label_token_usage()} settingKey="show_token_usage" fallback />
      <Toggle label={m.settings_label_token_speed()} settingKey="show_tps" />
      <Toggle label={m.settings_label_quota_chip()} settingKey="show_quota_chip" fallback />
      <Toggle label={m.settings_label_conversation_outline()} settingKey="show_conversation_outline" />
      <Toggle label={m.settings_label_terminal_auto_expand()} settingKey="terminal_auto_expand_on_output" />
      <Toggle label={m.settings_label_new_chat_on_workspace_switch()} settingKey="new_chat_on_workspace_switch" />
      <Toggle label={m.settings_label_notifications()} settingKey="notifications_enabled" />
      <Toggle label={m.settings_label_sound()} settingKey="sound_enabled" />
      <FieldRow label={m.settings_label_sidebar_density()} htmlFor="settingsSidebarDensity" inline>
        <Select id="settingsSidebarDensity" value={str('sidebar_density', 'compact')} onValueChange={(v) => set({ sidebar_density: v })}>
          <option value="compact">{m.settings_sidebar_density_compact()}</option>
          <option value="detailed">{m.settings_sidebar_density_detailed()}</option>
        </Select>
      </FieldRow>
      <FieldRow label={m.settings_label_pinned_limit()} hint={m.settings_desc_pinned_limit()} htmlFor="settingsPinnedLimit" inline>
        <TextInput id="settingsPinnedLimit" type="number" min={1} max={50} className="w-20" value={num('pinned_sessions_limit', 3)} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n > 0) set({ pinned_sessions_limit: n }) }} />
      </FieldRow>
      <FieldRow label={m.settings_label_external_sessions()} htmlFor="settings-show_cli_sessions" inline><Switch id="settings-show_cli_sessions" checked={bool('show_cli_sessions')} onCheckedChange={(checked) => set({ show_cli_sessions: checked })} /></FieldRow>
      <Toggle label={m.settings_label_claude_code_sessions()} settingKey="show_claude_code_sessions" />
      <Toggle label={m.settings_label_cron_sessions()} settingKey="show_cron_sessions" />
      <Toggle label={m.settings_label_webhook_sessions()} settingKey="show_webhook_sessions" />
      <Toggle label={m.settings_label_kanban_sessions()} settingKey="show_kanban_sessions" />
      <Toggle label={m.settings_label_previous_messaging_sessions()} settingKey="show_previous_messaging_sessions" />
      <Toggle label={m.settings_label_sync_insights()} settingKey="sync_to_insights" />
      <Toggle label={m.settings_label_api_redact()} settingKey="api_redact_enabled" fallback />
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
    </div>
  )
}
