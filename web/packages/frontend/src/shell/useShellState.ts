/** Shell interaction state: sidebar collapse (persisted), mobile drawer, and viewport class. */
import { useSyncExternalStore, useEffect, useState } from 'react'
import { readPersisted, writePersisted, readPersistedJson } from '../lib/persisted'
import { TabIdListSchema } from '../contracts/persisted'

interface ShellState { collapsed: boolean; mobileOpen: boolean; sidebarWidth: number }
let state: ShellState = { collapsed: readPersisted('hermes-webui-sidebar-collapsed') === '1', mobileOpen: false, sidebarWidth: Number(readPersisted('hermes-webui-sidebar-width')) || 300 }
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
export function openMobileSidebar(): void { set({ mobileOpen: true }) }
export function closeMobileSidebar(): void { set({ mobileOpen: false }) }
export function toggleMobileSidebar(): void { set({ mobileOpen: !state.mobileOpen }) }
export function setSidebarWidth(width: number): void {
  const w = Math.min(480, Math.max(180, Math.round(width)))
  writePersisted('hermes-webui-sidebar-width', String(w))
  set({ sidebarWidth: w })
}

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
/** Legacy breakpoints: rail and desktop sidebar from 641px; compact chrome at 768px and below. */
export const useIsDesktop = () => useMediaQuery('(min-width: 641px)')
export const useIsNarrow = () => useMediaQuery('(max-width: 768px)')
