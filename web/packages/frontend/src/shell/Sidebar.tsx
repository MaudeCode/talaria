import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronLeft, ChevronRight, Menu as MenuIcon, MessageSquareWarning, Puzzle, Search, SquarePen, X, type LucideIcon } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { useBootstrap } from '../app/bootstrap'
import { useDashboardStatusQuery, useSetting } from '../app/queries'
import { useExtensionManifests } from '../extensions/registry'
import { UpdateNotificationCenterButton } from '../features/notifications/UpdateNotificationCenter'
import { useNewChat } from '../features/sessions/useNewChat'
import { openFeedback } from '../features/settings/FeedbackDialog'
import { useLocale } from '../i18n/useLocale'
import { readPersisted, writePersisted } from '../lib/persisted'
import { cn } from '../ui/cn'
import { Brandmark } from './Brandmark'
import { PANEL_HEAD_BTN } from './PanelHead'
import { DASHBOARD_ICON, SIDEBAR_MORE, SIDEBAR_PRIMARY, SIDEBAR_RAIL_GROUPS, SIDEBAR_ROW, orderedNav, panelForPath, type SidebarSlot } from './nav'
import { closeMobileSidebar, readHiddenTabs, readTabOrder, requestSessionSearch, setSidebarWidth, settingsBackHref, toggleMobileSidebar, toggleSidebarCollapsed, useIsDesktop, useIsSettings, useIsSidebarRail, useIsTiled, useShellState } from './useShellState'

const MORE_OPEN_KEY = 'hermes-webui-sidebar-more-open'
const ICON_PROPS = { size: 18, strokeWidth: 1.5, 'aria-hidden': true } as const

