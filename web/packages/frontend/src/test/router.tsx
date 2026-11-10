import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'

/** Renders `ui` as the one page of a loaded memory router, for a component that links to a route or goes back in history. */
export async function renderRouted(ui: ReactNode) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  return render(<RouterProvider router={router} />)
}
