/**
 * The contract client (HWEB-100 → TAL-245): every route call is typed by
 * `@maudecode/talaria-web-contracts` and travels through the same transport
 * as `request()` (app-root resolution, CSRF header, 401 redirect, typed
 * errors). TanStack Query hooks wrap these calls in `app/queries.ts`.
 */
import { createORPCClient } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { routeContract } from '@maudecode/talaria-web-contracts'
import { contractFetch } from './client'
import { appRoot } from '../lib/appRoot'

export type ContractClient = ContractRouterClient<typeof routeContract>
const DEFAULT_TIMEOUT_MS = 30_000
/** Per-call timeout for long routes: `orpc().chat.start(body, { signal: timeout(60_000) })`. */
export const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms)

function createClient(): ContractClient {
  const link = new OpenAPILink(routeContract, {
    // Contract paths are absolute (`/api/...`); the app root carries any subpath mount.
    url: () => appRoot().href.replace(/\/+$/, ''),
    fetch: (request, init, options) => contractFetch(options.signal ? request : new Request(request, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })),
  })
  return createORPCClient(link)
}

let client: ContractClient | null = null

/** Lazily built so tests can reset the app root and transport between cases. */
export function orpc(): ContractClient {
  client ??= createClient()
  return client
}

export function resetOrpcForTests(): void {
  client = null
}
