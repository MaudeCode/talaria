import type { Page } from '@playwright/test'
import { pluginListing } from '../../server/dist/tools/plugin-listing.js'

/** Stubs `/api/plugins` with the server's own `q` filter and `total` over `answer()` (TAL-2129). */
export async function routePlugins(page: Page, answer: () => { plugins: { key: string; name?: string; description?: string }[] } & Record<string, unknown>): Promise<void> {
  await page.route((url) => url.pathname === '/api/plugins', (route) => {
    const body = answer()
    return route.fulfill({ json: { ...body, ...pluginListing(body.plugins, new URL(route.request().url()).searchParams.get('q') ?? '') } })
  })
}
