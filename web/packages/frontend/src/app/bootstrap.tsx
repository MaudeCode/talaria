/**
 * Bootstrap state: the validated `/api/bootstrap` payload, loaded once before
 * the router renders and refreshed after login, logout, and profile switch.
 */
import { createContext, useContext } from 'react'
import type { Bootstrap } from '../contracts/bootstrap'
import { configureClient } from '../api/client'
import { fetchBootstrap } from '../api/endpoints'
import { bootLocale } from '../i18n/runtime'

export type BootstrapStatus = { state: 'ready'; data: Bootstrap } | { state: 'error'; error: unknown }

const listeners = new Set<() => void>()
let current: BootstrapStatus | null = null
let inflight: Promise<Bootstrap> | null = null

export async function loadBootstrap(): Promise<Bootstrap> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = await fetchBootstrap()
      configureClient({ csrfToken: data.csrf_token, authEnabled: data.auth.auth_enabled })
      bootLocale(data.language)
      current = { state: 'ready', data }
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
  current = { state: 'ready', data }
  configureClient({ csrfToken: data.csrf_token, authEnabled: data.auth.auth_enabled })
  for (const l of listeners) l()
}

export const BootstrapContext = createContext<Bootstrap | null>(null)

export function useBootstrap(): Bootstrap {
  const value = useContext(BootstrapContext)
  if (!value) throw new Error('useBootstrap outside BootstrapContext')
  return value
}
