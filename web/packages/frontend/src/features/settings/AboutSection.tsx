import { BookOpen, LifeBuoy, MessageSquareText, PanelLeft, Settings, Sparkles, SquarePen, TextCursorInput } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { useSetting } from '../../app/queries'
import { Keys, modifierKey } from '../../ui/Keys'
import { openWhatsNew, useWhatsNewState } from '../whats-new/WhatsNew'
import { openFeedback } from './FeedbackDialog'
import { SettingLink, SettingValue, SettingValues, SettingsGroup, SettingsStats, SETTINGS_PAGE, type SettingsStat } from './SettingsGroup'

const SHORTCUTS = [
  { label: m.help_shortcut_new_chat, icon: SquarePen, key: 'K' },
  { label: m.help_shortcut_sidebar, icon: PanelLeft, key: 'B' },
  { label: m.help_shortcut_composer, icon: TextCursorInput, key: '/' },
  { label: m.help_shortcut_settings, icon: Settings, key: ',' },
] as const

/** TAL-1691, TAL-2081, TAL-2146: Settings > About, the installed versions as figures, help links and shortcuts as keycaps. */
export function AboutSection() {
  const mod = modifierKey()
  const web = useSetting('webui_version')
  const agent = useSetting('agent_version')
  const whatsNew = useWhatsNewState().state?.announcement
  const versions: SettingsStat[] = [
    ...(web ? [{ id: 'webui-version', label: 'Talaria Web', value: web }] : []),
    ...(agent ? [{ id: 'agent-version', label: 'Hermes Agent', value: agent }] : []),
  ]
  return (
    <div className={SETTINGS_PAGE} data-section="about">
      {versions.length > 0 && <SettingsStats label={m.settings_group_versions()} stats={versions} />}
      <SettingsGroup id="help" title={m.settings_group_help()}>
        {whatsNew && <SettingLink label={m.whats_new_open()} icon={Sparkles} onClick={openWhatsNew} />}
        <SettingLink label="README" icon={BookOpen} href="https://github.com/MaudeCode/talaria/blob/main/web/README.md" />
        <SettingLink label="Troubleshooting" icon={LifeBuoy} href="https://github.com/MaudeCode/talaria/blob/main/web/docs/troubleshooting.md" />
        <SettingLink label={m.feedback_send_open()} icon={MessageSquareText} onClick={openFeedback} />
      </SettingsGroup>
      <SettingsGroup id="shortcuts" title={m.help_shortcuts()}>
        <SettingValues>
          {SHORTCUTS.map((s) => <SettingValue key={s.key} label={s.label()} icon={s.icon}><Keys keys={[mod, s.key]} /></SettingValue>)}
        </SettingValues>
      </SettingsGroup>
    </div>
  )
}
