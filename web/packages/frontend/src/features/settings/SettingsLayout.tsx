import type { ReactNode } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { MAIN_VIEW } from '../../shell/AppShell'
import { PanelHead } from '../../shell/PanelHead'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { SettingsSectionSchema, type SettingsSection as Section } from '../../contracts/url'
import { useLocale } from '../../i18n/useLocale'
import { closeMobileSidebar } from '../../shell/useShellState'
import { MessageSquare, AudioLines, Bell, SunMedium, PanelLeft, Cpu, Bot, Server, Info, type LucideIcon } from 'lucide-react'

const SECTION_ICON: Record<Section, LucideIcon> = { appearance: SunMedium, chat: MessageSquare, sidebar: PanelLeft, models: Cpu, notifications: Bell, speech: AudioLines, agent: Bot, system: Server, about: Info }

export const SECTION_LABEL: Record<Section, () => string> = {
  appearance: () => m.settings_section_appearance_title(),
  chat: () => m.settings_section_chat_title(),
  sidebar: () => m.settings_section_sidebar_title(),
  models: () => m.settings_section_models_title(),
  notifications: () => m.settings_section_notifications_title(),
  speech: () => m.settings_section_speech_title(),
  agent: () => m.settings_section_agent_title(),
  system: () => m.settings_section_system_title(),
  about: () => m.settings_section_about_title(),
}

export function SectionMenu() {
  useLocale()
  const params: { section?: string } = useParams({ strict: false })
  return (
    <div className="panel-view active" id="panelSettings">
      <PanelHead title={m.tab_settings()} />
      <nav className="side-menu flex flex-col gap-px p-2 overflow-visible min-h-0" id="settingsMenu" aria-label={m.tab_settings()}>
        <div className="settings-menu-items flex flex-col gap-0.5 min-h-0 flex-1 overflow-y-auto">
          {SettingsSectionSchema.options.map((section) => {
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
      </nav>
    </div>
  )
}

export function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className={MAIN_VIEW + ' active'} id="mainSettings">{children}</div>
}
