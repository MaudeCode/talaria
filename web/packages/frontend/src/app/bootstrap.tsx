/**
 * Bootstrap state: the validated `/api/bootstrap` payload, loaded once before
 * the router renders and refreshed after login, logout, and profile switch.
 */
import { createContext, useContext } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { Bootstrap } from '../contracts/bootstrap'
import { configureClient } from '../api/client'
import { fetchBootstrap } from '../api/endpoints'
import { teardownAll } from '../stream/connection'
import { appUrl } from '../lib/appRoot'
import { bootLocale } from '../i18n/runtime'
import { resetIdentityCache } from '../api/queryClient'
import { keys } from '../api/queryKeys'

/** `requestedAt`: when the request that produced `data` left, so its shell never overwrites a later read. */
export type BootstrapStatus = { state: 'ready'; data: Bootstrap; requestedAt: number } | { state: 'error'; error: unknown }

const listeners = new Set<() => void>()
let current: BootstrapStatus | null = null
let inflight: Promise<Bootstrap> | null = null

function handleAuthExpired(next: string): void {
  teardownAll()
  resetIdentityCache()
  window.location.assign(appUrl(`login?next=${encodeURIComponent(next)}`).href)
}

export async function loadBootstrap(): Promise<Bootstrap> {
  if (inflight) return inflight
  inflight = (async () => {
    const requestedAt = Date.now()
    try {
      const data = await fetchBootstrap()
      configureClient({ csrfToken: data.csrf_token, authEnabled: data.auth.auth_enabled, onUnauthorized: handleAuthExpired })
      await bootLocale(data.language, data.browser_language)
      current = { state: 'ready', data, requestedAt }
      return data
    } catch (error) {
      current = { state: 'error', error }
      throw error
    } finally {
      inflight = null
      for (const l of listeners) l()
    }
  })()
  return inflight
}

export function bootstrapStatus(): BootstrapStatus | null {
  return current
}

export function subscribeBootstrap(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setBootstrapForTests(data: Bootstrap): void {
  current = { state: 'ready', data, requestedAt: Date.now() }
  configureClient({ csrfToken: data.csrf_token, authEnabled: data.auth.auth_enabled, onUnauthorized: handleAuthExpired })
  for (const l of listeners) l()
}

/**
 * TAL-1712: seed the queries the server shipped in `bootstrap.shell` (the bodies of `/api/settings`, `/api/profiles`,
 * `/api/workspaces` and `/api/projects`), so their hooks mount fresh and skip the first read. A query the client read
 * after the bootstrap request left keeps its own, newer data.
 */
export function seedShellQueries(qc: QueryClient, status: BootstrapStatus | null): void {
  if (status?.state !== 'ready' || !status.data.shell) return
  const { shell } = status.data
  for (const [key, data] of [[keys.settings, shell.settings], [keys.profiles, shell.profiles], [keys.workspaces, shell.workspaces], [keys.projects, shell.projects]] as const) {
    if ((qc.getQueryState(key)?.dataUpdatedAt ?? 0) > status.requestedAt) continue
    qc.setQueryData(key, data, { updatedAt: status.requestedAt })
  }
}

export const BootstrapContext = createContext<Bootstrap | null>(null)

export function useBootstrap(): Bootstrap {
  const value = useContext(BootstrapContext)
  if (!value) throw new Error('useBootstrap outside BootstrapContext')
  return value
}
