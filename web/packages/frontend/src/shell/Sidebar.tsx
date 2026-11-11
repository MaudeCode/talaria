import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronLeft, ChevronRight, Menu as MenuIcon, MessageSquareWarning, Puzzle, ShieldAlert, SquarePen, X } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { useBootstrap } from '../app/bootstrap'
import { useDashboardStatusQuery, useSetting } from '../app/queries'
import { useSettingIntent } from '../app/settings'
import { useExtensionManifests } from '../extensions/registry'
import { SidebarQuotas } from '../features/insights/SidebarQuotas'
import { UpdateNotificationCenterButton } from '../features/notifications/UpdateNotificationCenter'
import { useNewChat } from '../features/sessions/useNewChat'
import { openFeedback } from '../features/settings/FeedbackDialog'
import { useLocale } from '../i18n/useLocale'
import { readPersisted, writePersisted } from '../lib/persisted'
import { cn } from '../ui/cn'
import { Brandmark } from './Brandmark'
import { PANEL_HEAD_BTN } from './PanelHead'
import { SIDEBAR_ICON_PROPS, SidebarFold, SidebarRowContent } from './SidebarRowContent'
import { DASHBOARD_ICON, SIDEBAR_MORE, SIDEBAR_PRIMARY, SIDEBAR_ROW, orderedNav, panelForPath, type SidebarSlot } from './nav'
import { closeMobileSidebar, readHiddenTabs, readTabOrder, setSidebarWidth, settingsBackHref, toggleMobileSidebar, toggleSidebarCollapsed, useIsDesktop, useIsSettings, useIsSidebarRail, useIsTiled, useShellState } from './useShellState'

const MORE_OPEN_KEY = 'hermes-webui-sidebar-more-open'

/**
 * The destinations, the page's panel and the footer: one set of rows in both states. `shell.css` morphs them between a
 * labelled row and an icon over its caption, so icons stay where they are while the width moves. Rows only one state has
 * collapse to nothing and are inert in the other. Expanded, the rows and the panel share one scroller; on the rail the rows pin and
 * scroll themselves, leaving the panel and its scroll position where they were.
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

  const destinationRow = (id: string, className?: string, inert?: boolean) => {
    const item = visible.find((i) => i.id === id)
    if (!item) return []
    const active = current === item.id && !extensionPath
    return [<Link key={item.id} to={item.to} className={cn(SIDEBAR_ROW, className, active && 'active')} inert={inert} aria-label={item.label()} aria-current={active ? 'page' : undefined} data-panel={item.id} onClick={closeMobileSidebar}><SidebarRowContent icon={item.icon} label={item.label()} /></Link>]
  }
  const rowsFor = (slots: readonly SidebarSlot[]) => slots.flatMap((slot) => {
    if (slot === 'dashboard') return dashboardUrl ? [<a key={slot} href={dashboardUrl} target="_blank" rel="noopener noreferrer" className={cn(SIDEBAR_ROW, 'dashboard-link')} aria-label={m.tab_dashboard()} onClick={closeMobileSidebar}><SidebarRowContent icon={DASHBOARD_ICON} label={m.tab_dashboard()} /></a>] : []
    if (slot !== 'extensions') return destinationRow(slot)
    return extensions.map((e) => {
      const active = extensionPath?.startsWith(`/ext/${e.id}`)
      const label = e.nav?.label ?? e.name
      return <Link key={e.id} to="/ext/$extensionId" params={{ extensionId: e.id }} className={cn(SIDEBAR_ROW, active && 'active')} aria-label={label} aria-current={active ? 'page' : undefined} data-extension={e.id} onClick={closeMobileSidebar}><SidebarRowContent icon={Puzzle} label={label} /></Link>
    })
  })
  const moreRows = rowsFor(SIDEBAR_MORE)
  const insideMore = !!extensionPath || SIDEBAR_MORE.includes(current)
  const moreOpen = moreStored || insideMore
  const toggleMore = () => { const next = !moreStored; writePersisted(MORE_OPEN_KEY, next ? '1' : '0'); setMoreStored(next) }

  return (
    <nav className="sidebar-primary flex min-h-0 flex-1 flex-col min-[641px]:p-(--island-gap)" aria-label="Primary navigation">
      <button type="button" className="sidebar-brand flex h-11 w-full flex-none items-center gap-2.5 rounded-(--r-md) border-0 bg-transparent px-2 text-left text-sm font-semibold text-text cursor-pointer hover:bg-hover" aria-label={m.new_conversation()} onClick={() => { void newChat() }}>
        <Brandmark className="brandmark sidebar-brandmark" />
        <span className="sidebar-row-label min-w-0 truncate">{bootstrap.bot_name}</span>
      </button>
      <div className="sidebar-scroll flex min-h-0 flex-1 flex-col">
        <div className="sidebar-rows flex min-h-0 flex-col gap-0.5">
          {isDesktop && !isTiled && <button type="button" className={cn(SIDEBAR_ROW, 'sidebar-rail-only sidebar-rail-menu')} id="btnHamburger" inert={!rail} aria-label={m.sidebar_show()} aria-expanded={false} onClick={toggleMobileSidebar}><MenuIcon {...SIDEBAR_ICON_PROPS} /></button>}
          <button type="button" className={cn(SIDEBAR_ROW, 'sidebar-expanded-only')} id="btnNewChat" inert={rail} aria-label={m.sidebar_new_chat()} onClick={() => { void newChat() }}><SidebarRowContent icon={SquarePen} label={m.sidebar_new_chat()} /></button>
          <span className="h-2 flex-none" aria-hidden="true" />
          {isDesktop && destinationRow('chat', 'sidebar-rail-only', !rail)}
          {rowsFor(SIDEBAR_PRIMARY)}
          {moreRows.length > 0 && (
            <button type="button" className={cn(SIDEBAR_ROW, 'sidebar-expanded-only')} inert={rail} aria-label={m.tab_more()} aria-expanded={moreOpen} onClick={toggleMore}>
              <ChevronDown {...SIDEBAR_ICON_PROPS} className={cn('transition-transform duration-(--dur)', !moreOpen && '-rotate-90')} />
              <span className="sidebar-row-label min-w-0 truncate">{m.tab_more()}</span>
              <span className="ms-auto text-xs tabular-nums text-muted" aria-hidden="true">{moreRows.length}</span>
            </button>
          )}
          {isDesktop && moreRows.length > 0 && <span className="sidebar-rail-only sidebar-rail-separator" aria-hidden="true" />}
          {(isDesktop || moreOpen) && <div className="sidebar-more contents" data-open={moreOpen ? '1' : undefined} inert={!rail && !moreOpen}>{moreRows}</div>}
          <SidebarFold rail={rail}><SidebarQuotas /></SidebarFold>
        </div>
        <div className="sidebar-panel flex min-h-0 flex-col" inert={rail}>{panel}</div>
      </div>
      <NoPasswordWarning />
      <div className="sidebar-footer flex flex-none items-center gap-0.5">
        {destinationRow('settings')}
        {showsFeedback && <button type="button" className={cn(SIDEBAR_ROW, 'sidebar-icon-row has-tooltip')} data-panel="feedback" data-tooltip={m.feedback_rail_label()} aria-label={m.feedback_send_open()} onClick={openFeedback}><SidebarRowContent icon={MessageSquareWarning} label={m.feedback_rail_label()} /></button>}
        <UpdateNotificationCenterButton placement="sidebar" />
      </div>
    </nav>
  )
}

/**
 * TAL-2158: the server's `no_password_warning` level, above the footer in every sidebar state: an error row, or a warning
 * icon once the Access switch `auth_disabled_acknowledged` is on. Null (auth on, or no server management) draws nothing.
 */
