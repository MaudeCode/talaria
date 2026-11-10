import { createFileRoute, notFound, useLocation } from '@tanstack/react-router'
import { ChatPageSchema } from '../contracts/url'
import { SettingsSection } from '../features/settings/SettingsSection'

/** TAL-2138: a Settings › Chat sub-page, `settings/chat/workspace-panel` or `settings/chat/advanced`. */
export const Route = createFileRoute('/_app/settings/chat/$page')({
  params: {
    parse: ({ page }) => {
      const parsed = ChatPageSchema.safeParse(page)
      if (!parsed.success) throw notFound()
      return { page: parsed.data }
    },
    stringify: ({ page }) => ({ page }),
  },
  component: ChatSubPageRoute,
})

function ChatSubPageRoute() {
  const { page } = Route.useParams()
  const row = useLocation({ select: (location) => location.hash || undefined })
  const visit = useLocation({ select: (location) => location.state.__TSR_key })
  return <SettingsSection section="chat" page={page} row={row} visit={visit} />
}
