import { Link, useLocation } from '@tanstack/react-router'
import { useSettingsQuery } from '../app/queries'
import { cn } from '../ui/cn'
import { orderedNav, panelForPath } from './nav'
import { closeMobileSidebar, readHiddenTabs, readTabOrder } from './useShellState'
import { useLocale } from '../i18n/useLocale'

/** Mobile drawer navigation column (<= 640px), mirrors the rail. */
export function MobileNav() {
  useLocale()
  const location = useLocation()
  const settings = useSettingsQuery()
  const { visible } = orderedNav(readTabOrder(), settings.data?.hidden_tabs ?? readHiddenTabs())
  const current = panelForPath(location.pathname)
  return (
    <div className="sidebar-nav flex shrink-0 gap-0.5 border-b border-border pt-1.5 px-2 pb-0 max-[641px]:absolute max-[641px]:inset-y-0 max-[641px]:left-0 max-[641px]:w-[52px] max-[641px]:flex-col max-[641px]:gap-1 max-[641px]:py-2 max-[641px]:px-1 max-[641px]:border-r max-[641px]:border-r-border max-[641px]:border-b-0 max-[641px]:overflow-y-auto max-[641px]:overflow-x-hidden max-[641px]:[-webkit-overflow-scrolling:touch]" role="tablist" aria-orientation="vertical">
      {visible.map((item) => {
        const Icon = item.icon
        const active = current === item.id
        return (
          <Link key={item.id} to={item.to} onClick={() => { if (item.id !== 'chat') closeMobileSidebar() }} className={cn('nav-tab has-tooltip has-tooltip--bottom', active && 'active')} data-label={item.label()} data-tooltip={item.label()} data-panel={item.id} aria-label={item.label()} aria-current={active ? 'page' : undefined}>
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
          </Link>
        )
      })}
    </div>
  )
}
