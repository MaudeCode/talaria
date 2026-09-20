import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Bootstrap } from '../contracts/bootstrap'
import { NotFound, PendingView, RouteError } from '../features/shell/ErrorBoundary'
import interWoff2 from '../theme/fonts/InterVariable.woff2?url'
import prepaintUrl from '../theme/prepaint.js?url'
// Stylesheets belong to the root route, not the client entry: the route's CSS is linked in <head> of the
// prerendered shell and of the dev document, so the first-paint frame (#app:empty) is styled before the module runs.
import '../theme/tailwind.css'
import 'virtual:hermes-theme.css'

export interface RouterContext {
  queryClient: QueryClient
  bootstrap: Bootstrap
}

/**
 * Root route. The shell component describes the static HTML document the SPA
 * prerender emits (`static/dist/index.html`). It contains no server-rendered
 * UI: the client entry mounts into #app. Every href here is relative so the
 * Python-injected <base href> resolves it under any mount prefix.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'Hermes' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'apple-mobile-web-app-title', content: 'Hermes' },
      { name: 'theme-color', content: '#0D0D1A' },
      { name: 'color-scheme', content: 'dark light' },
    ],
    links: [
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: 'static/brand/favicon-32.png' },
      { rel: 'shortcut icon', href: 'static/brand/favicon.ico' },
      { rel: 'icon', type: 'image/svg+xml', sizes: 'any', href: 'static/brand/favicon.svg' },
      { rel: 'apple-touch-icon', sizes: '512x512', href: 'static/brand/apple-touch-icon.png' },
      { rel: 'manifest', href: 'manifest.webmanifest', crossOrigin: 'use-credentials' },
      // Inter uses font-display: optional; preloading (as the legacy shell did) keeps it from losing the first-paint race.
      { rel: 'preload', href: interWoff2, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
    ],
    // Blocking, before the body: paints the persisted theme/skin so a reload never flashes the other theme.
    scripts: [{ src: prepaintUrl }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
  pendingComponent: PendingView,
})

/**
 * The router wraps the root match in `shellComponent` on the client as well as
 * during the prerender. Only the prerender (Node) emits the document; in the
 * browser the entry already mounted into #app, so the shell is a passthrough.
 */
function RootShell({ children }: { children: ReactNode }) {
  if (typeof window !== 'undefined') return <>{children}</>
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="app">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  return <Outlet />
}
