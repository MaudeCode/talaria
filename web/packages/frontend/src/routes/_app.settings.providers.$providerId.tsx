import { createFileRoute } from '@tanstack/react-router'
import { SettingsSection } from '../features/settings/SettingsSection'

/** TAL-2135: one configured provider's own page under Settings › Providers. */
export const Route = createFileRoute('/_app/settings/providers/$providerId')({
  component: ProviderPage,
})

function ProviderPage() {
  const { providerId } = Route.useParams()
  return <SettingsSection section="providers" providerId={providerId} />
}
