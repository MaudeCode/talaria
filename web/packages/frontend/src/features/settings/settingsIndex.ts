import { m } from '../../paraglide/messages.js'
import type { SettingsSection, ToolsTab } from '../../contracts/url'
import { FIXED_TABS, NAV_ITEMS } from '../../shell/nav'

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
export interface SettingsIndexEntry { section: SettingsSection; tab?: ToolsTab; group: () => string; id: string; label: () => string; scope: SettingScope; shownWith?: string }

type Row = readonly [id: string, label: () => string, shownWith?: string]
const rows = (section: SettingsSection, group: () => string, scope: SettingScope, list: readonly Row[], tab?: ToolsTab): SettingsIndexEntry[] =>
  list.map(([id, label, shownWith]) => ({ section, group, id, label, scope, ...(tab ? { tab } : {}), ...(shownWith ? { shownWith } : {}) }))
/** A `SettingToggle`'s default control id. */
const key = (settingKey: string) => `settings-${settingKey}`

/** TAL-2086: every static Settings row, in page order. Rows that belong to one listed item (a provider, plugin, MCP server, quota source, profile) are not settings of the page and are left out. */
export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  ...rows('appearance', m.settings_label_theme, 'device', [['themePickerGrid', m.settings_label_theme]]),
  ...rows('appearance', m.settings_label_skin, 'device', [['skinPickerGrid', m.settings_label_skin]]),
  ...rows('appearance', m.settings_group_text_layout, 'interface', [['fontSizePickerGrid', m.settings_label_font_size], ['chatWidthPickerGrid', m.settings_label_chat_width]]),
  ...rows('appearance', m.settings_label_language, 'interface', [['settingsLanguage', m.settings_label_language]]),
  ...rows('appearance', m.settings_label_language, 'device', [['settingsRtl', m.settings_label_rtl]]),
  ...rows('chat', m.settings_group_composer, 'interface', [
    ['settingsSendKey', m.settings_label_send_key], ['settingsDefaultMessageMode', m.settings_label_default_message_mode],
    [key('large_text_paste_as_attachment'), m.settings_label_large_text_paste_as_attachment], [key('show_busy_placeholder_hint'), m.settings_label_busy_placeholder_hint],
    [key('show_quota_chip'), m.settings_label_quota_chip],
  ]),
  ...rows('chat', m.settings_group_composer_chips, 'interface', [
    [key('hide_composer_model'), m.settings_label_composer_model], [key('hide_composer_reasoning'), m.settings_label_composer_reasoning],
    [key('hide_composer_profile'), m.settings_label_composer_profile], [key('hide_composer_workspace'), m.settings_label_composer_workspace],
    [key('hide_composer_toolsets'), m.settings_label_composer_toolsets],
  ]),
  ...rows('chat', m.settings_group_composer_controls, 'interface', [
    [key('hide_composer_attach'), m.settings_label_composer_attach], [key('hide_composer_mic'), m.settings_label_composer_mic],
    [key('hide_composer_context'), m.settings_label_composer_context], [key('hide_composer_yolo'), m.settings_label_composer_yolo],
  ]),
  ...rows('chat', m.settings_group_transcript, 'interface', [
    ['settingsChatActivityDisplayMode', m.settings_label_chat_activity_display_mode], [key('transparent_stream_event_timestamps'), m.settings_label_transparent_stream_event_timestamps],
    [key('worklog_details_expanded_default'), m.settings_label_worklog_details_expanded_default], [key('render_user_markdown'), m.settings_label_render_user_markdown],
    [key('fade_text_effect'), m.settings_label_fade_text_effect], [key('show_token_usage'), m.settings_label_token_usage], [key('show_tps'), m.settings_label_token_speed],
  ]),
  ...rows('chat', m.settings_group_scrolling, 'interface', [
    [key('auto_scroll_follow'), m.settings_label_auto_scroll_follow], [key('virtualize_transcript'), m.settings_label_virtualize_transcript],
    [key('session_endless_scroll'), m.settings_label_session_endless_scroll], [key('session_jump_buttons'), m.settings_label_session_jump_buttons],
    [key('show_conversation_outline'), m.settings_label_conversation_outline],
  ]),
  ...rows('chat', m.settings_group_limits, 'interface', [
    ['settingsMaxTokens', m.settings_label_max_tokens], [key('compression_prepare_ahead'), m.settings_label_compression_prepare_ahead, 'settingsMaxTokens'], ['settingsAutoTitleRefresh', m.settings_label_auto_title_refresh],
  ]),
  ...rows('chat', m.settings_group_group_discussions, 'interface', [
    [key('group_discussion_max_rounds'), m.settings_label_group_discussion_max_rounds], [key('group_discussion_max_messages'), m.settings_label_group_discussion_max_messages],
  ]),
  ...rows('navigation', m.settings_group_chats_list, 'interface', [
    ['settingsPinnedLimit', m.settings_label_pinned_limit], ['settingsSidebarDensity', m.settings_label_sidebar_density], [key('project_quick_create_buttons'), m.settings_label_project_quick_create],
  ]),
  ...rows('navigation', m.settings_group_sessions_shown, 'interface', [
    [key('show_cli_sessions'), m.settings_label_external_sessions], [key('show_claude_code_sessions'), m.settings_label_claude_code_sessions],
    [key('show_cron_sessions'), m.settings_label_cron_sessions], [key('show_webhook_sessions'), m.settings_label_webhook_sessions],
    [key('show_kanban_sessions'), m.settings_label_kanban_sessions], [key('show_previous_messaging_sessions'), m.settings_label_previous_messaging_sessions],
  ]),
  ...rows('navigation', m.settings_group_destinations, 'interface', NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map((n) => [`settingsHiddenTab-${n.id}`, n.label] as const)),
  ...rows('navigation', m.settings_group_buttons, 'interface', [
    [key('show_sidebar_feedback'), m.settings_label_sidebar_feedback], [key('show_titlebar_profile'), m.settings_label_show_titlebar_profile],
  ]),
  ...rows('navigation', m.settings_group_workspace_panel, 'interface', [
    [key('workspace_panel_open'), m.settings_label_workspace_panel_open], [key('workspace_todos_tab'), m.settings_label_workspace_todos_tab],
    [key('new_chat_on_workspace_switch'), m.settings_label_new_chat_on_workspace_switch], [key('terminal_auto_expand_on_output'), m.settings_label_terminal_auto_expand],
    [key('screen_reader_mode'), m.settings_label_terminal_screen_reader],
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
  ...rows('providers', m.providers_quota_thresholds_title, 'profile', [
    ['quotaThreshold-warning_remaining_percent', m.providers_quota_warning_remaining], ['quotaThreshold-critical_remaining_percent', m.providers_quota_critical_remaining],
    ['quotaThreshold-pace_tolerance_percent', m.providers_quota_pace_tolerance], ['quotaThreshold-pace_warning_burn_rate_percent', m.providers_quota_pace_warning_burn],
    ['quotaThreshold-pace_critical_burn_rate_percent', m.providers_quota_pace_critical_burn], ['quotaThreshold-pace_minimum_elapsed_hours', m.providers_quota_pace_minimum_hours],
  ]),
  ...rows('tools', m.settings_group_approvals, 'profile', [[key('agent_approvals'), m.settings_label_agent_approvals]]),
  ...rows('tools', m.settings_section_plugins_title, 'profile', [['plugins-auto-update', m.plugins_auto_update]], 'plugins'),
  ...rows('access', m.settings_group_sign_in, 'server', [['settingsPassword', m.settings_label_password], ['settingsAuthAck', m.settings_label_auth_acknowledged, 'settingsPassword']]),
  ...rows('access', m.settings_group_privacy, 'server', [
    [key('sync_to_insights'), m.settings_label_sync_insights], [key('api_redact_enabled'), m.settings_label_api_redact],
    [key('confirm_external_links'), m.settings_label_confirm_external_links], ['settingsTrustedLinkHosts', m.settings_label_trusted_link_hosts],
  ]),
  ...rows('system', m.system_updates, 'server', [
    ['settingsUpdateChannel', m.settings_label_web_update_channel], ['settingsAutoApplyUpdates', m.settings_label_auto_apply_updates],
    ['settingsAgentUpdateChannel', m.settings_label_agent_update_channel], ['settingsIgnoreAgentUpdates', m.settings_label_ignore_agent_updates],
    ['settingsSummarizeUpdatesAutomatically', m.settings_label_summarize_updates_automatically], ['settingsCheckUpdates', m.settings_label_check_updates],
  ]),
  ...rows('logs', m.view, 'server', [['logs-file', m.logs_file_label], ['logs-tail', m.logs_tail_label]]),
]

/** Case-insensitive substring match on each row's localized label and group title, in page order. */
export function searchSettings(query: string): SettingsIndexEntry[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return []
  return SETTINGS_INDEX.filter((entry) => entry.label().toLocaleLowerCase().includes(q) || entry.group().toLocaleLowerCase().includes(q))
}
