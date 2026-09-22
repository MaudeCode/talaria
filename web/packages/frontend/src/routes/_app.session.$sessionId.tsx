import { createFileRoute, notFound } from '@tanstack/react-router'
import { SessionIdSchema } from '../contracts/session'
import { SessionSearchSchema } from '../contracts/url'
import { ChatPage } from '../features/chat/ChatPage'

export const Route = createFileRoute('/_app/session/$sessionId')({
  validateSearch: SessionSearchSchema,
  params: {
    parse: ({ sessionId }) => {
      const parsed = SessionIdSchema.safeParse(decodeURIComponent(sessionId))
      if (!parsed.success) throw notFound()
      return { sessionId: parsed.data }
    },
    stringify: ({ sessionId }) => ({ sessionId: encodeURIComponent(sessionId) }),
  },
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  return <ChatPage sessionId={sessionId} />
}
