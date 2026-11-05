/** Shell interaction state: sidebar collapse (persisted), the overlay or drawer, and viewport class. */
import { useSyncExternalStore, useEffect, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { readPersisted, writePersisted, readPersistedJson } from '../lib/persisted'
import { TabIdListSchema } from '../contracts/persisted'
import { panelForPath } from './nav'

interface ShellState { collapsed: boolean; mobileOpen: boolean; sidebarWidth: number; sidePanelOpen: boolean; sessionSearchRequested: boolean }
let state: ShellState = { collapsed: readPersisted('hermes-webui-sidebar-collapsed') === '1', mobileOpen: false, sidebarWidth: Number(readPersisted('hermes-webui-sidebar-width')) || 300, sidePanelOpen: readPersisted('hermes-webui-workspace-panel') === 'open', sessionSearchRequested: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<ShellState>) => { state = { ...state, ...patch }; for (const l of listeners) l() }

export function useShellState(): ShellState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state, () => state)
}
export function toggleSidebarCollapsed(next?: boolean): void {
  const collapsed = next ?? !state.collapsed
  writePersisted('hermes-webui-sidebar-collapsed', collapsed ? '1' : '0')
  set({ collapsed })
}
/** TAL-373: the chat's right panel (Files, Agents); the edge tab opens it on wide screens, the titlebar on narrow ones. */
export function setSidePanelOpen(open: boolean): void {
  writePersisted('hermes-webui-workspace-panel', open ? 'open' : 'closed')
  set({ sidePanelOpen: open })
}
export function toggleSidePanel(): void { setSidePanelOpen(!state.sidePanelOpen) }
export function openMobileSidebar(): void { set({ mobileOpen: true }) }
export function closeMobileSidebar(): void { set({ mobileOpen: false }) }
export function toggleMobileSidebar(): void { set({ mobileOpen: !state.mobileOpen }) }
/** The stored choice only tiles from 901px; below that the panel opens over the page and the choice stays as it is. */
const TILED = '(min-width: 901px)'
export function toggleSidebar(): void { if (window.matchMedia(TILED).matches) toggleSidebarCollapsed(); else toggleMobileSidebar() }
/** Sidebar Search: shows the panel and asks `SessionListPanel`, which may mount only after a navigation, to open its filter. */
export function requestSessionSearch(): void {
  if (window.matchMedia(TILED).matches) toggleSidebarCollapsed(false)
  set({ sessionSearchRequested: true, mobileOpen: !window.matchMedia(TILED).matches })
}
export function clearSessionSearchRequest(): void { set({ sessionSearchRequested: false }) }
export function setSidebarWidth(width: number): void {
  const w = Math.min(480, Math.max(180, Math.round(width)))
  writePersisted('hermes-webui-sidebar-width', String(w))
  set({ sidebarWidth: w })
}

/** Where Settings' Back row goes: the last location outside Settings, or the chat after a direct load of a Settings URL. */
let outsideSettings = '/'
export function rememberOutsideSettings(href: string): void { outsideSettings = href }
export function settingsBackHref(): string { return outsideSettings }

export function readTabOrder(): string[] | null { return readPersistedJson('hermes-webui-tab-order', TabIdListSchema) }
export function readHiddenTabs(): string[] | null { return readPersistedJson('hermes-webui-hidden-tabs', TabIdListSchema) }

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const on = () => setMatches(mql.matches)
    on()
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [query])
  return matches
}
/** Legacy breakpoints: a tiled column from 641px; compact chrome at 768px and below. */
export const useIsDesktop = () => useMediaQuery('(min-width: 641px)')
export const useIsTiled = () => useMediaQuery(TILED)
export const useIsSettings = () => useLocation({ select: (location) => panelForPath(location.pathname) === 'settings' })
/** Whether the column shows as the icon rail: the stored choice from 901px, unless opened over the page at 641-900px, never on a phone or on Settings. */
export function useIsSidebarRail(): boolean {
  const { collapsed, mobileOpen } = useShellState()
  const isDesktop = useIsDesktop()
  const isTiled = useIsTiled()
  const settings = useIsSettings()
  return isDesktop && !settings && (isTiled ? collapsed : !mobileOpen)
}
export const useIsNarrow = () => useMediaQuery('(max-width: 768px)')
