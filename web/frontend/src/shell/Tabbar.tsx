import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { m } from '../paraglide/messages.js'
import { cn } from '../ui/cn'
import { NAV_ITEMS, panelForPath, type PanelId } from './nav'
import { useLocale } from '../i18n/useLocale'
import { closeMobileSidebar, openMobileSidebar } from './useShellState'

interface Tab { key: string; label: () => string; panel?: PanelId; items?: PanelId[] }

/** Phone bottom tab bar (Chat · Tasks · Kanban · Agent · More); the stylesheet shows it only below 641px. */
const TABS: Tab[] = [
  { key: 'chat', label: () => m.tab_chat(), panel: 'chat' },
  { key: 'tasks', label: () => m.tab_tasks(), panel: 'tasks' },
  { key: 'kanban', label: () => m.tab_kanban(), panel: 'kanban' },
  { key: 'agent', label: () => m.tab_agent(), items: ['skills', 'memory', 'profiles', 'workspaces'] },
  { key: 'more', label: () => m.tab_more(), items: ['todos', 'insights', 'logs', 'settings'] },
]

export function Tabbar() {
  useLocale()
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState<string | null>(null)
  const active = panelForPath(location.pathname)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { const t = e.target as HTMLElement | null; if (!t?.closest('.tabbar-sheet') && !t?.closest('.tabbar-btn')) setOpen(null) }
    const id = window.setTimeout(() => document.addEventListener('click', onDoc), 0)
    return () => { window.clearTimeout(id); document.removeEventListener('click', onDoc) }
  }, [open])
  const goTo = (panel: PanelId) => {
    setOpen(null)
    const item = NAV_ITEMS.find((n) => n.id === panel)
    if (!item) return
    if (panel === 'chat') { openMobileSidebar(); return }
    closeMobileSidebar()
    void navigate({ to: item.to })
  }
  const iconFor = (panel: PanelId) => { const it = NAV_ITEMS.find((n) => n.id === panel); return it ? <it.icon size={20} strokeWidth={1.5} aria-hidden="true" /> : null }
  const sheet = open ? TABS.find((t) => t.key === open) : undefined
  return (
    <>
      <nav className="tabbar hidden max-[641px]:flex fixed inset-x-0 bottom-0 z-[150] h-[calc(56px+env(safe-area-inset-bottom,0px))] px-1 pt-0 pb-[env(safe-area-inset-bottom,0px)] bg-sidebar border-t border-t-border" aria-label="Primary navigation">
        {TABS.map((tab) => {
          const on = tab.panel ? tab.panel === active : (tab.items ?? []).includes(active)
          return (
            <button key={tab.key} type="button" className={cn('tabbar-btn flex flex-1 flex-col items-center justify-center gap-[3px] border-0 bg-transparent text-muted text-[10.5px] font-medium cursor-pointer rounded-(--r-md) my-1.5 mx-0.5 transition-[color,background] duration-(--dur) ease-(--ease) [&_svg]:size-5 [&.active]:text-accent-text [&.open]:bg-hover [&.open]:text-text', on && 'active', open === tab.key && 'open')} data-tab={tab.key} aria-expanded={tab.items ? open === tab.key : undefined} onClick={() => { if (tab.panel) goTo(tab.panel); else setOpen((o) => (o === tab.key ? null : tab.key)) }}>
              {iconFor(tab.panel ?? tab.items?.[0] ?? 'chat')}
              <span>{tab.label()}</span>
            </button>
          )
        })}
      </nav>
      {sheet?.items && (
        <div className="tabbar-sheet hidden max-[641px]:flex fixed left-2 right-2 bottom-[calc(64px+env(safe-area-inset-bottom,0px))] z-[151] flex-col p-1.5 bg-surface border border-border rounded-(--r-lg) shadow-md" role="menu">
          {sheet.items.map((panel) => {
            const item = NAV_ITEMS.find((n) => n.id === panel)
            return item ? <button key={panel} type="button" className="tabbar-sheet-item flex items-center gap-3 h-11 px-3 border-0 rounded-(--r-md) bg-transparent text-text text-[14px] cursor-pointer text-left hover:bg-hover" role="menuitem" onClick={() => goTo(panel)}>{iconFor(panel)}<span>{item.label()}</span></button> : null
          })}
        </div>
      )}
    </>
  )
}
