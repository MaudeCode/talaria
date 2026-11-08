import { lazy, Suspense, type ReactNode } from 'react'
import type { AgentTab, SettingsSection as Section } from '../../contracts/url'
import { SECTION_LABEL } from './SettingsLayout'
import { LoadingState } from '../../ui/States'
import { useLocale } from '../../i18n/useLocale'

const AppearanceSection = lazy(() => import('./AppearanceSection').then((module) => ({ default: module.AppearanceSection })))
const ChatSection = lazy(() => import('./ChatSection').then((module) => ({ default: module.ChatSection })))
const SidebarSection = lazy(() => import('./SidebarSection').then((module) => ({ default: module.SidebarSection })))
const ModelsSection = lazy(() => import('./ModelsSection').then((module) => ({ default: module.ModelsSection })))
const NotificationsSection = lazy(() => import('./NotificationsSection').then((module) => ({ default: module.NotificationsSection })))
const SpeechSection = lazy(() => import('./SpeechSection').then((module) => ({ default: module.SpeechSection })))
const AgentSection = lazy(() => import('./AgentSection').then((module) => ({ default: module.AgentSection })))
const SystemSection = lazy(() => import('./SystemSection').then((module) => ({ default: module.SystemSection })))
const AboutSection = lazy(() => import('./AboutSection').then((module) => ({ default: module.AboutSection })))

/** `tab` and `onTabChange` reach the one section with tabs, Agent. */
interface SectionProps { tab?: AgentTab | undefined; onTabChange?: ((tab: AgentTab) => void) | undefined }

const SECTIONS: Partial<Record<Section, (props: SectionProps) => ReactNode>> = {
  appearance: () => <AppearanceSection />,
  chat: () => <ChatSection />,
  sidebar: () => <SidebarSection />,
  models: () => <ModelsSection />,
  notifications: () => <NotificationsSection />,
  speech: () => <SpeechSection />,
  agent: (props) => <AgentSection {...props} />,
  system: () => <SystemSection />,
  about: () => <AboutSection />,
}

export function registerSettingsSection(section: Section, render: (props: SectionProps) => ReactNode): void {
  SECTIONS[section] = render
}

export function SettingsSection({ section, ...props }: { section: Section } & SectionProps) {
  useLocale()
  const render = SECTIONS[section]
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="settings-main w-full max-w-[820px] mx-auto min-w-0 pt-6 px-7 pb-12 max-[769px]:pt-4 max-[769px]:px-3.5 max-[769px]:pb-10">
        <div className="settings-section-head flex items-start justify-between gap-4 mb-5 pb-3.5 border-b border-border max-[769px]:flex-col">
          <div>
            <h1 className="settings-section-title text-[18px] font-semibold tracking-(--heading-tracking) text-text leading-[1.3] mb-1">{SECTION_LABEL[section]()}</h1>
          </div>
        </div>
        <Suspense fallback={<LoadingState compact />}>{render ? render(props) : <LoadingState compact />}</Suspense>
      </div>
    </div>
  )
}
