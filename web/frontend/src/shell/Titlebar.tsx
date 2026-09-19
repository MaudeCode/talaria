import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { NAV_ITEMS, panelForPath } from './nav'
import { Menu as MenuIcon, Plus, RotateCw } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { useBootstrap } from '../app/bootstrap'
import { ProfileMenu } from './ProfileMenu'
import { toggleMobileSidebar } from './useShellState'
import { useNewChat } from '../features/sessions/useNewChat'
import { Brandmark } from './Brandmark'

/** Legacy `.app-titlebar`: hidden in desktop browsers, visible on mobile and in installed PWAs. */
export function Titlebar({ title, subtitle }: { title?: string; subtitle?: string }) {
  const bootstrap = useBootstrap()
  const navigate = useNavigate()
  const newChat = useNewChat()
  const location = useLocation()
  const panel = panelForPath(location.pathname)
  const panelLabel = NAV_ITEMS.find((n) => n.id === panel)?.label() ?? bootstrap.bot_name
  return (
    <header className="app-titlebar relative z-20 flex h-[38px] shrink-0 items-center justify-center bg-(--titlebar-bg) [backdrop-filter:var(--chrome-backdrop)] border-b-0 px-3 pt-(--app-titlebar-safe-top) pl-[max(12px,env(safe-area-inset-left,0))] pr-[max(12px,env(safe-area-inset-right,0))] box-content text-[12px] text-muted select-none [-webkit-app-region:drag] max-[901px]:justify-between max-[769px]:bg-(--titlebar-bg) max-[769px]:border-b max-[769px]:border-b-(--titlebar-border) max-[641px]:h-[52px]" role="banner">
      <div className="app-titlebar-left flex items-center gap-1">
        <ProfileMenu />
        <button className="app-titlebar-hamburger has-tooltip has-tooltip--bottom hidden size-11 shrink-0 [-webkit-app-region:no-drag] items-center justify-center bg-transparent border-0 text-muted rounded-[8px] cursor-pointer p-0 [-webkit-tap-highlight-color:transparent] transition-[background-color,color] duration-150 max-[901px]:flex max-[641px]:leading-none max-[641px]:overflow-hidden" id="btnHamburger" type="button" data-tooltip={m.tab_more()} aria-label={m.tab_more()} onClick={toggleMobileSidebar}>
          <MenuIcon size={22} aria-hidden="true" />
        </button>
      </div>
      <div className="app-titlebar-inner flex items-center gap-2 min-w-0 max-w-full justify-center max-[641px]:flex-[1_1_auto]">
        <Link to="/" className="app-titlebar-icon inline-flex items-center text-accent" aria-hidden="true" tabIndex={-1}><Brandmark className="brandmark" size={16} /></Link>
        <span className="app-titlebar-title text-[12px] font-semibold text-text tracking-(--titlebar-title-tracking) whitespace-nowrap overflow-hidden text-ellipsis max-w-[60vw] max-[641px]:max-w-[72vw]" id="appTitlebarTitle">{title ?? panelLabel}</span>
        {subtitle && <span className="app-titlebar-sub text-[10px] text-muted bg-hover py-0.5 px-[7px] rounded-[4px] font-mono whitespace-nowrap shrink-0 max-[641px]:text-[9px] max-[641px]:py-px max-[641px]:px-[5px]" id="appTitlebarSub">{subtitle}</span>}
      </div>
      <div className="app-titlebar-spacer hidden size-11 shrink-0 max-[901px]:flex" aria-hidden="true" />
      <button className="app-titlebar-new-chat" id="btnTitlebarNewChat" type="button" aria-label={m.new_conversation()} title={m.new_conversation()} onClick={() => { void newChat() }}>
        <Plus size={16} aria-hidden="true" />
      </button>
      <button className="app-titlebar-reload" id="btnReload" type="button" aria-label={m.reload()} title={m.reload()} onClick={() => { void navigate({ to: '.' }); window.location.reload() }}>
        <RotateCw size={16} aria-hidden="true" />
      </button>
    </header>
  )
}
