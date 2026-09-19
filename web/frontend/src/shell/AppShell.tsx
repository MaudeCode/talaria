import type { ReactNode } from 'react'
import { Titlebar } from './Titlebar'
import { Rail } from './Rail'
import { Sidebar } from './Sidebar'
import { Tabbar } from './Tabbar'
import { useShortcuts } from './useShortcuts'
import { Toaster } from '../features/toast/Toaster'
import { TooltipProvider } from '../ui/Tooltip'
import { useEffect } from 'react'
import { registerExtensionSkins, useExtensionManifests } from '../extensions/registry'
import { reapplyExtensionSkin } from '../app/appearance'
import { useIsDesktop, useShellState } from './useShellState'
import { cn } from '../ui/cn'

/** Titlebar + `.layout` (rail, sidebar, main) on the legacy island shell. Routes supply `sidebar` (null for pages without one; the phone drawer then only carries the nav) and render into `children`. */
export function AppShell({ sidebar, children, title, subtitle, hub, showing }: { sidebar: ReactNode | null; children: ReactNode; title?: string; subtitle?: string; hub?: boolean; showing?: string }) {
  useShortcuts()
  const { collapsed } = useShellState()
  const isDesktop = useIsDesktop()
  const manifests = useExtensionManifests()
  useEffect(() => {
    if (manifests.data) { registerExtensionSkins(manifests.data.manifests); reapplyExtensionSkin() }
  }, [manifests.data])
  // The html attribute is the pre-paint marker (prepaint.js/boot.ts); its CSS has no transition. Once the shell
  // owns the state through .layout.sidebar-collapsed the marker goes, so collapsing animates like expanding.
  useEffect(() => { delete document.documentElement.dataset.sidebarCollapsed }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('hub-active', !!hub)
    return () => document.documentElement.classList.remove('hub-active')
  }, [hub])
  return (
    <TooltipProvider>
      <Titlebar {...(title !== undefined ? { title } : {})} {...(subtitle !== undefined ? { subtitle } : {})} />
      <div className={cn('layout flex w-full flex-[1_1_auto] min-h-0 gap-0 p-0 bg-(--canvas) max-[641px]:overflow-x-clip max-[641px]:box-border max-[641px]:pb-[calc(56px+env(safe-area-inset-bottom,0px))]', collapsed && 'sidebar-collapsed')}>
        <Rail />
        {(sidebar !== null || !isDesktop) && <Sidebar panel={sidebar} />}
        <main className={cn('main flex flex-1 flex-col overflow-hidden min-w-0 min-h-0 m-0 bg-(--main-surface) border-(length:--island-ring-width) border-(--island-ring) max-[769px]:m-0 min-[901px]:flex-[1_1_420px] min-[901px]:min-w-[420px] max-[769px]:rounded-none max-[769px]:border-0', showing && `showing-${showing}`)} id="main">
          {children}
        </main>
        <div id="rightpanelSlot" className="contents" />
      </div>
      <Tabbar />
      <Toaster />
    </TooltipProvider>
  )
}

/** Legacy `.main-view` column: the panel that fills `.main`. */
export const MAIN_VIEW = 'main-view flex flex-1 min-h-0 min-w-0 flex-col bg-bg'

/** Hub page frame (skills, memory, spaces, profiles, tasks, insights, logs). */
export function HubPage({ title, actions, toolbar, children, id }: { title: string; actions?: ReactNode; toolbar?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className={MAIN_VIEW + ' hub-page active'} id={id}>
      <header className="main-view-header relative z-10 flex items-center justify-start gap-3 min-h-14 px-8 py-3 border-b border-border shrink-0 bg-bg max-[769px]:px-3.5 max-[769px]:py-2.5 max-[769px]:min-h-12">
        <h1 className="main-view-title flex-1 min-w-0 text-[20px] font-semibold tracking-(--heading-tracking) text-text leading-[1.3] overflow-hidden text-ellipsis whitespace-nowrap text-left max-[769px]:text-[17px]">{title}</h1>
        {actions && <div className="main-view-actions flex items-center gap-1.5 shrink-0 ml-auto">{actions}</div>}
      </header>
      {toolbar && <div className="hub-toolbar flex flex-wrap items-center gap-x-3.5 gap-y-2 px-7 py-2.5 border-b border-border max-[769px]:px-3.5 max-[769px]:py-2">{toolbar}</div>}
      <div className="main-view-body flex-1 min-h-0 overflow-y-auto pt-6 px-8 pb-12 max-[769px]:pt-4 max-[769px]:px-3.5 max-[769px]:pb-8">{children}</div>
    </div>
  )
}
