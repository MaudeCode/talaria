import type { Page } from '@playwright/test'
import { providerListing } from '../../server/dist/providers/catalog.js'

/** Stubs `/api/providers` with the server's own shaping of `answer()`: the `q` filter and its groups (TAL-2127). */
export async function routeProviders(page: Page, answer: () => { providers: Record<string, unknown>[] } & Record<string, unknown>): Promise<void> {
  await page.route((url) => url.pathname === '/api/providers', (route) => route.fulfill({ json: providerListing(answer(), new URL(route.request().url()).searchParams.get('q') ?? '') }))
}
