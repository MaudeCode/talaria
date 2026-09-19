import { m } from '../../paraglide/messages.js'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'

function Toggle({ label, hint, settingKey, fallback = false }: { label: string; hint?: string; settingKey: string; fallback?: boolean }) {
  const { bool, set } = useSettingField()
  const id = `settings-${settingKey}`
  return (
    <FieldRow label={label} htmlFor={id} {...(hint ? { hint } : {})} inline>
      <Switch id={id} checked={bool(settingKey, fallback)} onCheckedChange={(checked) => set({ [settingKey]: checked })} />
    </FieldRow>
  )
}

export function ConversationSection() {
  const { settings, str, set, num } = useSettingField()
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  return (
    <div className="flex flex-col divide-y divide-border-subtle" data-section="conversation">
      <FieldRow label={m.settings_label_chat_activity_display_mode()} htmlFor="settingsChatActivityDisplayMode" inline>
        <Select id="settingsChatActivityDisplayMode" value={str('chat_activity_display_mode', 'compact_worklog')} onValueChange={(v) => set({ chat_activity_display_mode: v })}>
          <option value="compact_worklog">{m.settings_option_compact_worklog()}</option>
          <option value="transparent_stream">{m.settings_option_transparent_stream()}</option>
          <option value="hide_all_activity">{m.settings_option_hide_all_activity()}</option>
        </Select>
      </FieldRow>
      <Toggle label={m.settings_label_transparent_stream_event_timestamps()} hint={m.settings_desc_transparent_stream_event_timestamps()} settingKey="transparent_stream_event_timestamps" fallback />
      <Toggle label={m.settings_label_worklog_details_expanded_default()} settingKey="worklog_details_expanded_default" />
      <Toggle label={m.settings_label_auto_scroll_follow()} hint={m.settings_desc_auto_scroll_follow()} settingKey="auto_scroll_follow" fallback />
      <Toggle label={m.settings_label_render_user_markdown()} hint={m.settings_desc_render_user_markdown()} settingKey="render_user_markdown" />
      <Toggle label={m.settings_label_large_text_paste_as_attachment()} settingKey="large_text_paste_as_attachment" fallback />
      <Toggle label={m.settings_label_fade_text_effect()} settingKey="fade_text_effect" fallback />
      <Toggle label={m.settings_label_virtualize_transcript()} settingKey="virtualize_transcript" />
      <FieldRow label={m.settings_label_default_message_mode()} htmlFor="settingsDefaultMessageMode" inline>
        <Select id="settingsDefaultMessageMode" value={str('default_message_mode', 'steer')} onValueChange={(v) => set({ default_message_mode: v })}>
          <option value="steer">{m.settings_default_message_mode_steer()}</option>
          <option value="queue">{m.settings_default_message_mode_queue()}</option>
          <option value="interrupt">{m.settings_default_message_mode_interrupt()}</option>
        </Select>
      </FieldRow>
      <Toggle label={m.settings_label_busy_placeholder_hint()} hint={m.settings_desc_busy_placeholder_hint()} settingKey="show_busy_placeholder_hint" fallback />
      <FieldRow label={m.settings_label_structured_code()} htmlFor="settingsStructuredCodeMode" inline>
        <Select id="settingsStructuredCodeMode" value={str('structured_code_default_view', 'auto')} onValueChange={(v) => set({ structured_code_default_view: v })}>
          <option value="auto">{m.settings_option_structured_code_auto()}</option>
          <option value="tree">{m.settings_option_structured_code_tree()}</option>
          <option value="raw">{m.settings_option_structured_code_raw()}</option>
        </Select>
      </FieldRow>
      <FieldRow label={m.settings_label_structured_code_auto_lines()} htmlFor="settingsStructuredCodeAutoLines" inline>
        <TextInput id="settingsStructuredCodeAutoLines" type="number" min={1} max={500} className="w-20" value={num('structured_code_auto_tree_lines', 40)} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n > 0) set({ structured_code_auto_tree_lines: n }) }} />
      </FieldRow>
      <FieldRow label={m.settings_label_max_tokens()} htmlFor="settingsMaxTokens" inline>
        <TextInput id="settingsMaxTokens" type="number" min={1} className="w-28" placeholder={m.settings_placeholder_max_tokens_none()} value={num('max_tokens', 0) || ''} onChange={(e) => { const raw = e.target.value.trim(); if (raw === '') set({ max_tokens: null }); else { const n = Number(raw); if (Number.isInteger(n) && n > 0) set({ max_tokens: n }) } }} />
      </FieldRow>
      <FieldRow label={m.settings_label_auto_title_refresh()} htmlFor="settingsAutoTitleRefresh" inline>
        <Select id="settingsAutoTitleRefresh" value={str('auto_title_refresh_every', '0')} onValueChange={(v) => set({ auto_title_refresh_every: v })}>
          <option value="0">{m.settings_auto_title_refresh_off()}</option>
          <option value="5">5</option><option value="10">10</option><option value="20">20</option>
        </Select>
      </FieldRow>
    </div>
  )
}
