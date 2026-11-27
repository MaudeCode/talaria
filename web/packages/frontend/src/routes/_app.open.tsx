import { createFileRoute, redirect } from '@tanstack/react-router'
import { isApiError } from '../contracts/common'
import { SessionIdSchema } from '../contracts/session'

export const Route = createFileRoute('/_app/open')({
  beforeLoad: async ({ location, abortController }) => {
    // A chat id is opaque text, including when it looks like a number.
    const session = SessionIdSchema.safeParse(new URLSearchParams(location.searchStr).get('session'))
    const list = () => redirect({ to: '/', search: { action: 'show-chats' }, replace: true })
    if (!session.success) throw list()
    try {
      // The browser client reads the document base. The server only prerenders the root shell.
      const { fetchSession } = await import('../api/endpoints')
      await fetchSession(session.data, { messages: false, resolve_model: false }, abortController.signal)
    } catch (error) {
      if (!isApiError(error) || (error.status !== 404 && error.status !== 409)) throw error
      if (error.status === 404) throw list()
      // The ordinary chat page explains a profile mismatch.
    }
    throw redirect({ to: '/session/$sessionId', params: { sessionId: session.data }, replace: true })
  },
})
