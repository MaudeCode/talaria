import { Link, useLocation } from '@tanstack/react-router'
import { m } from '../paraglide/messages.js'
import { useBootstrap } from '../app/bootstrap'
import { useDashboardStatusQuery, useSettingsQuery } from '../app/queries'
import { cn } from '../ui/cn'
import { DASHBOARD_ICON, orderedNav, panelForPath } from './nav'
import { readHiddenTabs, readTabOrder, toggleSidebarCollapsed, useIsDesktop } from './useShellState'
import { useNewChat } from '../features/sessions/useNewChat'
import { useLocale } from '../i18n/useLocale'
import { useExtensionManifests } from '../extensions/registry'
import { Puzzle } from 'lucide-react'
import { Brandmark } from './Brandmark'

/**
 * Desktop primary navigation. Markup and class names follow the legacy shell
 * (`.rail > .rail-brand + .rail-btn.has-tooltip`): the stylesheet
 * renders each button's label from `data-tooltip` beneath its icon.
 */
// Legacy rail buttons also carried `.nav-tab`; `.rail .nav-tab` then zeroed the padding and unhid overflow. Those
// effective values are the utilities here, so the class is no longer needed on the rail.
const RAIL_BTN = 'rail-btn has-tooltip relative flex w-[54px] h-auto min-h-12 flex-none flex-col items-center justify-center gap-[3px] rounded-(--rail-btn-radius) border-0 bg-transparent text-muted cursor-pointer p-0 overflow-visible whitespace-nowrap text-center transition-[color,background] duration-(--dur) ease-(--ease) hover:text-text hover:bg-hover [&.active]:text-(--rail-active-fg) [&.active]:bg-(--rail-active-bg) [&.active]:shadow-(--rail-active-shadow) [&.active]:[font-weight:var(--rail-active-weight)] [&.active_svg]:text-(--rail-active-icon-fg) [&_svg]:size-[18px]'

export function Rail() {
  useLocale()
  const location = useLocation()
  const settings = useSettingsQuery()
  const bootstrap = useBootstrap()
  const dashboard = useDashboardStatusQuery(bootstrap.features.dashboard)
  const newChat = useNewChat()
  const manifests = useExtensionManifests(bootstrap.features.extensions || true)
  const extNav = (manifests.data?.manifests ?? []).filter((e) => e.enabled && e.panel && e.nav)
  const hidden = settings.data?.hidden_tabs ?? readHiddenTabs()
  const { visible } = orderedNav(readTabOrder(), hidden)
  const current = panelForPath(location.pathname)
  const isDesktop = useIsDesktop()
  // Clicking the tab that is already active toggles the sidebar instead of re-navigating (desktop only; phones use the drawer).
  const onActiveClick = (e: React.MouseEvent) => { if (isDesktop) { e.preventDefault(); toggleSidebarCollapsed() } }
  const DashboardIcon = DASHBOARD_ICON
  const settingsItem = visible.find((i) => i.id === 'settings')
  const mainItems = visible.filter((i) => i.id !== 'settings')
  return (
    <nav className="rail relative hidden min-[641px]:flex w-16 shrink-0 flex-col items-center gap-0.5 py-2 px-0 bg-(--rail-bg) border-r border-border [backdrop-filter:var(--chrome-backdrop)] border-0" aria-label="Primary navigation">
      <button type="button" className="rail-brand flex w-[52px] h-11 items-center justify-center mb-1.5 border-0 bg-transparent rounded-(--r-md) cursor-pointer transition-[background] duration-(--dur) ease-(--ease) hover:bg-hover" aria-label={m.new_conversation()} onClick={() => { void newChat() }}>
        <Brandmark className="brandmark rail-brandmark" />
      </button>
      {mainItems.map((item) => {
        const Icon = item.icon
        const active = current === item.id
        return (
          <Link key={item.id} to={item.to} className={cn(RAIL_BTN, active && 'active')} data-tooltip={item.label()} aria-label={item.label()} aria-current={active ? 'page' : undefined} data-panel={item.id} onClick={active ? onActiveClick : undefined}>
            <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
          </Link>
        )
      })}
      {extNav.map((e) => {
        const active = location.pathname.startsWith(`/ext/${e.id}`)
        const label = e.nav?.label ?? e.name
        return (
          <Link key={e.id} to="/ext/$extensionId" params={{ extensionId: e.id }} className={cn(RAIL_BTN, active && 'active')} data-tooltip={label} aria-label={label} aria-current={active ? 'page' : undefined} data-extension={e.id}>
            <Puzzle size={20} strokeWidth={1.5} aria-hidden="true" />
          </Link>
        )
      })}
      {dashboard.data?.running && (dashboard.data.browser_url ?? dashboard.data.url) && (
        <a href={dashboard.data.browser_url ?? dashboard.data.url} target="_blank" rel="noopener noreferrer" className={cn(RAIL_BTN, 'dashboard-link')} data-tooltip={m.tab_dashboard()} aria-label={m.tab_dashboard()}>
          <DashboardIcon size={20} strokeWidth={1.5} aria-hidden="true" />
        </a>
      )}
      <div className="rail-spacer flex-1 min-h-2" />
      <span className="seam seam-tr rail-seam" aria-hidden="true" />
      <span className="seam seam-br rail-seam" aria-hidden="true" />
      {settingsItem && (
        <Link to={settingsItem.to} className={cn(RAIL_BTN, current === 'settings' && 'active')} data-tooltip={settingsItem.label()} aria-label={settingsItem.label()} aria-current={current === 'settings' ? 'page' : undefined} data-panel="settings">
          <settingsItem.icon size={20} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      )}
    </nav>
  )
}
