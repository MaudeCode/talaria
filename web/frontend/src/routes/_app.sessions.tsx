import { createFileRoute, redirect } from '@tanstack/react-router'

/** `/sessions` is where the Python login flow redirects; the chat root owns it (legacy `#sessions` mapped the same way). */
export const Route = createFileRoute('/_app/sessions')({
  beforeLoad: () => { throw redirect({ to: '/', search: {}, replace: true }) },
})
