import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ToolsTab, SettingsSection as Section } from '../../contracts/url'
import { SECTION_LABEL } from './SettingsLayout'
import { SETTINGS_INDEX, type SettingsPage } from './settingsIndex'
import { LoadingState } from '../../ui/States'
import { cn } from '../../ui/cn'
import { useLocale } from '../../i18n/useLocale'
import { HubHeadSlotsContext } from '../../shell/hubHeadSlots'
import { SETTINGS_TITLE } from './SettingsGroup'

const AppearanceSection = lazy(() => import('./AppearanceSection').then((module) => ({ default: module.AppearanceSection })))
const ChatSection = lazy(() => import('./ChatSection').then((module) => ({ default: module.ChatSection })))
const ChatSubPage = lazy(() => import('./ChatSection').then((module) => ({ default: module.ChatSubPage })))
const SidebarSection = lazy(() => import('./SidebarSection').then((module) => ({ default: module.SidebarSection })))
const ModelsSection = lazy(() => import('./ModelsSection').then((module) => ({ default: module.ModelsSection })))
const ProvidersPage = lazy(() => import('./ProvidersSection').then((module) => ({ default: module.ProvidersPage })))
const ProviderDetail = lazy(() => import('./ProviderDetail').then((module) => ({ default: module.ProviderDetail })))
const QuotaAlertsPage = lazy(() => import('./QuotaAlerts').then((module) => ({ default: module.QuotaAlertsPage })))
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

/**
 * `tab` and `onTabChange` reach the one section with tabs, Tools; `name` the profile Profiles shows in detail; `providerId` the
 * provider Providers shows on its own page (TAL-2135); `page` a page under the section with its own title (TAL-2136, TAL-2138).
 */
interface SectionProps { tab?: ToolsTab | undefined; onTabChange?: ((tab: ToolsTab) => void) | undefined; name?: string | undefined; providerId?: string | undefined; page?: SettingsPage | undefined }
/** `row` is the URL's `#<row id>` and `visit` the navigation that set it. */
interface RevealProps { row?: string | undefined; visit?: string | undefined }

const SECTIONS: Partial<Record<Section, (props: SectionProps) => ReactNode>> = {
  appearance: () => <AppearanceSection />,
  chat: ({ page }) => page === undefined || page === 'quota-alerts' ? <ChatSection /> : <ChatSubPage page={page} />,
  navigation: () => <SidebarSection />,
  notifications: () => <NotificationsSection />,
  speech: () => <SpeechSection />,
  models: () => <ModelsSection />,
  providers: ({ providerId, page }) => page === 'quota-alerts' ? <QuotaAlertsPage /> : providerId === undefined ? <ProvidersPage /> : <ProviderDetail id={providerId} />,
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

/** A picker grid or segmented control focuses its chosen option; a Switch's id is on its hidden input, so the switch beside it takes focus. */
function focusTarget(element: HTMLElement): HTMLElement | null {
  const role = element.getAttribute('role')
  if (role === 'group' || role === 'radiogroup') return element.querySelector<HTMLElement>('[aria-pressed="true"], [aria-checked="true"]') ?? element.querySelector<HTMLElement>('button')
  if (element.tabIndex < 0) return element.parentElement?.querySelector<HTMLElement>('[role="switch"]') ?? null
  return element
}

/**
 * TAL-2086: the URL's `#<row id>` scrolls that row into view and focuses its control. Sections load lazily and rows wait
 * for their data, so it watches the page until the row appears. A row shown only under a condition first lands on the
 * control that shows it (`shownWith`), else its group, and moves on to the row if it appears while focus is still there.
 * `visit` changes with each navigation, so choosing the same row again reveals it again.
 */
function useRevealRow(page: RefObject<HTMLElement | null>, id: string | undefined, visit: string | undefined) {
  useEffect(() => {
    const root = page.current
    if (!id || !root) return
    const entry = SETTINGS_INDEX.find((e) => e.id === id)
    const control = (target: string) => {
      const element = document.getElementById(target)
      return element && root.contains(element) ? focusTarget(element) : null
    }
    const group = () => entry ? [...root.querySelectorAll<HTMLElement>('section[data-group]')].find((s) => s.getAttribute('aria-label') === entry.group()) ?? null : null
    let landed: HTMLElement | null = null
    const show = (element: HTMLElement) => {
      element.scrollIntoView?.({ block: 'center' })
      element.focus({ preventScroll: true })
      landed = element
    }
    const reveal = () => {
      const row = control(id)
      // Focus the user moved elsewhere since landing stays where they put it.
      if (row) { if (!landed || document.activeElement === landed || document.activeElement === document.body) show(row); return true }
      if (!landed) { const near = (entry?.shownWith ? control(entry.shownWith) : null) ?? group(); if (near) show(near) }
      return false
    }
    if (reveal()) return
    const observer = new MutationObserver(() => { if (reveal()) stop() })
    const timer = setTimeout(() => stop(), 10_000)
    const stop = () => { observer.disconnect(); clearTimeout(timer) }
    observer.observe(root, { childList: true, subtree: true })
    return stop
  }, [id, visit, page])
}

export function SettingsSection({ section, row, visit, ...props }: { section: Section } & SectionProps & RevealProps) {
  useLocale()
  const page = useRef<HTMLDivElement>(null)
  useRevealRow(page, row, visit)
  const render = SECTIONS[section]
  // TAL-2101: a hub page shown as a section (Profiles, Spaces, Logs) puts its help and actions in this heading.
  const [help, setHelp] = useState<HTMLElement | null>(null)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  return (
    <div ref={page} className="flex-1 min-h-0 overflow-y-auto" data-scroll-restoration-id="settings-main">
      {/* TAL-2131: the content column is 640px at most; Logs keeps the wide column its lines need. */}
      <div className={cn('settings-main w-full mx-auto min-w-0 pt-6 px-7 pb-12 max-[769px]:pt-4 max-[769px]:px-3.5 max-[769px]:pb-10', section === 'logs' ? 'max-w-[820px]' : 'max-w-[696px] max-[769px]:max-w-[668px]')}>
        {/* A provider's own page (TAL-2135) and a page under a section (TAL-2136) put their back link and title where the section title sits. */}
        {props.providerId === undefined && props.page === undefined && <div className="settings-section-head flex items-center justify-between gap-4 mb-5 pb-3.5 border-b border-border">
          <div ref={setHelp} className="flex min-w-0 items-center">
            <h1 className={SETTINGS_TITLE}>{SECTION_LABEL[section]()}</h1>
          </div>
          <div ref={setActions} className="main-view-actions flex items-center gap-1.5 shrink-0 empty:hidden" />
        </div>}
        <HubHeadSlotsContext.Provider value={{ help, actions }}>
          <Suspense fallback={<LoadingState compact />}>{render ? render(props) : <LoadingState compact />}</Suspense>
        </HubHeadSlotsContext.Provider>
      </div>
    </div>
  )
}
