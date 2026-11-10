import { m } from '../../paraglide/messages.js'
import type { ChatPage, SettingsSection, ToolsTab } from '../../contracts/url'
import { SIDEBAR_DESTINATIONS } from '../../shell/nav'
import { COMPOSER_CONTROLS, composerControlId } from './composerControls'

/**
 * Where a setting is stored (`docs/design-system.md` §11): `device` in this browser, `interface` in the server's
 * `settings.json`, `profile` in the active profile's home or a per-profile setting, `server` for every profile.
 */
export type SettingScope = 'device' | 'interface' | 'profile' | 'server'

/**
 * TAL-2086: one Settings row. `label` and `group` are the message functions the row and its `SettingsGroup` render; `id` is
 * its control's. A row shown only under a condition names in `shownWith` the control on its page that shows it, or the
 * nearest row beside it, so a jump to it while hidden lands there.
 */
/** TAL-2136, TAL-2138: a page under a section with its own route: Providers › Quota alerts, and Chat's sub-pages. */
export type SettingsPage = 'quota-alerts' | ChatPage

export interface SettingsIndexEntry { section: SettingsSection; tab?: ToolsTab; group: () => string; id: string; label: () => string; scope: SettingScope; shownWith?: string; /** TAL-2135: the row sits on each listed item's own page (a provider's), so a jump lands on the group that lists them. */ item?: true; /** TAL-2136, TAL-2138: the row sits on this page under its section. */ page?: SettingsPage }

type Row = readonly [id: string, label: () => string, shownWith?: string]
const rows = (section: SettingsSection, group: () => string, scope: SettingScope, list: readonly Row[], tab?: ToolsTab): SettingsIndexEntry[] =>
  list.map(([id, label, shownWith]) => ({ section, group, id, label, scope, ...(tab ? { tab } : {}), ...(shownWith ? { shownWith } : {}) }))
/** TAL-2136, TAL-2138: each page's title, which the link that opens it and its rows' search results name. */
export const PAGE_TITLE: Record<SettingsPage, () => string> = { 'quota-alerts': m.providers_quota_alerts, 'workspace-panel': m.settings_group_workspace_panel, advanced: m.settings_page_advanced }
const onPage = (page: SettingsPage, entries: SettingsIndexEntry[]) => entries.map((entry) => ({ ...entry, page }))
/** A `SettingToggle`'s default control id. */
const key = (settingKey: string) => `settings-${settingKey}`

