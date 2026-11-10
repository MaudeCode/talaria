import type { ReactNode } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { MAIN_VIEW } from '../../shell/AppShell'
import { PanelHead } from '../../shell/PanelHead'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { SETTINGS_SECTION_GROUPS, SettingsSectionGroupSchema, SettingsSectionSchema, type SettingsSection as Section, type SettingsSectionGroup } from '../../contracts/url'
import { useLocale } from '../../i18n/useLocale'
import { closeMobileSidebar } from '../../shell/useShellState'
import { useActiveProfileName } from '../../shell/ProfileMenu'
import { SectionHeader } from '../../ui/List'
import { MessageSquare, AudioLines, Bell, SunMedium, PanelLeft, Cpu, KeyRound, Wrench, Puzzle, Lock, Server, Info, UserRound, FolderOpen, FileText, type LucideIcon } from 'lucide-react'

const SECTION_ICON: Record<Section, LucideIcon> = {
  appearance: SunMedium, chat: MessageSquare, navigation: PanelLeft, notifications: Bell, speech: AudioLines,
  models: Cpu, providers: KeyRound, tools: Wrench,
  profiles: UserRound, workspaces: FolderOpen, extensions: Puzzle, access: Lock, system: Server, logs: FileText, about: Info,
}

export const SECTION_LABEL: Record<Section, () => string> = {
  appearance: () => m.settings_section_appearance_title(),
  chat: () => m.settings_section_chat_title(),
  navigation: () => m.settings_section_navigation_title(),
  notifications: () => m.settings_section_notifications_title(),
  speech: () => m.settings_section_speech_title(),
  models: () => m.settings_section_models_title(),
  providers: () => m.settings_section_providers_title(),
  tools: () => m.settings_section_tools_title(),
  profiles: () => m.tab_profiles(),
  workspaces: () => m.tab_workspaces(),
  extensions: () => m.settings_section_extensions_title(),
  access: () => m.settings_section_access_title(),
  system: () => m.settings_section_system_title(),
  logs: () => m.tab_logs(),
  about: () => m.settings_section_about_title(),
}

const GROUP_LABEL: Record<SettingsSectionGroup, () => string> = {
  interface: () => m.settings_menu_group_interface(),
  profile: () => m.settings_menu_group_profile(),
  server: () => m.settings_menu_group_server(),
}

/** TAL-2100: each group with its sections, both in contract order. */
const GROUPS = SettingsSectionGroupSchema.options.map((group) => ({ group, sections: SettingsSectionSchema.options.filter((section) => SETTINGS_SECTION_GROUPS[section] === group) }))

export function SectionMenu() {
  useLocale()
  const params: { section?: string } = useParams({ strict: false })
  const profile = useActiveProfileName()
  return (
    <div className="panel-view active" id="panelSettings">
      <PanelHead title={m.tab_settings()} />
      <nav className="side-menu flex flex-col gap-px p-2 overflow-visible min-h-0" id="settingsMenu" aria-label={m.tab_settings()}>
        <div className="settings-menu-items flex flex-col gap-4 min-h-0 flex-1 overflow-y-auto">
          {GROUPS.map(({ group, sections }) => (
            <div key={group} role="group" aria-labelledby={`settingsGroup-${group}`} data-settings-group={group} className="flex flex-col gap-0.5">
              <SectionHeader className="px-2.5 pb-1" detail={group === 'profile' && profile ? <Link to="/settings/$section" params={{ section: 'profiles' }} search={{ name: profile }} onClick={closeMobileSidebar} data-settings-profile-link="" className="hover:text-text hover:underline">{profile}</Link> : undefined}><span id={`settingsGroup-${group}`}>{GROUP_LABEL[group]()}</span></SectionHeader>
              {sections.map((section) => {
                const active = params.section === section
                const Icon = SECTION_ICON[section]
                return (
                  <Link key={section} to="/settings/$section" params={{ section }} onClick={closeMobileSidebar} aria-current={active ? 'page' : undefined} className={cn('side-menu-item flex w-full items-center gap-2 px-2.5 py-[7px] rounded-(--r-sm) border-0 bg-transparent text-text cursor-pointer text-left text-[13px] font-medium transition-[background,color] duration-(--dur) ease-(--ease) hover:bg-hover [&.active]:bg-(--menu-active-bg) [&.active]:text-(--menu-active-fg) [&.active]:shadow-(--menu-active-shadow) [&.active]:[font-weight:var(--menu-active-weight)] [&_svg]:shrink-0 [&_svg]:size-4 [&_svg]:opacity-90 [&.active_svg]:text-(--menu-active-fg)', active && 'active')} data-settings-section={section}>
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                    <span>{SECTION_LABEL[section]()}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}

export function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className={MAIN_VIEW + ' active'} id="mainSettings">{children}</div>
}
