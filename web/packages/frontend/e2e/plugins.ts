import type { Page } from '@playwright/test'
import { pluginListing } from '../../server/dist/tools/plugin-listing.js'

/** Stubs `/api/plugins` with the server's own `q` filter, `total`, groups and figures over `answer()` (TAL-2129, TAL-2132); a row without `source` is one the profile installed. */
export async function routePlugins(page: Page, answer: () => { plugins: { key: string; name?: string; description?: string; source?: 'installed' | 'bundled' }[] } & Record<string, unknown>): Promise<void> {
  await page.route((url) => url.pathname === '/api/plugins', (route) => {
    const body = answer()
    const rows = body.plugins.map((row) => ({ source: 'installed' as const, ...row }))
    return route.fulfill({ json: { ...body, ...pluginListing(rows, new URL(route.request().url()).searchParams.get('q') ?? '') } })
  })
}
