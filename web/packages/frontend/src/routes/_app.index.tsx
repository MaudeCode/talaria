import { createFileRoute, redirect } from '@tanstack/react-router'
import { IndexSearchSchema } from '../contracts/url'
import { readPersisted } from '../lib/persisted'
import { SessionIdSchema } from '../contracts/session'
import { ChatPage } from '../features/chat/ChatPage'

export const Route = createFileRoute('/_app/')({
  validateSearch: IndexSearchSchema,
  beforeLoad: ({ search }) => {
    // Legacy launch flows: ?session= / ?session_id= are canonicalised.
    const legacy = search.session ?? search.session_id
    if (legacy) throw redirect({ to: '/session/$sessionId', params: { sessionId: legacy }, replace: true })
    if (search.action === 'new-chat') return
    // Restore the last visible session (validated persisted id) unless a new chat was requested.
    const restored = SessionIdSchema.safeParse(readPersisted('hermes-webui-session'))
    if (restored.success && !search.source) throw redirect({ to: '/session/$sessionId', params: { sessionId: restored.data }, replace: true })
  },
  component: () => <ChatPage sessionId={null} />,
})
