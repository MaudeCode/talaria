import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { HubHeadSlotsContext } from './hubHeadSlots'
import { createPortal } from 'react-dom'
import { useLocation, useParams, useSearch } from '@tanstack/react-router'
import { Titlebar, usePanelTitle } from './Titlebar'
import { Sidebar } from './Sidebar'
import { Tabbar } from './Tabbar'
import { useShortcuts } from './useShortcuts'
import { Toaster } from '../features/toast/Toaster'
import { TooltipProvider } from '../ui/Tooltip'
import { HelpTip } from '../ui/Field'
import { m } from '../paraglide/messages.js'
import { registerExtensionSkins, useExtensionManifests } from '../extensions/registry'
import { reapplyExtensionSkin } from '../app/appearance'
import { rememberOutsideSettings, useIsSidebarRail } from './useShellState'
import { cn } from '../ui/cn'
import { UpdateNotificationProvider } from '../features/notifications/UpdateNotificationCenter'
import { FeedbackDialog } from '../features/settings/FeedbackDialog'
import { WhatsNew } from '../features/whats-new/WhatsNew'
import { SectionMenu } from '../features/settings/SettingsLayout'
import { SessionListPanel } from '../features/sessions/SessionListPanel'
import { panelForPath } from './nav'

/** Titlebar + `.layout` (sidebar, main) on the legacy island shell, mounted once by the authenticated layout. Its chrome follows the location. */
export function AppShell({ children }: { children: ReactNode }) {
  useShortcuts()
  const panel = useLocation({ select: (location) => panelForPath(location.pathname) })
  const href = useLocation({ select: (location) => location.publicHref })
  useEffect(() => { if (panel !== 'settings') rememberOutsideSettings(href) }, [panel, href])
  const extensionId = useParams({ strict: false, select: (params) => params.extensionId })
  const taskDetail = useSearch({ strict: false, select: (search) => !!search.job })
  const sidebar = panel === 'settings' ? <SectionMenu /> : <SessionListPanel />
  // `hub` hides the shell's right panel, where a task's run output opens: only the Tasks list goes without one.
  const hub = panel !== 'chat' && panel !== 'settings' && !(panel === 'tasks' && taskDetail)
  const showing = panel === 'chat' ? undefined : panel
  const title = usePanelTitle()
  const rail = useIsSidebarRail()
  const manifests = useExtensionManifests()
  useEffect(() => {
    if (manifests.data) { registerExtensionSkins(manifests.data.manifests); reapplyExtensionSkin() }
  }, [manifests.data])
  const subtitle = extensionId && (manifests.data?.manifests.find((manifest) => manifest.id === extensionId)?.name ?? extensionId)
  // The html attribute is the pre-paint marker (prepaint.js/boot.ts); its CSS has no transition. Once the shell
  // owns the state through .layout.sidebar-collapsed the marker goes, so collapsing animates like expanding.
  useEffect(() => { delete document.documentElement.dataset.sidebarCollapsed; delete document.documentElement.dataset.settingsPage }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('hub-active', hub)
    return () => document.documentElement.classList.remove('hub-active')
  }, [hub])
  return (
    <TooltipProvider>
      <TitlebarTitleContext.Provider value={title}>
        <UpdateNotificationProvider>
          <Titlebar subtitle={subtitle} />
          <div className={cn('layout flex w-full flex-[1_1_auto] min-h-0 gap-0 p-0 bg-(--canvas) max-[641px]:overflow-x-clip max-[641px]:box-border max-[641px]:pb-[calc(56px+env(safe-area-inset-bottom,0px))]', rail && 'sidebar-collapsed')}>
            <Sidebar panel={sidebar} />
            <main className={cn('main flex flex-1 flex-col overflow-hidden min-w-0 min-h-0 m-0 bg-(--main-surface) border-(length:--island-ring-width) border-(--island-ring) max-[769px]:m-0 min-[901px]:flex-[1_1_420px] min-[901px]:min-w-[420px] max-[769px]:rounded-none max-[769px]:border-0', showing && `showing-${showing}`)} id="main">
              {children}
            </main>
            <div id="rightpanelSlot" className="contents" />
          </div>
          <Tabbar />
        </UpdateNotificationProvider>
      </TitlebarTitleContext.Provider>
      <FeedbackDialog />
      <WhatsNew />
      <Toaster />
    </TooltipProvider>
  )
}

/** Legacy `.main-view` column: the panel that fills `.main`. */
export const MAIN_VIEW = 'main-view flex flex-1 min-h-0 min-w-0 flex-col bg-bg'


/** TAL-2089: the titlebar's `usePanelTitle`, provided once by the shell so hub pages need no router of their own. */
export const TitlebarTitleContext = createContext<string | null>(null)

/** TAL-2088: the one horizontal gutter a hub page's header, toolbar and body share, so all three start at one edge. */
const HUB_GUTTER = 'px-8 max-[769px]:px-3.5'

/** Hub page frame (skills, memory, tasks, insights). Inside a Settings section (profiles, spaces, logs) that section's heading is the header. */
export function HubPage({ title, help, actions, toolbar, children, id, toolbarClassName }: { title: string; help?: ReactNode; actions?: ReactNode; toolbar?: ReactNode; children: ReactNode; id?: string; toolbarClassName?: string }) {
  const slots = useContext(HubHeadSlotsContext)
  const named = useContext(TitlebarTitleContext) === title
  if (slots) return (
    <>
      {help && slots.help && createPortal(<HelpTip label={m.field_help_about({ label: title })} className="shrink-0">{help}</HelpTip>, slots.help)}
      {actions && slots.actions && createPortal(actions, slots.actions)}
      {toolbar && <div className={cn('hub-toolbar flex flex-wrap items-center gap-x-3.5 gap-y-2 mb-4', toolbarClassName)}>{toolbar}</div>}
      {children}
    </>
  )
  return (
    <div className={MAIN_VIEW + ' hub-page active'} id={id}>
      <header className={cn('main-view-header relative z-10 flex items-center justify-start gap-3 min-h-14 py-3 border-b border-border shrink-0 bg-bg max-[769px]:py-2.5 max-[769px]:min-h-12 max-[641px]:py-0.5!', HUB_GUTTER, named && !help && !actions && 'max-[641px]:sr-only')}>
        <div className={cn('flex flex-1 min-w-0 items-center', named && 'max-[641px]:flex-none max-[641px]:ml-auto')}>
          <h1 className={cn('main-view-title min-w-0 text-[20px] font-semibold tracking-(--heading-tracking) text-text leading-[1.3] overflow-hidden text-ellipsis whitespace-nowrap text-left max-[769px]:text-[17px]', named && 'max-[641px]:sr-only')}>{title}</h1>
          {help && <HelpTip label={m.field_help_about({ label: title })} className="shrink-0">{help}</HelpTip>}
        </div>
        {actions && <div className="main-view-actions flex items-center gap-1.5 shrink-0 ml-auto max-[641px]:[&_button]:min-h-11 max-[641px]:[&_button]:min-w-11">{actions}</div>}
      </header>
      {toolbar && <div className={cn('hub-toolbar flex flex-wrap items-center gap-x-3.5 gap-y-2 py-2.5 border-b border-border max-[769px]:py-2', HUB_GUTTER, toolbarClassName)}>{toolbar}</div>}
      <div className={cn('main-view-body flex-1 min-h-0 overflow-y-auto pt-6 pb-12 max-[769px]:pt-4 max-[769px]:pb-8', HUB_GUTTER)}>{children}</div>
    </div>
  )
}
