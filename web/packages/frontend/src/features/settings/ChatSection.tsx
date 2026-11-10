import { ArrowDownToLine, ArrowUpDown, ChevronsUpDown, CornerDownLeft, FileText, Hash, List, ListTree, Loader, MessagesSquare, PanelRight, Repeat, SlidersHorizontal, Type } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ChatPage } from '../../contracts/url'
import { modifierKey } from '../../ui/Keys'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'
import { GatewayRestart } from './GatewayRestart'
import { ComposerGroup } from './ComposerPreview'
import { PAGE_TITLE, SETTINGS_INDEX } from './settingsIndex'
import { SettingAction, SettingLink, SettingNumber, SettingSegmented, SettingSelect, SettingToggle as Toggle, SettingsBack, SettingsGroup, SETTINGS_PAGE, SETTINGS_TITLE } from './SettingsRows'

const FIELDS = ['compression_prepare_ahead', 'group_discussion_max_rounds', 'group_discussion_restart_required']
/** The Agent sends `compression_prepare_ahead` only when it has the choice (TAL-1825). */
const hasCompression = (value: unknown) => typeof value === 'boolean'

/**
 * TAL-1691, TAL-2075, TAL-2076, TAL-2138: Settings › Chat, the composer drawn with its controls, how the composer sends,
 * how the transcript shows and scrolls, and Group discussion limits. Rarely changed rows sit on its two sub-pages.
 */
export function ChatSection() {
  const { settings } = useSettingField(FIELDS)
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  // A sub-page's link counts the rows it shows.
  const rows = (page: ChatPage) => SETTINGS_INDEX.filter((e) => e.page === page && (e.id !== 'settings-compression_prepare_ahead' || hasCompression(settings.data.compression_prepare_ahead))).length
  return (
    <div className={SETTINGS_PAGE} data-section="chat">
      <ComposerGroup>
        <SettingSegmented icon={CornerDownLeft} label={m.settings_label_send_key()} id="settingsSendKey" settingKey="send_key" fallback="enter" options={[
          { value: 'enter', label: m.settings_send_key_enter() },
          { value: 'ctrl+enter', label: m.settings_send_key_ctrl_enter({ modifier: modifierKey() }) },
        ]} />
        <SettingSegmented icon={Loader} label={m.settings_label_default_message_mode()} id="settingsDefaultMessageMode" settingKey="default_message_mode" fallback="steer" options={[
          { value: 'steer', label: m.settings_default_message_mode_steer() },
          { value: 'queue', label: m.settings_default_message_mode_queue() },
          { value: 'interrupt', label: m.settings_default_message_mode_interrupt() },
        ]} />
        <Toggle icon={FileText} label={m.settings_label_large_text_paste_as_attachment()} settingKey="large_text_paste_as_attachment" fallback />
      </ComposerGroup>
      <SettingsGroup id="transcript" title={m.settings_group_transcript()}>
        <SettingSegmented icon={List} label={m.settings_label_chat_activity_display_mode()} id="settingsChatActivityDisplayMode" settingKey="chat_activity_display_mode" fallback="compact_worklog" options={[
          { value: 'compact_worklog', label: m.settings_option_compact_worklog() },
          { value: 'transparent_stream', label: m.settings_option_transparent_stream() },
          { value: 'hide_all_activity', label: m.settings_option_hide_all_activity() },
        ]} />
        <Toggle icon={ChevronsUpDown} label={m.settings_label_worklog_details_expanded_default()} settingKey="worklog_details_expanded_default" />
        <Toggle icon={Type} label={m.settings_label_render_user_markdown()} hint={m.settings_desc_render_user_markdown()} settingKey="render_user_markdown" />
        <Toggle icon={Hash} label={m.settings_label_token_usage()} settingKey="show_token_usage" fallback />
        <Toggle icon={ArrowDownToLine} label={m.settings_label_auto_scroll_follow()} hint={m.settings_desc_auto_scroll_follow()} settingKey="auto_scroll_follow" fallback />
        <Toggle icon={ListTree} label={m.settings_label_conversation_outline()} settingKey="show_conversation_outline" />
        <Toggle icon={ArrowUpDown} label={m.settings_label_session_jump_buttons()} settingKey="session_jump_buttons" fallback />
      </SettingsGroup>
      {typeof settings.data.group_discussion_max_rounds === 'number' ? <SettingsGroup id="group-discussions" title={m.settings_group_group_discussions()}>
        <SettingNumber icon={Repeat} label={m.settings_label_group_discussion_max_rounds()} settingKey="group_discussion_max_rounds" />
        <SettingNumber icon={MessagesSquare} label={m.settings_label_group_discussion_max_messages()} settingKey="group_discussion_max_messages" />
        {settings.data.group_discussion_restart_required === true ? <SettingAction label={m.settings_label_group_discussion_restart()}><GatewayRestart /></SettingAction> : null}
      </SettingsGroup> : null}
      <SettingsGroup id="more" title={m.settings_group_more()}>
        <SettingLink icon={PanelRight} label={m.settings_group_workspace_panel()} detail={m.settings_subpage_rows({ n: rows('workspace-panel') })} link={{ to: '/settings/chat/$page', params: { page: 'workspace-panel' } }} />
        <SettingLink icon={SlidersHorizontal} label={m.settings_page_advanced()} detail={m.settings_subpage_rows({ n: rows('advanced') })} link={{ to: '/settings/chat/$page', params: { page: 'advanced' } }} />
      </SettingsGroup>
    </div>
  )
}