function SidebarRowContent({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return <><Icon {...ICON_PROPS} /><span className="sidebar-row-label min-w-0 truncate">{label}</span></>
}

/**
 * The destinations, the page's panel and the footer, as labelled rows and as the icon rail. From 641px both layers stay
 * mounted so `shell.css` can fade one out and the other in; only the one showing carries `data-panel` and `data-extension`,
 * so each destination has one.
 */
function SidebarNav({ panel }: { panel: ReactNode }) {
  useLocale()
  const rail = useIsSidebarRail()
  const isDesktop = useIsDesktop()
  const isTiled = useIsTiled()
  const current = useLocation({ select: (location) => panelForPath(location.pathname) })
  const extensionPath = useLocation({ select: (location) => location.pathname.startsWith('/ext/') ? location.pathname : null })
  const hiddenTabs = useSetting('hidden_tabs')
  const showsFeedback = useSetting('show_sidebar_feedback') === true
  const bootstrap = useBootstrap()
  const dashboard = useDashboardStatusQuery(bootstrap.features.dashboard)
  const newChat = useNewChat()
  const manifests = useExtensionManifests(bootstrap.features.extensions || true)
  const extensions = (manifests.data?.manifests ?? []).filter((e) => e.enabled && (e.panel || e.native_view) && e.nav)
  const { visible } = orderedNav(readTabOrder(), hiddenTabs ?? readHiddenTabs())
  const dashboardUrl = dashboard.data?.running ? (dashboard.data.browser_url ?? dashboard.data.url) : undefined
  const [moreStored, setMoreStored] = useState(() => readPersisted(MORE_OPEN_KEY) === '1')

  const destinationRow = (id: string, live: boolean) => {
    const item = visible.find((i) => i.id === id)
    if (!item) return []
    const active = current === item.id && !extensionPath
    return [<Link key={item.id} to={item.to} className={cn(SIDEBAR_ROW, active && 'active')} aria-label={item.label()} aria-current={active ? 'page' : undefined} data-panel={live ? item.id : undefined} onClick={closeMobileSidebar}><SidebarRowContent icon={item.icon} label={item.label()} /></Link>]
  }
  const rowsFor = (slots: readonly SidebarSlot[], live: boolean) => slots.flatMap((slot) => {
    if (slot === 'dashboard') return dashboardUrl ? [<a key={slot} href={dashboardUrl} target="_blank" rel="noopener noreferrer" className={cn(SIDEBAR_ROW, 'dashboard-link')} aria-label={m.tab_dashboard()} onClick={closeMobileSidebar}><SidebarRowContent icon={DASHBOARD_ICON} label={m.tab_dashboard()} /></a>] : []
    if (slot !== 'extensions') return destinationRow(slot, live)
    return extensions.map((e) => {
      const active = extensionPath?.startsWith(`/ext/${e.id}`)
      const label = e.nav?.label ?? e.name
      return <Link key={e.id} to="/ext/$extensionId" params={{ extensionId: e.id }} className={cn(SIDEBAR_ROW, active && 'active')} aria-label={label} aria-current={active ? 'page' : undefined} data-extension={live ? e.id : undefined} onClick={closeMobileSidebar}><SidebarRowContent icon={Puzzle} label={label} /></Link>
    })
  })
  const moreRows = rowsFor(SIDEBAR_MORE, !rail)
  const insideMore = !!extensionPath || SIDEBAR_MORE.includes(current)
  const moreOpen = moreStored || insideMore
  const toggleMore = () => { const next = !moreStored; writePersisted(MORE_OPEN_KEY, next ? '1' : '0'); setMoreStored(next) }
  const searchRow = <button type="button" className={SIDEBAR_ROW} aria-label={m.search()} onClick={requestSessionSearch}><SidebarRowContent icon={Search} label={m.search()} /></button>
  const feedbackRow = showsFeedback && <button key="feedback" type="button" className={cn(SIDEBAR_ROW, 'sidebar-icon-row has-tooltip')} data-panel="feedback" data-tooltip={m.feedback_rail_label()} aria-label={m.feedback_send_open()} onClick={openFeedback}><SidebarRowContent icon={MessageSquareWarning} label={m.feedback_rail_label()} /></button>
  const bell = <UpdateNotificationCenterButton key="notifications" placement="sidebar" />

  const brand = (
    <button type="button" className="sidebar-brand flex h-11 w-full flex-none items-center gap-2.5 rounded-(--r-md) border-0 bg-transparent px-2 text-left text-sm font-semibold text-text cursor-pointer transition-[background] duration-(--dur) ease-(--ease) hover:bg-hover" aria-label={m.new_conversation()} onClick={() => { void newChat() }}>
      <Brandmark className="brandmark sidebar-brandmark" />
      <span className="sidebar-row-label min-w-0 truncate">{bootstrap.bot_name}</span>
    </button>
  )

  return (
    <nav className="sidebar-primary flex min-h-0 flex-1 flex-col" aria-label="Primary navigation">
      <div className="sidebar-content flex min-h-0 flex-1 flex-col min-[641px]:p-(--island-gap)" inert={rail}>
        <div className="sidebar-rows flex min-h-0 flex-col gap-0.5">
          {brand}
          <button type="button" className={SIDEBAR_ROW} id="btnNewChat" aria-label={m.sidebar_new_chat()} onClick={() => { void newChat() }}><SidebarRowContent icon={SquarePen} label={m.sidebar_new_chat()} /></button>
          {searchRow}
          <span className="h-2 flex-none" aria-hidden="true" />
          {rowsFor(SIDEBAR_PRIMARY, !rail)}
          {moreRows.length > 0 && (
            <button type="button" className={SIDEBAR_ROW} aria-label={m.tab_more()} aria-expanded={moreOpen} onClick={toggleMore}>
              <ChevronDown {...ICON_PROPS} className={cn('transition-transform duration-(--dur)', !moreOpen && '-rotate-90')} />
              <span className="sidebar-row-label min-w-0 truncate">{m.tab_more()}</span>
              <span className="ms-auto text-xs tabular-nums text-muted" aria-hidden="true">{moreRows.length}</span>
            </button>
          )}
          {moreOpen && moreRows}
        </div>
        <div className="sidebar-panel flex min-h-0 flex-col">{panel}</div>
        <div className="sidebar-footer flex flex-none items-center gap-0.5">{destinationRow('settings', !rail)}{feedbackRow}{bell}</div>
      </div>
      {isDesktop && (
        <div className="sidebar-rail flex flex-col" inert={!rail}>
          <div className="sidebar-rows flex min-h-0 flex-col gap-0.5">
            {brand}
            {!isTiled && <button type="button" className={cn(SIDEBAR_ROW, 'sidebar-rail-menu')} id="btnHamburger" aria-label={m.sidebar_show()} aria-expanded={false} onClick={toggleMobileSidebar}><MenuIcon {...ICON_PROPS} /></button>}
            {searchRow}
            {SIDEBAR_RAIL_GROUPS.map((group) => rowsFor(group, rail)).filter((rows) => rows.length > 0).map((rows, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="sidebar-rail-separator" aria-hidden="true" />}
                {rows}
              </Fragment>
            ))}
          </div>
          <div className="sidebar-footer flex flex-none items-center gap-0.5">{feedbackRow}{bell}{destinationRow('settings', rail)}</div>
        </div>
      )}
    </nav>
  )
}

/** Settings' column: Back and the section list, in place of the destinations, the chat list and the footer. */
function SettingsNav({ panel }: { panel: ReactNode }) {
  useLocale()
  const navigate = useNavigate()
  const back = () => { closeMobileSidebar(); void navigate({ href: settingsBackHref() }) }
  return (
    <nav className="sidebar-primary flex min-h-0 flex-1 flex-col min-[641px]:p-(--island-gap)" aria-label="Primary navigation">
      <button type="button" className={SIDEBAR_ROW} aria-label={m.back()} onClick={back}><SidebarRowContent icon={ChevronLeft} label={m.back()} /></button>
      <div className="sidebar-panel flex min-h-0 flex-col">{panel}</div>
    </nav>
  )
}

/**
 * The one left column on every page. From 901px it tiles, expanded (resizable) or as the 64px icon rail by the stored
 * choice; at 641-900px the rail stays tiled and the hamburger opens the expanded panel over the page; at 640px and below
 * it is a full-width drawer. Settings always shows it expanded, tiled from 641px. `panel` is the route's content below the destinations (session list, section menu).
 */
