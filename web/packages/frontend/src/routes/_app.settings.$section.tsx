import { createFileRoute, notFound, redirect, useLocation } from '@tanstack/react-router'
import { LEGACY_SETTINGS_SECTIONS, SettingsSearchSchema, SettingsSectionSchema, type ToolsTab } from '../contracts/url'
import { SettingsSection } from '../features/settings/SettingsSection'

export const Route = createFileRoute('/_app/settings/$section')({
  params: {
    parse: ({ section }) => {
      const parsed = SettingsSectionSchema.safeParse(section)
      if (parsed.success) return { section: parsed.data }
      const moved = Object.hasOwn(LEGACY_SETTINGS_SECTIONS, section) ? LEGACY_SETTINGS_SECTIONS[section] : undefined
      if (moved) throw redirect({ to: '/settings/$section', params: { section: moved.section }, search: moved.tab ? { tab: moved.tab } : {}, replace: true })
      throw notFound()
    },
    stringify: ({ section }) => ({ section }),
  },
  validateSearch: SettingsSearchSchema,
  component: SettingsSectionPage,
})

function SettingsSectionPage() {
  const { section } = Route.useParams()
  const { tab, name } = Route.useSearch()
  const navigate = Route.useNavigate()
  const row = useLocation({ select: (location) => location.hash || undefined })
  const visit = useLocation({ select: (location) => location.state.__TSR_key })
  const setTab = (next: ToolsTab) => { void navigate({ search: { tab: next }, replace: true }) }
  return <SettingsSection section={section} tab={tab} onTabChange={setTab} name={name} row={row} visit={visit} />
}
