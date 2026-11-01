/**
 * The activate handler sweeps the pre-HWEB-100 worker's `hermes-shell-<version>` caches, which that
 * worker only ever pruned among its own siblings; nothing else removes them after an upgrade.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('workbox-precaching', () => ({ precache: () => undefined, getCacheKeyForURL: () => undefined, cleanupOutdatedCaches: () => undefined, matchPrecache: () => Promise.resolve(undefined) }))
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

describe('service worker locale cache', () => {
  it('keeps only the reported locale chunk and ignores URLs outside the assets', async () => {
    vi.resetModules()
    const entries = new Map<string, true>([['http://x/assets/locale-de-old.js', true]])
    const cache = {
      match: (url: string) => Promise.resolve(entries.has(url) ? new Response('') : undefined),
      add: (url: string) => { entries.set(url, true); return Promise.resolve() },
      keys: () => Promise.resolve([...entries.keys()].map((url) => ({ url }))),
      delete: (request: { url: string }) => Promise.resolve(entries.delete(request.url)),
    }
    const listeners: Record<string, (ev: unknown) => void> = {}
    vi.stubGlobal('self', {
      addEventListener: (name: string, fn: (ev: unknown) => void) => { listeners[name] = fn },
      registration: { scope: 'http://x/' },
      location: { origin: 'http://x' },
      __WB_MANIFEST: [],
    })
    vi.stubGlobal('caches', { open: (name: string) => Promise.resolve(name === 'hermes-locale-v1' ? cache : null) })
    await import('./sw')
    const post = async (url: string) => {
      const waits: Promise<unknown>[] = []
      listeners.message?.({ data: { type: 'CACHE_LOCALE', url }, waitUntil: (p: Promise<unknown>) => { waits.push(p) } })
      await Promise.all(waits)
    }
    await post('http://x/assets/locale-ja-new.js')
    expect([...entries.keys()]).toEqual(['http://x/assets/locale-ja-new.js'])
    await post('http://evil.example/assets/locale-ja.js')
    await post('http://x/api/settings')
    expect([...entries.keys()]).toEqual(['http://x/assets/locale-ja-new.js'])
  })
})

describe('service worker push alerts', () => {
  async function boot(windows: { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }[] = []) {
    vi.resetModules()
    const listeners: Record<string, (ev: unknown) => void> = {}
    const shown: { title: string; options: NotificationOptions }[] = []
    const openWindow = vi.fn(() => Promise.resolve(null))
    vi.stubGlobal('self', {
      addEventListener: (name: string, fn: (ev: unknown) => void) => { listeners[name] = fn },
      registration: { scope: 'http://x/mount/', showNotification: (title: string, options: NotificationOptions) => { shown.push({ title, options }); return Promise.resolve() } },
      clients: { matchAll: vi.fn(() => Promise.resolve(windows)), openWindow },
      location: { origin: 'http://x' },
      __WB_MANIFEST: [],
    })
    await import('./sw')
    const dispatch = async (name: string, event: object) => {
      const waits: Promise<unknown>[] = []
      listeners[name]?.({ ...event, waitUntil: (p: Promise<unknown>) => { waits.push(p) } })
      await Promise.all(waits)
    }
    return { dispatch, shown, openWindow }
  }
  const click = (url: unknown) => ({ notification: { data: { url }, close: vi.fn() } })

  it('shows the server payload exactly as sent, tagged per chat', async () => {
    const { dispatch, shown } = await boot()
    await dispatch('push', { data: { json: () => ({ title: 'Deploy review', body: 'Approval needed', tag: 's1', url: '/session/s1' }) } })
    expect(shown).toEqual([{ title: 'Deploy review', options: { body: 'Approval needed', tag: 's1', data: { url: '/session/s1' } } }])
    await dispatch('push', { data: { json: () => { throw new SyntaxError('not json') } } })
    await dispatch('push', { data: null })
    expect(shown).toHaveLength(1)
  })

  it('focuses an open Talaria window and moves it to the chat under the mount root', async () => {
    const win = { url: 'http://x/mount/session/other', focus: vi.fn(() => Promise.resolve()), navigate: vi.fn(() => Promise.resolve({})) }
    const { dispatch, openWindow } = await boot([win])
    const event = click('/session/s1')
    await dispatch('notificationclick', event)
    expect(event.notification.close).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(win.navigate).toHaveBeenCalledWith('http://x/mount/session/s1')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('opens a new window when no Talaria window is open, and never leaves the origin', async () => {
    const { dispatch, openWindow } = await boot()
    await dispatch('notificationclick', click('/session/s1'))
    expect(openWindow).toHaveBeenCalledWith('http://x/mount/session/s1')
    openWindow.mockClear()
    await dispatch('notificationclick', click('https://evil.example/x'))
    expect(openWindow).not.toHaveBeenCalled()
    await dispatch('notificationclick', click('//evil.example/x'))
    expect(openWindow).toHaveBeenCalledWith('http://x/mount/evil.example/x')
  })
})
