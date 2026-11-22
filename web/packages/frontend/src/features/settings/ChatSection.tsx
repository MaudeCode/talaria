import { ArrowDownToLine, ArrowUpDown, ChevronsUpDown, CornerDownLeft, FileText, Hash, List, ListChecks, ListTree, Loader, PanelRight, SlidersHorizontal, Type, Wrench } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ChatPage } from '../../contracts/url'
import { modifierKey } from '../../ui/Keys'
import { useIsPhone } from '../../shell/useShellState'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'
import { ComposerGroup } from './ComposerPreview'
import { PAGE_TITLE, SETTINGS_INDEX } from './settingsIndex'
import { SettingLink, SettingSegmented, SettingSelect, SettingToggle as Toggle, SettingsBack, SettingsGroup, SETTINGS_PAGE, SETTINGS_TITLE } from './SettingsRows'

const FIELDS = ['auto_title_refresh_available']

/**
 * TAL-1691, TAL-2075, TAL-2076, TAL-2138: Settings › Chat, the composer drawn with its controls, how the composer sends,
 * and how the transcript shows and scrolls. Rarely changed rows sit on its sub-pages. TAL-2160: profile limits are on
 * Models and Group discussion limits on System.
 */
export function ChatSection() {
  const { settings } = useSettingField(FIELDS)
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  // A sub-page's link counts the rows it shows.
  const rows = (page: ChatPage) => SETTINGS_INDEX.filter((e) => e.page === page).length
  return (
    <div className={SETTINGS_PAGE} data-section="chat">
      <ComposerGroup>
        <SendKeyRow />
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
        <Toggle icon={ListChecks} label={m.settings_label_chat_task_list()} settingKey="chat_task_list" />
        <Toggle icon={ArrowUpDown} label={m.settings_label_session_jump_buttons()} settingKey="session_jump_buttons" fallback />
      </SettingsGroup>
      <SettingsGroup id="more" title={m.settings_group_more()}>
        <SettingLink icon={PanelRight} label={m.settings_group_workspace_panel()} detail={m.settings_subpage_rows({ n: rows('workspace-panel') })} link={{ to: '/settings/chat/$page', params: { page: 'workspace-panel' } }} />
        {/* TAL-2341: the switches for how tool calls show, on their own page so the Transcript group stays short. */}
        <SettingLink icon={Wrench} label={m.settings_page_tool_calls()} detail={m.settings_subpage_rows({ n: rows('tool-calls') })} link={{ to: '/settings/chat/$page', params: { page: 'tool-calls' } }} />
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
      </> : page === 'tool-calls' ? <>
        {/* TAL-2341: the server applies each switch to the transcript; the Live Activity's sits in Notifications. */}
        <SettingsGroup id="tool-rows" title={m.settings_group_tool_rows()}>
          <Toggle label={m.settings_label_formatted_tool_results()} settingKey="formatted_tool_results" fallback />
          <Toggle label={m.settings_label_inline_tool_media()} settingKey="inline_tool_media" fallback />
          <Toggle label={m.settings_label_tool_row_outcomes()} settingKey="tool_row_outcomes" fallback />
          <Toggle label={m.settings_label_merge_repeated_tool_calls()} settingKey="merge_repeated_tool_calls" fallback />
          <Toggle label={m.settings_label_live_tool_progress()} settingKey="live_tool_progress" fallback />
          <Toggle label={m.settings_label_show_tool_lookups()} settingKey="show_tool_lookups" />
        </SettingsGroup>
        <SettingsGroup id="around-chat" title={m.settings_group_around_chat()}>
          <Toggle label={m.settings_label_status_chip_current_action()} settingKey="status_chip_current_action" fallback />
          <Toggle label={m.settings_label_turn_summary()} settingKey="turn_summary" fallback />
          {/* TAL-2022: the server writes an AI summary under each approval's command; off by default. */}
          <Toggle label={m.settings_label_explain_approvals()} settingKey="explain_approvals" />
        </SettingsGroup>
      </> : <>
        <SettingsGroup id="transcript-advanced" title={m.settings_group_transcript()}>
          <Toggle label={m.settings_label_busy_placeholder_hint()} hint={m.settings_desc_busy_placeholder_hint()} settingKey="show_busy_placeholder_hint" fallback />
          <Toggle label={m.settings_label_transparent_stream_event_timestamps()} hint={m.settings_desc_transparent_stream_event_timestamps()} settingKey="transparent_stream_event_timestamps" fallback />
          <Toggle label={m.settings_label_fade_text_effect()} settingKey="fade_text_effect" />
          <Toggle label={m.settings_label_token_speed()} settingKey="show_tps" />
          <Toggle label={m.settings_label_virtualize_transcript()} settingKey="virtualize_transcript" />
          <Toggle label={m.settings_label_session_endless_scroll()} settingKey="session_endless_scroll" fallback />
          {/* TAL-2160: refresh rewrites only generated titles, so it waits on the profile's title generation. */}
          <SettingSelect label={m.settings_label_auto_title_refresh()} id="settingsAutoTitleRefresh" settingKey="auto_title_refresh_every" fallback="0"
            {...(settings.data.auto_title_refresh_available === false ? { disabled: true, hint: m.settings_desc_auto_title_refresh_unavailable() } : {})} options={[
              { value: '0', label: m.settings_auto_title_refresh_off() },
              ...['5', '10', '20'].map((n) => ({ value: n, label: m.settings_auto_title_refresh_every({ n }) })),
            ]} />
        </SettingsGroup>
      </>}
    </div>
  )
}

/**
 * TAL-2160: how the composer sends. At phone width the composer always sends with Ctrl/Cmd+Enter, so the control is disabled
 * and shows that rule.
 */
function SendKeyRow() {
  const phone = useIsPhone()
  const modifier = modifierKey()
  return (
    <SettingSegmented icon={CornerDownLeft} label={m.settings_label_send_key()} id="settingsSendKey" settingKey="send_key" fallback="enter"
      {...(phone ? { disabled: true, value: 'ctrl+enter', hint: m.settings_send_key_phone_hint({ modifier }) } : {})} options={[
        { value: 'enter', label: m.settings_send_key_enter() },
        { value: 'ctrl+enter', label: m.settings_send_key_ctrl_enter({ modifier }) },
      ]} />
  )
}
