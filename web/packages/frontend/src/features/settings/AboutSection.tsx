import { m } from '../../paraglide/messages.js'
import { useSetting } from '../../app/queries'
import { openWhatsNew, useWhatsNewState } from '../whats-new/WhatsNew'
import { openFeedback } from './FeedbackDialog'
import { SettingLink, SettingValue, SettingValues, SettingsGroup } from './SettingsRows'

/** TAL-1691, TAL-2081: Settings > About, the installed versions, What's New, help links and shortcuts. */
export function AboutSection() {
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'
  const web = useSetting('webui_version')
  const agent = useSetting('agent_version')
  const whatsNew = useWhatsNewState().state?.announcement
  return (
    <div className="flex flex-col gap-7" data-section="about">
      {(web || agent) && (
        <SettingsGroup id="versions" title={m.settings_group_versions()}>
          <SettingValues>
            {web && <SettingValue label="Talaria Web"><span className="font-mono tabular-nums" data-testid="webui-version">{web}</span></SettingValue>}
            {agent && <SettingValue label="Hermes Agent"><span className="font-mono tabular-nums" data-testid="agent-version">{agent}</span></SettingValue>}
          </SettingValues>
        </SettingsGroup>
      )}
      {whatsNew && (
        <SettingsGroup id="whats-new" title={m.whats_new_open()}>
          <SettingLink label={m.whats_new_title()} onClick={openWhatsNew} />
        </SettingsGroup>
      )}
      <SettingsGroup id="help" title={m.settings_group_help()}>
        <SettingLink label="README" href="https://github.com/MaudeCode/talaria/blob/main/web/README.md" />
        <SettingLink label="Troubleshooting" href="https://github.com/MaudeCode/talaria/blob/main/web/docs/troubleshooting.md" />
        <SettingLink label={m.feedback_send_open()} onClick={openFeedback} />
      </SettingsGroup>
      <SettingsGroup id="shortcuts" title={m.help_shortcuts()}>
        <SettingValues>
          <SettingValue label={m.help_shortcut_new_chat()}><kbd className="font-mono">{mod}+K</kbd></SettingValue>
          <SettingValue label={m.help_shortcut_sidebar()}><kbd className="font-mono">{mod}+B</kbd></SettingValue>
          <SettingValue label={m.help_shortcut_composer()}><kbd className="font-mono">{mod}+/</kbd></SettingValue>
          <SettingValue label={m.help_shortcut_settings()}><kbd className="font-mono">{mod}+,</kbd></SettingValue>
        </SettingValues>
      </SettingsGroup>
    </div>
  )
}
