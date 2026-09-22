/**
 * The activate handler sweeps the pre-HWEB-100 worker's `hermes-shell-<version>` caches, which that
 * worker only ever pruned among its own siblings; nothing else removes them after an upgrade.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('workbox-precaching', () => ({ precacheAndRoute: () => undefined, cleanupOutdatedCaches: () => undefined, matchPrecache: () => Promise.resolve(undefined) }))
vi.mock('workbox-routing', () => ({ registerRoute: () => undefined }))
vi.mock('workbox-strategies', () => ({ CacheFirst: class { handle = vi.fn() } }))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class { name = 'expiration' } }))

describe('service worker activate', () => {
  it('deletes legacy hermes-shell caches and keeps everything else', async () => {
    const store = new Set(['hermes-shell-v0.52.100', 'hermes-shell-v0.52.270', 'workbox-precache-v2-http://x/', 'hermes-assets-v1'])
    const listeners: Record<string, (ev: unknown) => void> = {}
    const waits: Promise<unknown>[] = []
    vi.stubGlobal('self', {
      addEventListener: (name: string, fn: (ev: unknown) => void) => { listeners[name] = fn },
      clients: { claim: vi.fn(() => Promise.resolve()) },
      skipWaiting: vi.fn(),
      registration: { scope: 'http://x/' },
      location: { origin: 'http://x' },
      __WB_MANIFEST: [],
    })
    vi.stubGlobal('caches', { keys: () => Promise.resolve([...store]), delete: (k: string) => Promise.resolve(store.delete(k)) })
    await import('./sw')
    listeners.activate?.({ waitUntil: (p: Promise<unknown>) => { waits.push(p) } })
    await Promise.all(waits)
    expect([...store].sort()).toEqual(['hermes-assets-v1', 'workbox-precache-v2-http://x/'])
  })
})
