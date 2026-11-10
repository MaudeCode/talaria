import { lazy, Suspense, useState, type ReactNode } from 'react'
import type { ToolsTab, SettingsSection as Section } from '../../contracts/url'
import { SECTION_LABEL } from './SettingsLayout'
import { LoadingState } from '../../ui/States'
import { useLocale } from '../../i18n/useLocale'
import { HubHeadSlotsContext } from '../../shell/AppShell'

const AppearanceSection = lazy(() => import('./AppearanceSection').then((module) => ({ default: module.AppearanceSection })))
const ChatSection = lazy(() => import('./ChatSection').then((module) => ({ default: module.ChatSection })))
const SidebarSection = lazy(() => import('./SidebarSection').then((module) => ({ default: module.SidebarSection })))
const ModelsSection = lazy(() => import('./ModelsSection').then((module) => ({ default: module.ModelsSection })))
const ProvidersPage = lazy(() => import('./ProvidersSection').then((module) => ({ default: module.ProvidersPage })))
const NotificationsSection = lazy(() => import('./NotificationsSection').then((module) => ({ default: module.NotificationsSection })))
const SpeechSection = lazy(() => import('./SpeechSection').then((module) => ({ default: module.SpeechSection })))
const ToolsSection = lazy(() => import('./ToolsSection').then((module) => ({ default: module.ToolsSection })))
const ExtensionsSection = lazy(() => import('./ExtensionsSection').then((module) => ({ default: module.ExtensionsSection })))
const AccessSection = lazy(() => import('./AccessSection').then((module) => ({ default: module.AccessSection })))
const SystemSection = lazy(() => import('./SystemSection').then((module) => ({ default: module.SystemSection })))
const ProfilesPage = lazy(() => import('../profiles/ProfilesPage').then((module) => ({ default: module.ProfilesPage })))
const WorkspacesPage = lazy(() => import('../workspaces/WorkspacesPage').then((module) => ({ default: module.WorkspacesPage })))
const LogsPage = lazy(() => import('../logs/LogsPage').then((module) => ({ default: module.LogsPage })))
const AboutSection = lazy(() => import('./AboutSection').then((module) => ({ default: module.AboutSection })))

/** `tab` and `onTabChange` reach the one section with tabs, Tools; `name` the profile Profiles shows in detail. */
interface SectionProps { tab?: ToolsTab | undefined; onTabChange?: ((tab: ToolsTab) => void) | undefined; name?: string | undefined }

const SECTIONS: Partial<Record<Section, (props: SectionProps) => ReactNode>> = {
  appearance: () => <AppearanceSection />,
  chat: () => <ChatSection />,
  navigation: () => <SidebarSection />,
  notifications: () => <NotificationsSection />,
  speech: () => <SpeechSection />,
  models: () => <ModelsSection />,
  providers: () => <ProvidersPage />,
  tools: (props) => <ToolsSection {...props} />,
  profiles: ({ name }) => <div data-section="profiles"><ProfilesPage name={name} /></div>,
  workspaces: () => <div data-section="workspaces"><WorkspacesPage /></div>,
  extensions: () => <div data-section="extensions"><ExtensionsSection /></div>,
  access: () => <AccessSection />,
  system: () => <SystemSection />,
  logs: () => <div data-section="logs"><LogsPage /></div>,
  about: () => <AboutSection />,
}

export function registerSettingsSection(section: Section, render: (props: SectionProps) => ReactNode): void {
  SECTIONS[section] = render
}

export function SettingsSection({ section, ...props }: { section: Section } & SectionProps) {
  useLocale()
  const render = SECTIONS[section]
  // TAL-2101: a hub page shown as a section (Profiles, Spaces, Logs) puts its help and actions in this heading.
  const [help, setHelp] = useState<HTMLElement | null>(null)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="settings-main w-full max-w-[820px] mx-auto min-w-0 pt-6 px-7 pb-12 max-[769px]:pt-4 max-[769px]:px-3.5 max-[769px]:pb-10">
        <div className="settings-section-head flex items-center justify-between gap-4 mb-5 pb-3.5 border-b border-border">
          <div ref={setHelp} className="flex min-w-0 items-center">
            <h1 className="settings-section-title text-[18px] font-semibold tracking-(--heading-tracking) text-text leading-[1.3] mb-1">{SECTION_LABEL[section]()}</h1>
          </div>
          <div ref={setActions} className="main-view-actions flex items-center gap-1.5 shrink-0 empty:hidden" />
        </div>
        <HubHeadSlotsContext.Provider value={{ help, actions }}>
          <Suspense fallback={<LoadingState compact />}>{render ? render(props) : <LoadingState compact />}</Suspense>
        </HubHeadSlotsContext.Provider>
      </div>
    </div>
  )
}
