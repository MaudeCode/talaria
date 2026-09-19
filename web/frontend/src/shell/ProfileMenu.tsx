import { ChevronDown, UserRound } from 'lucide-react'
import { m } from '../paraglide/messages.js'
import { useProfilesQuery, useSwitchProfile } from '../app/queries'
import { useBootstrap } from '../app/bootstrap'
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../ui/Menu'
import { showToast } from '../features/toast/toast'
import { Link } from '@tanstack/react-router'

/** Titlebar profile switcher (Base UI Menu). Hidden in single-profile mode or when only one profile exists. */
export function ProfileMenu({ row }: { row?: boolean } = {}) {
  const bootstrap = useBootstrap()
  const profiles = useProfilesQuery()
  const switchProfile = useSwitchProfile()
  const list = profiles.data?.profiles ?? []
  const active = profiles.data?.active ?? bootstrap.profile?.name ?? 'default'
  if (!row && (bootstrap.features.single_profile_mode || list.length < 2)) return null
  return (
    <Menu
      label={m.profile_switch_title()}
      trigger={row ? (
        <button type="button" className="composer-mobile-config-action" title={m.composer_control_profile()} aria-label={`${m.composer_control_profile()}: ${active}`}>
          <UserRound size={14} aria-hidden="true" />
          <span className="composer-mobile-config-copy"><span className="composer-mobile-config-kicker">{m.composer_control_profile()}</span><span className="composer-mobile-config-value">{active}</span></span>
        </button>
      ) : (
        <button type="button" className="composer-chip inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border2 bg-transparent px-2 text-[11px] font-medium text-muted hover:bg-hover" aria-label={m.profile_switch_title()}>
          <UserRound size={14} aria-hidden="true" />
          <span>{active}</span>
          <ChevronDown size={8} aria-hidden="true" />
        </button>
      )}
    >
      <MenuRadioGroup value={active} onValueChange={(value: string) => { if (value !== active) switchProfile.mutate(value, { onSuccess: () => { showToast(m.profile_switched({ name: value })); window.location.reload() } }) }}>
        {list.map((p) => (
          <MenuRadioItem key={p.name} value={p.name} className="flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-hover">
            <span className="flex-1 truncate">{p.name}{p.is_default ? ` ${m.profile_default_label()}` : ''}</span>
            {p.name === active && <span className="text-[10px] font-semibold text-accent-text">{m.profile_active()}</span>}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem render={<Link to="/profiles" />}>{m.tab_profiles()}</MenuItem>
    </Menu>
  )
}