/** TAL-2086: every static Settings row, in page order. Rows that belong to one listed item (a provider, plugin, MCP server, quota source, profile) are not settings of the page and are left out. */
export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  ...rows('appearance', m.settings_label_theme, 'device', [['themePickerGrid', m.settings_label_theme]]),
  ...rows('appearance', m.settings_label_skin, 'device', [['skinPickerGrid', m.settings_label_skin]]),
  ...rows('appearance', m.settings_group_text_layout, 'interface', [['fontSizePickerGrid', m.settings_label_font_size], ['chatWidthPickerGrid', m.settings_label_chat_width]]),
  ...rows('appearance', m.settings_label_language, 'interface', [['settingsLanguage', m.settings_label_language]]),
  ...rows('appearance', m.settings_label_language, 'device', [['settingsRtl', m.settings_label_rtl]]),
  // TAL-2138: the composer controls are toggles on the drawing of the composer, in its order.
  ...rows('chat', m.settings_group_composer, 'interface', [
    ...COMPOSER_CONTROLS.map((c) => [composerControlId(c.key), c.name] as const),
    ['settingsSendKey', m.settings_label_send_key], ['settingsDefaultMessageMode', m.settings_label_default_message_mode],
    [key('large_text_paste_as_attachment'), m.settings_label_large_text_paste_as_attachment],
  ]),
  ...rows('chat', m.settings_group_transcript, 'interface', [
    ['settingsChatActivityDisplayMode', m.settings_label_chat_activity_display_mode], [key('worklog_details_expanded_default'), m.settings_label_worklog_details_expanded_default],
    [key('render_user_markdown'), m.settings_label_render_user_markdown], [key('show_token_usage'), m.settings_label_token_usage],
    [key('auto_scroll_follow'), m.settings_label_auto_scroll_follow], [key('show_conversation_outline'), m.settings_label_conversation_outline],
    [key('session_jump_buttons'), m.settings_label_session_jump_buttons],
  ]),
  ...onPage('workspace-panel', [
    ...rows('chat', m.settings_group_panel, 'interface', [
      [key('workspace_panel_open'), m.settings_label_workspace_panel_open], [key('workspace_todos_tab'), m.settings_label_workspace_todos_tab],
      [key('new_chat_on_workspace_switch'), m.settings_label_new_chat_on_workspace_switch],
    ]),
    ...rows('chat', m.terminal_title, 'interface', [[key('terminal_auto_expand_on_output'), m.settings_label_terminal_auto_expand], [key('screen_reader_mode'), m.settings_label_terminal_screen_reader]]),
  ]),
  ...onPage('advanced', [
    ...rows('chat', m.settings_group_transcript, 'interface', [
      [key('show_busy_placeholder_hint'), m.settings_label_busy_placeholder_hint], [key('transparent_stream_event_timestamps'), m.settings_label_transparent_stream_event_timestamps],
      [key('fade_text_effect'), m.settings_label_fade_text_effect], [key('show_tps'), m.settings_label_token_speed],
      [key('virtualize_transcript'), m.settings_label_virtualize_transcript], [key('session_endless_scroll'), m.settings_label_session_endless_scroll],
      ['settingsAutoTitleRefresh', m.settings_label_auto_title_refresh],
    ]),
  ]),
  // TAL-2145: the sidebar's items are toggles on the drawing of the sidebar, in its order, beside its three rows.
  ...rows('navigation', m.settings_group_sidebar, 'interface', [
    ...SIDEBAR_DESTINATIONS.map((n) => [`settingsHiddenTab-${n.id}`, n.label] as const),
    [key('show_sidebar_feedback'), m.feedback_rail_label], [key('show_titlebar_profile'), m.settings_label_profile_switcher],
    ['settingsSidebarDensity', m.settings_label_density], ['settingsPinnedLimit', m.settings_label_pinned_shown], [key('project_quick_create_buttons'), m.settings_label_project_new_chat],
  ]),
  ...rows('navigation', m.settings_group_outside_chats, 'interface', [
    [key('show_cli_sessions'), m.settings_label_external_sessions], [key('show_claude_code_sessions'), m.settings_label_claude_code_sessions],
    [key('show_messaging_sessions'), m.settings_label_messaging_sessions], [key('show_previous_messaging_sessions'), m.settings_label_latest_messaging_only],
    [key('show_cron_sessions'), m.settings_label_cron_sessions],
    [key('show_webhook_sessions'), m.settings_label_webhook_sessions], [key('show_kanban_sessions'), m.settings_label_kanban_sessions],
  ]),
  ...rows('notifications', m.settings_group_while_open, 'interface', [
    [key('notifications_enabled'), m.settings_label_notifications], [key('sound_enabled'), m.settings_label_sound],
  ]),
  ...rows('notifications', m.settings_group_reply_finishes, 'device', [
    ['completionSound', m.settings_audio_sound], ['completionVolume', m.settings_audio_volume], ['completionFile', m.settings_audio_file, 'completionSound'], ['completionQuiet', m.settings_audio_quiet],
    ['completionStart', m.settings_audio_start, 'completionQuiet'], ['completionEnd', m.settings_audio_end, 'completionQuiet'], ['completionQuietSound', m.settings_audio_quiet_sound, 'completionQuiet'],
  ]),
  ...rows('notifications', m.settings_group_web_push, 'interface', [
    [key('web_push'), m.settings_label_web_push], [key('notify_on_approval'), m.settings_label_notify_approval, key('web_push')], [key('notify_on_input'), m.settings_label_notify_input, key('web_push')],
    [key('notify_on_completion'), m.settings_label_notify_completion, key('web_push')], [key('notify_on_failure'), m.settings_label_notify_failure, key('web_push')],
  ]),
  ...rows('speech', m.settings_group_read_aloud, 'interface', [[key('tts_enabled'), m.settings_label_tts], [key('tts_auto_read'), m.settings_label_tts_auto_read]]),
  ...rows('speech', m.settings_group_voice_device, 'device', [
    ['settingsTtsEngine', m.settings_label_tts_engine], ['settingsTtsVoice', m.settings_label_tts_voice, 'settingsTtsEngine'], ['settingsTtsRate', m.settings_label_tts_rate], ['settingsTtsPitch', m.settings_label_tts_pitch],
  ]),
  ...rows('models', m.settings_group_main_model, 'profile', [
    ['settingsModel', m.settings_label_model], ['settingsModelSpeed', m.settings_model_speed, 'settingsModel'], ['settingsReasoningEffort', m.settings_reasoning_effort, 'settingsModel'], ['settingsShowThinking', m.settings_show_thinking, 'settingsModel'],
  ]),
  // TAL-2160: the profile's limits, from its config.yaml.
  ...rows('models', m.settings_group_limits, 'profile', [['settingsMaxTokens', m.settings_label_max_tokens], [key('compression_prepare_ahead'), m.settings_label_compression_prepare_ahead, 'settingsMaxTokens']]),
  // TAL-2135: each provider's page pins its quota to the sidebar; the search leads to the providers that have one.
  { section: 'providers', group: m.providers_group_yours, id: 'providerSidebarQuota', label: m.providers_quota_in_sidebar, scope: 'profile', item: true },
  // TAL-2136: the quota thresholds sit on Providers › Quota alerts.
  ...onPage('quota-alerts', [...rows('providers', m.providers_quota_group_remaining, 'profile', [
    ['quotaThreshold-warning_remaining_percent', m.providers_quota_warning_remaining], ['quotaThreshold-critical_remaining_percent', m.providers_quota_critical_remaining],
  ]), ...rows('providers', m.providers_quota_group_pace, 'profile', [
    ['quotaThreshold-pace_tolerance_percent', m.providers_quota_pace_tolerance], ['quotaThreshold-pace_warning_burn_rate_percent', m.providers_quota_pace_warning_burn],
    ['quotaThreshold-pace_critical_burn_rate_percent', m.providers_quota_pace_critical_burn], ['quotaThreshold-pace_minimum_elapsed_hours', m.providers_quota_pace_minimum_hours],
  ])]),
  ...rows('tools', m.settings_section_plugins_title, 'profile', [['plugins-auto-update', m.plugins_auto_update]], 'plugins'),
  ...rows('tools', m.settings_group_agent_permissions, 'profile', [[key('agent_approvals'), m.settings_label_agent_approvals]]),
  ...rows('access', m.settings_group_sign_in, 'server', [['settingsPassword', m.settings_label_password], ['settingsAuthAck', m.settings_label_auth_acknowledged, 'settingsPassword']]),
  ...rows('access', m.settings_group_privacy, 'server', [
    [key('sync_to_insights'), m.settings_label_sync_insights], [key('api_redact_enabled'), m.settings_label_api_redact],
    [key('confirm_external_links'), m.settings_label_confirm_external_links], ['settingsTrustedLinkHosts', m.settings_label_trusted_link_hosts],
  ]),
  ...rows('system', m.system_software, 'server', [['settingsUpdateChannel', m.settings_label_web_update_channel], ['settingsAgentUpdateChannel', m.settings_label_agent_update_channel]]),
  ...rows('system', m.system_updates, 'server', [
    ['settingsCheckUpdates', m.settings_label_check_updates], ['settingsAutoApplyUpdates', m.settings_label_auto_apply_updates],
    ['settingsIgnoreAgentUpdates', m.settings_label_ignore_agent_updates], ['settingsSummarizeUpdatesAutomatically', m.settings_label_summarize_updates_automatically],
  ]),
  // TAL-1828, TAL-2160: the root profile's Group discussion limits, sent only to a session that can manage the server.
  ...rows('system', m.settings_group_group_discussions, 'server', [
    [key('group_discussion_max_rounds'), m.settings_label_group_discussion_max_rounds, 'settingsSummarizeUpdatesAutomatically'], [key('group_discussion_max_messages'), m.settings_label_group_discussion_max_messages, 'settingsSummarizeUpdatesAutomatically'],
  ]),
]

/** Case-insensitive substring match on each row's localized label and group title, in page order. */
export function searchSettings(query: string): SettingsIndexEntry[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return []
  return SETTINGS_INDEX.filter((entry) => entry.label().toLocaleLowerCase().includes(q) || entry.group().toLocaleLowerCase().includes(q))
}