/** TAL-2138: a Chat sub-page, with the back link and title of a provider's own page (TAL-2135). */
export function ChatSubPage({ page }: { page: ChatPage }) {
  const { settings } = useSettingField(FIELDS)
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className={SETTINGS_PAGE} data-section="chat" data-chat-page={page}>
      <div className="flex flex-col gap-2">
        <SettingsBack label={m.settings_section_chat_title()} section="chat" />
        <h1 className={SETTINGS_TITLE}>{PAGE_TITLE[page]()}</h1>
      </div>
      {page === 'workspace-panel' ? <>
        <SettingsGroup id="panel" title={m.settings_group_panel()}>
          <Toggle label={m.settings_label_workspace_panel_open()} settingKey="workspace_panel_open" />
          <Toggle label={m.settings_label_workspace_todos_tab()} settingKey="workspace_todos_tab" />
          <Toggle label={m.settings_label_new_chat_on_workspace_switch()} settingKey="new_chat_on_workspace_switch" />
        </SettingsGroup>
        <SettingsGroup id="terminal" title={m.terminal_title()}>
          <Toggle label={m.settings_label_terminal_auto_expand()} settingKey="terminal_auto_expand_on_output" />
          <Toggle label={m.settings_label_terminal_screen_reader()} hint={m.settings_desc_terminal_screen_reader()} settingKey="screen_reader_mode" />
        </SettingsGroup>
      </> : <>
        <SettingsGroup id="transcript-advanced" title={m.settings_group_transcript()}>
          <Toggle label={m.settings_label_busy_placeholder_hint()} hint={m.settings_desc_busy_placeholder_hint()} settingKey="show_busy_placeholder_hint" fallback />
          <Toggle label={m.settings_label_transparent_stream_event_timestamps()} hint={m.settings_desc_transparent_stream_event_timestamps()} settingKey="transparent_stream_event_timestamps" fallback />
          <Toggle label={m.settings_label_fade_text_effect()} settingKey="fade_text_effect" />
          <Toggle label={m.settings_label_token_speed()} settingKey="show_tps" />
          <Toggle label={m.settings_label_virtualize_transcript()} settingKey="virtualize_transcript" />
          <Toggle label={m.settings_label_session_endless_scroll()} settingKey="session_endless_scroll" fallback />
        </SettingsGroup>
        <SettingsGroup id="limits" title={m.settings_group_limits()}>
          <SettingNumber label={m.settings_label_max_tokens()} id="settingsMaxTokens" settingKey="max_tokens" allowEmpty width="w-28" placeholder={m.settings_placeholder_max_tokens_none()} />
          {hasCompression(settings.data.compression_prepare_ahead) ? <Toggle label={m.settings_label_compression_prepare_ahead()} settingKey="compression_prepare_ahead" /> : null}
          <SettingSelect label={m.settings_label_auto_title_refresh()} id="settingsAutoTitleRefresh" settingKey="auto_title_refresh_every" fallback="0" options={[
            { value: '0', label: m.settings_auto_title_refresh_off() },
            { value: '5', label: '5' }, { value: '10', label: '10' }, { value: '20', label: '20' },
          ]} />
        </SettingsGroup>
      </>}
    </div>
  )
}