export function Sidebar({ panel }: { panel: ReactNode }) {
  const { collapsed, mobileOpen, sidebarWidth } = useShellState()
  const isDesktop = useIsDesktop()
  const isTiled = useIsTiled()
  const settings = useIsSettings()
  const rail = useIsSidebarRail()
  // Settings' section list is the page's navigation, so nothing opens over the page there.
  const noOverlay = isTiled || (settings && isDesktop)
  const overlay = mobileOpen && !noOverlay
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMobileSidebar() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [overlay])
  // Widening past the overlay's range leaves the stored choice in charge, and narrowing again does not reopen it.
  useEffect(() => { if (noOverlay) closeMobileSidebar() }, [noOverlay])
  // The rail hides while the panel covers the page, so focus moves in with it and back to the hamburger when it closes.
  useEffect(() => {
    if (!overlay || !isDesktop) return
    const focused = document.activeElement
    if (focused === document.body || focused?.closest('.sidebar-rail')) document.getElementById('btnNewChat')?.focus()
    return () => { document.getElementById('btnHamburger')?.focus() }
  }, [overlay, isDesktop])

  // Drag the right edge to resize (180..480px, persisted on release). The width is written straight to the DOM while
  // dragging: a React render per pointer move (and the panel's width transition) lags the pointer.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const el = ref.current
    const startW = el?.getBoundingClientRect().width ?? sidebarWidth
    const dir = document.documentElement.dir === 'rtl' ? -1 : 1
    let next = startW
    el?.setAttribute('data-resizing', '1')
    const move = (ev: PointerEvent) => { next = Math.min(480, Math.max(180, Math.round(startW + (ev.clientX - startX) * dir))); if (el) el.style.width = `${next}px` }
    const up = () => {
      el?.removeAttribute('data-resizing')
      setSidebarWidth(next)
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const drawerClosed = !isDesktop && !mobileOpen
  return (
    <>
      {overlay && <div className="sidebar-scrim fixed inset-0 z-[190] bg-black/40" aria-hidden="true" onClick={closeMobileSidebar} />}
      <aside
        ref={ref}
        className={cn('sidebar flex w-[300px] shrink-0 flex-col overflow-visible bg-(--rail-bg) max-[641px]:bg-(--sidebar-bg) border-0 shadow-(--sidebar-shadow) min-[641px]:relative min-[901px]:shrink min-[901px]:min-w-[180px] max-[769px]:border-r max-[769px]:border-r-border max-[641px]:fixed max-[641px]:inset-y-0 max-[641px]:left-0 max-[641px]:w-screen max-[641px]:max-w-none max-[641px]:z-[200] max-[641px]:box-border max-[641px]:p-2 max-[641px]:pt-[calc(8px+var(--app-titlebar-safe-top))] max-[641px]:[transform:translateX(-100%)] max-[641px]:will-change-transform max-[641px]:pb-[calc(8px+env(safe-area-inset-bottom,0px))] max-[641px]:[&.mobile-open]:[transform:translateX(0)]', overlay && 'mobile-open')}
        style={isTiled ? { width: rail ? undefined : sidebarWidth, '--sidebar-content-w': `${String(sidebarWidth)}px` } as React.CSSProperties : undefined}
        aria-hidden={drawerClosed ? true : undefined}
        inert={drawerClosed}
        data-mobile-open={mobileOpen ? '1' : undefined}
      >
        {!isDesktop && (
          <button type="button" className={cn(PANEL_HEAD_BTN, 'mobile-sidebar-close has-tooltip--bottom-right')} data-tooltip={m.close_menu()} aria-label={m.close_menu()} onClick={closeMobileSidebar}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
        {settings ? <SettingsNav panel={panel} /> : <SidebarNav panel={panel} />}
        <span className="seam seam-tr" aria-hidden="true" />
        <span className="seam seam-br" aria-hidden="true" />
        {isTiled && !rail && (
          <div className="resize-handle absolute top-0 bottom-0 w-[5px] cursor-col-resize z-10 transition-[background] duration-150 hover:bg-accent" id="sidebarResize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={startResize} />
        )}
        {/* Edge tab on the sidebar's right edge (the mirror of the right panel's). */}
        {isTiled && !settings && (
          <button type="button" className="workspace-panel-edge-toggle has-tooltip" id="btnSidebarEdgeToggle" data-tooltip={collapsed ? m.sidebar_show() : m.sidebar_hide()} aria-label={collapsed ? m.sidebar_show() : m.sidebar_hide()} aria-expanded={!collapsed} onClick={() => toggleSidebarCollapsed()}>
            <span className="edge-tab-join edge-tab-join-top" aria-hidden="true" />
            <span className="edge-tab-join edge-tab-join-bottom" aria-hidden="true" />
            {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronLeft size={12} aria-hidden="true" />}
          </button>
        )}
      </aside>
    </>
  )
}
