import { createRouter } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import { routerBasepath } from './lib/appRoot'
import type { Bootstrap } from './contracts/bootstrap'
import type { RouterContext } from './routes/__root'
import { NotFound, RouteError } from './features/shell/ErrorBoundary'

export interface CreateRouterOptions {
  root?: URL
  queryClient: QueryClient
  bootstrap: Bootstrap
}

export function getRouter(opts?: CreateRouterOptions) {
  return createRouter({
    routeTree,
    basepath: opts?.root ? routerBasepath(opts.root) : '/',
    // The prerender (SSR shell) calls getRouter() without options; the client always passes them.
    context: { queryClient: opts?.queryClient, bootstrap: opts?.bootstrap } as unknown as RouterContext,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultStructuralSharing: true,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    notFoundMode: 'root',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