function NoPasswordWarning() {
  const { auth } = useBootstrap()
  const level = auth.no_password_warning
  // This tab's Access switch write shows at once and holds after its save until that save's bootstrap reread lands; a
  // refusal rolls the setting back, which drops it. Every other change (another tab, the server) is the server's level.
  const pending = useSettingIntent('auth_disabled_acknowledged')
  const confirmed = useSetting('auth_disabled_acknowledged')
  const [held, setHeld] = useState<{ value: boolean; auth: typeof auth } | null>(null)
  if (pending !== undefined && (held?.value !== pending || held.auth !== auth)) setHeld({ value: pending, auth })
  const own = pending ?? (held?.auth === auth && held.value === confirmed ? held.value : undefined)
  const descriptionId = useId()
  if (!level) return null
  const tone = own === undefined ? level : own ? 'warning' : 'error'
  const quiet = tone === 'warning'
  const label = m.auth_no_password()
  return (
    <div className="sidebar-alert flex flex-none">
      <Link to="/settings/$section" params={{ section: 'access' }} className={cn(SIDEBAR_ROW, quiet && 'sidebar-icon-row has-tooltip')} data-tone={tone} data-tooltip={quiet ? label : undefined} aria-label={label} aria-describedby={descriptionId} onClick={closeMobileSidebar}>
        <SidebarRowContent icon={ShieldAlert} label={label} />
      </Link>
      <span id={descriptionId} hidden>{m.auth_disabled_warning_message()}</span>
    </div>
  )
}

/**
 * Settings' column: Back and the section list, in place of the destinations, the chat list and the footer. The list's
 * sections are sidebar rows, so on the rail they morph into icons over captions like every other page's rows (TAL-2183).
 */
function SettingsNav({ panel }: { panel: ReactNode }) {
  useLocale()
  const navigate = useNavigate()
  const back = () => { closeMobileSidebar(); void navigate({ href: settingsBackHref() }) }
  return (
    <nav className="sidebar-primary flex min-h-0 flex-1 flex-col min-[641px]:p-(--island-gap)" aria-label="Primary navigation">
      <div className="sidebar-scroll flex flex-none flex-col">
        <div className="sidebar-rows flex flex-col">
          <button type="button" className={SIDEBAR_ROW} aria-label={m.back()} onClick={back}><SidebarRowContent icon={ChevronLeft} label={m.back()} /></button>
        </div>
      </div>
      {panel}
    </nav>
  )
}

/**
 * The one left column on every page. From 901px it tiles, expanded (resizable) or as the 64px icon rail by the stored
 * choice; at 641-900px the rail stays tiled and the hamburger opens the expanded panel over the page, except on Settings,
 * which tiles it expanded; at 640px and below it is a full-width drawer. `panel` is the route's content below the
 * destinations (session list, section menu).
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
  // The hamburger collapses while the panel covers the page, so focus moves in with it and back to the hamburger when it closes.
  useEffect(() => {
    if (!overlay || !isDesktop) return
    const focused = document.activeElement
    if (focused === document.body || focused?.id === 'btnHamburger') document.getElementById('btnNewChat')?.focus()
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
        {isTiled && (
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
