import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { isAuthenticated } from '../contracts/bootstrap'
import { legacyHashRoute } from '../contracts/url'

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
  component: () => <Outlet />,
})
