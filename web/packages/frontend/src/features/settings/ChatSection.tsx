import { m } from '../../paraglide/messages.js'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'
import { GatewayRestart } from './GatewayRestart'
import { SettingAction, SettingNumber, SettingSelect, SettingToggle as Toggle, SettingsGroup } from './SettingsRows'

/** TAL-1691: Settings > Chat, the composer's defaults and how the transcript renders. */
export function ChatSection() {
  const { settings } = useSettingField(['compression_prepare_ahead', 'group_discussion_max_rounds', 'group_discussion_restart_required'])
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className="flex flex-col gap-7" data-section="chat">
      <SettingsGroup id="composer" title={m.settings_group_composer()}>
        <SettingSelect label={m.settings_label_send_key()} id="settingsSendKey" settingKey="send_key" fallback="enter" options={[
          { value: 'enter', label: m.settings_send_key_enter() },
          { value: 'ctrl+enter', label: m.settings_send_key_ctrl_enter() },
        ]} />
        <SettingSelect label={m.settings_label_default_message_mode()} id="settingsDefaultMessageMode" settingKey="default_message_mode" fallback="steer" options={[
          { value: 'steer', label: m.settings_default_message_mode_steer() },
          { value: 'queue', label: m.settings_default_message_mode_queue() },
          { value: 'interrupt', label: m.settings_default_message_mode_interrupt() },
        ]} />
        <Toggle label={m.settings_label_large_text_paste_as_attachment()} settingKey="large_text_paste_as_attachment" fallback />
      </SettingsGroup>
      <SettingsGroup id="transcript" title={m.settings_group_transcript()}>
        <SettingSelect label={m.settings_label_chat_activity_display_mode()} id="settingsChatActivityDisplayMode" settingKey="chat_activity_display_mode" fallback="compact_worklog" options={[
          { value: 'compact_worklog', label: m.settings_option_compact_worklog() },
          { value: 'transparent_stream', label: m.settings_option_transparent_stream() },
          { value: 'hide_all_activity', label: m.settings_option_hide_all_activity() },
        ]} />
        <Toggle label={m.settings_label_transparent_stream_event_timestamps()} hint={m.settings_desc_transparent_stream_event_timestamps()} settingKey="transparent_stream_event_timestamps" fallback />
        <Toggle label={m.settings_label_worklog_details_expanded_default()} settingKey="worklog_details_expanded_default" />
        <Toggle label={m.settings_label_auto_scroll_follow()} hint={m.settings_desc_auto_scroll_follow()} settingKey="auto_scroll_follow" fallback />
        <Toggle label={m.settings_label_render_user_markdown()} hint={m.settings_desc_render_user_markdown()} settingKey="render_user_markdown" />
        <Toggle label={m.settings_label_fade_text_effect()} settingKey="fade_text_effect" fallback />
        <Toggle label={m.settings_label_virtualize_transcript()} settingKey="virtualize_transcript" />
        <Toggle label={m.settings_label_busy_placeholder_hint()} hint={m.settings_desc_busy_placeholder_hint()} settingKey="show_busy_placeholder_hint" fallback />
        <Toggle label={m.settings_label_token_usage()} settingKey="show_token_usage" fallback />
        <Toggle label={m.settings_label_token_speed()} settingKey="show_tps" />
        <SettingNumber label={m.settings_label_max_tokens()} id="settingsMaxTokens" settingKey="max_tokens" allowEmpty width="w-28" placeholder={m.settings_placeholder_max_tokens_none()} />
        {typeof settings.data.compression_prepare_ahead === 'boolean' ? <Toggle label={m.settings_label_compression_prepare_ahead()} settingKey="compression_prepare_ahead" /> : null}
        {typeof settings.data.group_discussion_max_rounds === 'number' ? <>
          <SettingNumber label={m.settings_label_group_discussion_max_rounds()} settingKey="group_discussion_max_rounds" />
          <SettingNumber label={m.settings_label_group_discussion_max_messages()} settingKey="group_discussion_max_messages" />
          {settings.data.group_discussion_restart_required === true ? <SettingAction label={m.settings_label_group_discussion_restart()}><GatewayRestart /></SettingAction> : null}
        </> : null}
        <SettingSelect label={m.settings_label_auto_title_refresh()} id="settingsAutoTitleRefresh" settingKey="auto_title_refresh_every" fallback="0" options={[
          { value: '0', label: m.settings_auto_title_refresh_off() },
          { value: '5', label: '5' }, { value: '10', label: '10' }, { value: '20', label: '20' },
        ]} />
      </SettingsGroup>
    </div>
  )
}
