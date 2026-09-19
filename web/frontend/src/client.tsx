// Client entry: a client-only React root. The prerendered shell contains no
// server-rendered UI and no inline scripts (see scripts/finalize-dist.mjs), so
// there is nothing to hydrate. Order matters: freeze the base URL and apply
// persisted appearance before the first paint, load the bootstrap payload,
// then mount the router with its Query client.
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { freezeAppRoot } from './lib/appRoot'
import { applyBootAppearance } from './theme/boot'
import { getRouter } from './router'
import { createQueryClient } from './api/queryClient'
import { loadBootstrap, bootstrapStatus, subscribeBootstrap, BootstrapContext } from './app/bootstrap'
import type { Bootstrap } from './contracts/bootstrap'
import { FatalError } from './features/shell/ErrorBoundary'
import { registerServiceWorker } from './app/pwa'

const appRoot = freezeAppRoot()
applyBootAppearance()
registerServiceWorker(appRoot)

const container = document.getElementById('app')
if (!container) throw new Error('missing #app mount node')
const root = createRoot(container)

/** Provides the latest bootstrap payload: `loadBootstrap()` after login, onboarding or a profile switch re-renders consumers. */
function BootstrapProvider({ initial, children }: { initial: Bootstrap; children: ReactNode }) {
  const status = useSyncExternalStore(subscribeBootstrap, bootstrapStatus, bootstrapStatus)
  return <BootstrapContext.Provider value={status?.state === 'ready' ? status.data : initial}>{children}</BootstrapContext.Provider>
}

loadBootstrap().then(
  (bootstrap) => {
    const queryClient = createQueryClient()
    const router = getRouter({ root: appRoot, queryClient, bootstrap })
    // Route guards read the router context, so a refreshed payload must reach it before the next navigation.
    subscribeBootstrap(() => { const s = bootstrapStatus(); if (s?.state === 'ready') router.update({ context: { queryClient, bootstrap: s.data } }) })
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BootstrapProvider initial={bootstrap}>
            <RouterProvider router={router} />
          </BootstrapProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
  },
  (error: unknown) => {
    root.render(<FatalError error={error} />)
  },
)
