import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useMatchRoute, useNavigate, useParams } from '@tanstack/react-router'
import { MAIN_VIEW } from '../../shell/AppShell'
import { PanelHead } from '../../shell/PanelHead'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { SETTINGS_SECTION_GROUPS, SettingsSectionGroupSchema, SettingsSectionSchema, type SettingsSection as Section, type SettingsSectionGroup } from '../../contracts/url'
import { useLocale } from '../../i18n/useLocale'
import { closeMobileSidebar } from '../../shell/useShellState'
import { useActiveProfileName } from '../../shell/ProfileMenu'
import { SectionHeader } from '../../ui/List'
import { MessageSquare, AudioLines, Bell, SunMedium, PanelLeft, Cpu, KeyRound, Wrench, Puzzle, Lock, Server, Info, UserRound, FolderOpen, FileText, Search, type LucideIcon } from 'lucide-react'
import { PAGE_TITLE, searchSettings, type SettingsIndexEntry } from './settingsIndex'

const SECTION_ICON: Record<Section, LucideIcon> = {
  appearance: SunMedium, chat: MessageSquare, navigation: PanelLeft, notifications: Bell, speech: AudioLines,
  models: Cpu, providers: KeyRound, tools: Wrench,
  profiles: UserRound, workspaces: FolderOpen, extensions: Puzzle, access: Lock, system: Server, logs: FileText, about: Info,
}

export const SECTION_LABEL: Record<Section, () => string> = {
  appearance: () => m.settings_section_appearance_title(),
  chat: () => m.settings_section_chat_title(),
  navigation: () => m.settings_section_navigation_title(),
  notifications: () => m.settings_section_notifications_title(),
  speech: () => m.settings_section_speech_title(),
  models: () => m.settings_section_models_title(),
  providers: () => m.settings_section_providers_title(),
  tools: () => m.settings_section_tools_title(),
  profiles: () => m.tab_profiles(),
  workspaces: () => m.tab_workspaces(),
  extensions: () => m.settings_section_extensions_title(),
  access: () => m.settings_section_access_title(),
  system: () => m.settings_section_system_title(),
  logs: () => m.tab_logs(),
  about: () => m.settings_section_about_title(),
}

const GROUP_LABEL: Record<SettingsSectionGroup, () => string> = {
  interface: () => m.settings_menu_group_interface(),
  profile: () => m.settings_menu_group_profile(),
  server: () => m.settings_menu_group_server(),
}

/** TAL-2100: each group with its sections, both in contract order. */
const GROUPS = SettingsSectionGroupSchema.options.map((group) => ({ group, sections: SettingsSectionSchema.options.filter((section) => SETTINGS_SECTION_GROUPS[section] === group) }))

const RESULTS_ID = 'settingsSearchResults'
const resultId = (index: number) => `settingsSearchResult-${index}`

