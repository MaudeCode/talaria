import { Clock, Code, Columns3, FolderPlus, MessageCircle, MessageSquareWarning, Pin, Rows3, Search, SquarePen, Terminal, UserRound, Webhook, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'
import { LoadingState, ErrorState } from '../../ui/States'
import { SIDEBAR_DESTINATIONS } from '../../shell/nav'
import { SIDEBAR_ICON_PROPS } from '../../shell/SidebarRowContent'
import { PreviewToggle } from './PreviewToggle'
import { SettingNumber, SettingSegmented, SettingToggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

/** TAL-2145: one item the sidebar drawing shows and hides, by its toggle's id (the id its switch row had, so links still land on it). */
interface SidebarItem { id: string; name: string; icon: LucideIcon; shown: boolean; toggle: () => void }

/** The sidebar's two buttons a setting shows: the footer's Feedback button and the titlebar's profile switcher (TAL-2099). */
const BUTTONS = [
  { key: 'show_sidebar_feedback', name: m.feedback_rail_label, icon: MessageSquareWarning },
  { key: 'show_titlebar_profile', name: m.settings_label_profile_switcher, icon: UserRound },
] as const

/** TAL-2145: the chats from outside Talaria the chats list shows; TAL-2159 changes what each hides and its label. */
const OUTSIDE_CHATS = [
  { key: 'show_cli_sessions', label: m.settings_label_external_sessions, icon: Terminal },
  { key: 'show_claude_code_sessions', label: m.settings_label_claude_code_sessions, icon: Code },
  { key: 'show_previous_messaging_sessions', label: m.settings_label_previous_messaging_sessions, icon: MessageCircle },
  { key: 'show_cron_sessions', label: m.settings_label_cron_sessions, icon: Clock },
  { key: 'show_webhook_sessions', label: m.settings_label_webhook_sessions, icon: Webhook },
  { key: 'show_kanban_sessions', label: m.settings_label_kanban_sessions, icon: Columns3 },
] as const

/** TAL-1691, TAL-2100, TAL-2145: Settings › Navigation, what the sidebar and the chats list show. */
export function SidebarSection() {
  const { settings, bool, set } = useSettingField(['hidden_tabs', ...BUTTONS.map((b) => b.key), ...OUTSIDE_CHATS.map((o) => o.key)])
  if (settings.isPending) return <LoadingState />
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => { void settings.refetch() }} />
  const hiddenTabs = settings.data.hidden_tabs ?? []
  const destinations: SidebarItem[] = SIDEBAR_DESTINATIONS.map((n) => ({
    id: `settingsHiddenTab-${n.id}`, name: n.label(), icon: n.icon, shown: !hiddenTabs.includes(n.id),
    toggle: () => { const cur = new Set(hiddenTabs); if (cur.has(n.id)) cur.delete(n.id); else cur.add(n.id); set({ hidden_tabs: [...cur] }) },
  }))
  const buttons: SidebarItem[] = BUTTONS.map((b) => ({ id: `settings-${b.key}`, name: b.name(), icon: b.icon, shown: bool(b.key), toggle: () => set({ [b.key]: !bool(b.key) }) }))
  // TAL-2175 sends both counts from the server; until then the client counts the stored keys, its own writes included.
  const items = [...destinations, ...buttons]
  const outsideShown = OUTSIDE_CHATS.filter((o) => bool(o.key)).length
  return (
    <div className={SETTINGS_PAGE} data-section="navigation">
      <SettingsGroup id="sidebar" title={m.settings_group_sidebar()} detail={m.settings_items_shown({ shown: items.filter((i) => i.shown).length, total: items.length })}>
        <div className="@container">
          <div className="grid gap-x-6 gap-y-3 py-2 @min-[601px]:grid-cols-[240px_minmax(0,1fr)] @min-[601px]:items-start">
            <SidebarPreview destinations={destinations} buttons={buttons} />
            <div className="flex min-w-0 flex-col divide-y divide-border-subtle">
              <SettingSegmented label={m.settings_label_density()} id="settingsSidebarDensity" settingKey="sidebar_density" fallback="compact" icon={Rows3} options={[
                { value: 'compact', label: m.settings_sidebar_density_compact() },
                { value: 'detailed', label: m.settings_sidebar_density_detailed() },
              ]} />
              <SettingNumber label={m.settings_label_pinned_shown()} id="settingsPinnedLimit" settingKey="pinned_sessions_limit" fallback={3} max={50} icon={Pin} />
              <SettingToggle label={m.settings_label_project_new_chat()} settingKey="project_quick_create_buttons" icon={FolderPlus} />
            </div>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup id="outside-chats" title={m.settings_group_outside_chats()} detail={m.settings_items_shown({ shown: outsideShown, total: OUTSIDE_CHATS.length })}>
        {OUTSIDE_CHATS.map((o) => <SettingToggle key={o.key} label={o.label()} settingKey={o.key} icon={o.icon} />)}
      </SettingsGroup>
    </div>
  )
}

const ROW = 'flex min-h-8 w-full items-center gap-2.5 rounded-(--rail-btn-radius) border border-transparent px-2.5 text-left text-sm text-text'
const DIVIDER = <span className="mx-2.5 my-1.5 h-px bg-border-subtle" aria-hidden="true" />

/**
 * TAL-2145: a drawing of the sidebar on its own background, its rows in their order with their icons and labels: New chat and
 * Search (always there, drawn plain), the destinations, then the Feedback button and the profile switcher. Each item a setting
 * hides is a `PreviewToggle`, pressed while shown.
 */
function SidebarPreview({ destinations, buttons }: { destinations: readonly SidebarItem[]; buttons: readonly SidebarItem[] }) {
  const toggles = (items: readonly SidebarItem[]) => items.map((item) => (
    <PreviewToggle key={item.id} id={item.id} name={item.name} shown={item.shown} onToggle={item.toggle} className="w-full">
      {(hidden) => <span className={cn(ROW, 'cursor-pointer hover:bg-hover', hidden)}><item.icon {...SIDEBAR_ICON_PROPS} /><span className="min-w-0 truncate">{item.name}</span></span>}
    </PreviewToggle>
  ))
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-(--r-lg) bg-sidebar p-2.5" data-sidebar-preview="">
      <div className="flex flex-col gap-0.5" aria-hidden="true">
        <span className={ROW}><SquarePen {...SIDEBAR_ICON_PROPS} />{m.sidebar_new_chat()}</span>
        <span className={ROW}><Search {...SIDEBAR_ICON_PROPS} />{m.search()}</span>
      </div>
      {DIVIDER}
      {toggles(destinations)}
      {DIVIDER}
      {toggles(buttons)}
    </div>
  )
}
