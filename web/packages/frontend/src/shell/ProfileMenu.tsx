import { UserRound } from 'lucide-react'
import { Chip, ComposerMenu } from '../features/composer/chips'
import { m } from '../paraglide/messages.js'
import { useProfilesQuery, useSwitchProfile } from '../app/queries'
import { useBootstrap } from '../app/bootstrap'
import { Menu, MenuChoiceItem, MenuItem, MenuRadioGroup, MenuSeparator } from '../ui/Menu'
import { Link } from '@tanstack/react-router'

/** The active profile's name, from the profile list once it loads and from bootstrap until then. */
export function useActiveProfileName(): string | undefined {
  const bootstrap = useBootstrap()
  return useProfilesQuery().data?.active ?? bootstrap.profile?.name
}

/**
 * Profile switcher (Base UI Menu): the titlebar's opens downward; `composer` makes it one of the composer strip's menus
 * (TAL-2095). Hidden in single-profile mode or when only one profile exists.
 */
export function ProfileMenu({ row, composer }: { row?: boolean; composer?: boolean } = {}) {
  const bootstrap = useBootstrap()
  const profiles = useProfilesQuery()
  const switchProfile = useSwitchProfile()
  const list = profiles.data?.profiles ?? []
  const active = useActiveProfileName() ?? 'default'
  if (!row && (bootstrap.features.single_profile_mode || list.length < 2)) return null
  const ProfileMenuRoot = composer ? ComposerMenu : Menu
  return (
    <ProfileMenuRoot
      label={composer ? m.composer_control_profile() : m.profile_switch_title()}
      trigger={row ? (
        <button type="button" className="composer-mobile-config-action" title={m.composer_control_profile()} aria-label={`${m.composer_control_profile()}: ${active}`}>
          <UserRound size={14} aria-hidden="true" />
          <span className="composer-mobile-config-copy"><span className="composer-mobile-config-kicker">{m.composer_control_profile()}</span><span className="composer-mobile-config-value">{active}</span></span>
        </button>
      ) : (
        <Chip size="xs" icon={<UserRound size={13} className="shrink-0" aria-hidden="true" />} label={active} title={m.profile_switch_title()} />
      )}
    >
      <MenuRadioGroup value={active} onValueChange={(value: string) => { if (value !== active) switchProfile.mutate({ name: value }) }}>
        {list.map((p) => (
          <MenuChoiceItem key={p.name} value={p.name}>
            <span className="truncate">{p.display_name || p.name}</span>
            {p.is_default && p.name !== 'default' && <span className="shrink-0 text-xs text-muted">{m.profile_default_label()}</span>}
          </MenuChoiceItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem render={<Link to="/settings/$section" params={{ section: 'profiles' }} />}>{m.tab_profiles()}</MenuItem>
    </ProfileMenuRoot>
  )
}