export function SectionMenu() {
  useLocale()
  const params: { section?: string; providerId?: string; page?: string } = useParams({ strict: false })
  // A provider's own page (TAL-2135) and Quota alerts (TAL-2136) sit under Providers, a Chat sub-page (TAL-2138) under Chat.
  const underProviders = useMatchRoute()({ to: '/settings/providers/quota-alerts' }) !== false || params.providerId !== undefined
  const current = params.section ?? (underProviders ? 'providers' : params.page !== undefined ? 'chat' : undefined)
  const profile = useActiveProfileName()
  const navigate = useNavigate()
  // TAL-2086: device-local UI state over the rows' own wording; while it has text, the matches replace the section list.
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const results = query.trim() ? searchSettings(query) : null
  const choose = (entry: SettingsIndexEntry) => {
    setQuery('')
    closeMobileSidebar()
    // A row on a page under its section (TAL-2136, TAL-2138) opens that page.
    if (entry.page === 'quota-alerts') void navigate({ to: '/settings/providers/quota-alerts', hash: entry.id })
    else if (entry.page) void navigate({ to: '/settings/chat/$page', params: { page: entry.page }, hash: entry.id })
    else void navigate({ to: '/settings/$section', params: { section: entry.section }, search: entry.tab ? { tab: entry.tab } : {}, hash: entry.id })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); return }
    if (!results?.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
      setHighlight(next)
      document.getElementById(resultId(next))?.scrollIntoView?.({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = results[highlight]
      if (entry) choose(entry)
    }
  }
  return (
    <div className="panel-view active" id="panelSettings">
      <PanelHead title={m.tab_settings()} />
      <div className="sidebar-search">
        <div className="hub-search relative">
          <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
          <input id="settingsSearch" type="search" role="combobox" aria-expanded={!!results?.length} aria-controls={RESULTS_ID} aria-autocomplete="list" aria-activedescendant={results?.length ? resultId(highlight) : undefined}
            value={query} onChange={(e) => { setQuery(e.target.value); setHighlight(0) }} onKeyDown={onKeyDown} placeholder={m.settings_search_placeholder()} aria-label={m.settings_search_placeholder()} autoComplete="off" data-1p-ignore data-lpignore="true" />
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only">{results ? results.length ? m.settings_search_results({ count: results.length }) : m.settings_search_no_results() : ''}</span>
      <nav className="side-menu flex flex-col gap-px p-2 overflow-visible min-h-0" id="settingsMenu" aria-label={m.tab_settings()}>
        <div className="settings-menu-items flex flex-col gap-4 min-h-0 flex-1 overflow-y-auto">
          {results && (results.length === 0
            ? <p className="px-2.5 py-[7px] text-[13px] text-muted">{m.settings_search_no_results()}</p>
            : <ul id={RESULTS_ID} role="listbox" aria-label={m.settings_search_placeholder()} className="flex flex-col gap-0.5">
              {results.map((entry, index) => (
                // The field keeps focus; mousedown would take it, so a click chooses without blurring the field first.
                <li key={entry.id} id={resultId(index)} role="option" aria-selected={index === highlight} data-settings-result={entry.id} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => choose(entry)}
                  className={cn('flex flex-col gap-0.5 px-2.5 py-[7px] rounded-(--r-sm) cursor-pointer text-[13px]', index === highlight && 'bg-hover')}>
                  <span className="font-medium text-text">{entry.label()}</span>
                  <span className="text-xs text-muted">{SECTION_LABEL[entry.section]()}{entry.page && ` › ${PAGE_TITLE[entry.page]()}`} · {entry.group()}</span>

                </li>
              ))}
            </ul>)}
          {!results && GROUPS.map(({ group, sections }) => (
            <div key={group} role="group" aria-labelledby={`settingsGroup-${group}`} data-settings-group={group} className="flex flex-col gap-0.5">
              <SectionHeader className="px-2.5 pb-1" detail={group === 'profile' && profile ? <Link to="/settings/$section" params={{ section: 'profiles' }} search={{ name: profile }} onClick={closeMobileSidebar} data-settings-profile-link="" className="hover:text-text hover:underline">{profile}</Link> : undefined}><span id={`settingsGroup-${group}`}>{GROUP_LABEL[group]()}</span></SectionHeader>
              {sections.map((section) => {
                const active = current === section
                const Icon = SECTION_ICON[section]
                return (
                  <Link key={section} to="/settings/$section" params={{ section }} onClick={closeMobileSidebar} aria-current={active ? 'page' : undefined} className={cn('side-menu-item flex w-full items-center gap-2 px-2.5 py-[7px] rounded-(--r-sm) border-0 bg-transparent text-text cursor-pointer text-left text-[13px] font-medium transition-[background,color] duration-(--dur) ease-(--ease) hover:bg-hover [&.active]:bg-(--menu-active-bg) [&.active]:text-(--menu-active-fg) [&.active]:shadow-(--menu-active-shadow) [&.active]:[font-weight:var(--menu-active-weight)] [&_svg]:shrink-0 [&_svg]:size-4 [&_svg]:opacity-90 [&.active_svg]:text-(--menu-active-fg)', active && 'active')} data-settings-section={section}>
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                    <span>{SECTION_LABEL[section]()}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}

export function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className={MAIN_VIEW + ' active'} id="mainSettings">{children}</div>
}
