import { createFileRoute, notFound } from '@tanstack/react-router'
import { SharePage } from '../features/share/SharePage'

export const Route = createFileRoute('/share/$token')({
  params: {
    parse: ({ token }) => {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) throw notFound()
      return { token }
    },
    stringify: ({ token }) => ({ token }),
  },
  component: SharePageRoute,
})

function SharePageRoute() {
  const { token } = Route.useParams()
  return <SharePage token={token} />
}
