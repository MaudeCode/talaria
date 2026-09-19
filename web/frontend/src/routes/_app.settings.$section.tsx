import { createFileRoute, notFound } from '@tanstack/react-router'
import { SettingsSectionSchema } from '../contracts/url'
import { SettingsSection } from '../features/settings/SettingsSection'

export const Route = createFileRoute('/_app/settings/$section')({
  params: {
    parse: ({ section }) => {
      const parsed = SettingsSectionSchema.safeParse(section)
      if (!parsed.success) throw notFound()
      return { section: parsed.data }
    },
    stringify: ({ section }) => ({ section }),
  },
  component: SettingsSectionPage,
})

function SettingsSectionPage() {
  const { section } = Route.useParams()
  return <SettingsSection section={section} />
}
