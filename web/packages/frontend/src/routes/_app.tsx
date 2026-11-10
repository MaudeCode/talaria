import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useBootstrap } from '../app/bootstrap'
import { useSessionListStream } from '../features/sessions/useSessionListStream'
import { startPresence } from '../features/presence/presence'
import { isAuthenticated } from '../contracts/bootstrap'
import { legacyHashRoute } from '../contracts/url'
import { checkExternalLink } from '../api/endpoints'
import { LinkCheckContext } from '../features/chat/render/LinkCheckContext'
import { ExtensionTtsHosts } from '../features/extensions/ExtensionRoute'
import { AppShell } from '../shell/AppShell'

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
  useSessionListStream()
  // One presence lease per tab for the whole authenticated session, not per page.
  useEffect(() => startPresence(), [])
  // Signed-in chat Markdown asks the server whether a link skips the warning.
  // Extension TTS engines stay registered on every page, not only while their panel is open.
  // TAL-2099: a profile switch remounts the page, so no editor or form keeps the previous profile's state. A new chat
  // stays mounted: its unsent draft carries over to the new profile.
  const profile = useBootstrap().profile?.name ?? ''
  // The rendered page, not a pending navigation: keying on the target would remount the page being left.
  const newChat = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).pathname === '/' })
  return <LinkCheckContext value={checkExternalLink}><AppShell><Outlet key={newChat ? 'new-chat' : `profile:${profile}`} /></AppShell><ExtensionTtsHosts /></LinkCheckContext>
}
