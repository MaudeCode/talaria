import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { startPresence } from '../features/presence/presence'
import { isAuthenticated } from '../contracts/bootstrap'
import { legacyHashRoute } from '../contracts/url'
import { checkExternalLink } from '../api/endpoints'
import { LinkCheckContext } from '../features/chat/render/Markdown'
import { ExtensionTtsHosts } from '../features/extensions/ExtensionRoute'

/**
 * Authenticated application layout. Authorization is server-owned (the shell
 * itself is 302'd to /login); these guards only avoid rendering a dead UI.
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (!isAuthenticated(context.bootstrap)) {
      throw redirect({ to: '/login', search: { next: location.pathname + location.searchStr } })
    }
    if (context.bootstrap.onboarding && !context.bootstrap.onboarding.completed && location.pathname !== '/onboarding') {
      throw redirect({ to: '/onboarding' })
    }
    const hashTarget = legacyHashRoute(location.hash)
    if (hashTarget && hashTarget !== location.pathname) throw redirect({ to: hashTarget })
  },
  component: AppLayout,
})

function AppLayout() {
  // One presence lease per tab for the whole authenticated session, not per page.
  useEffect(() => startPresence(), [])
  // Signed-in chat Markdown asks the server whether a link skips the warning.
  // Extension TTS engines stay registered on every page, not only while their panel is open.
  return <LinkCheckContext value={checkExternalLink}><Outlet /><ExtensionTtsHosts /></LinkCheckContext>
}
