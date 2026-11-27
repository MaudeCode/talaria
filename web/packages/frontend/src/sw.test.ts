import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRoute } from 'workbox-routing'

vi.mock('workbox-precaching', () => ({ precache: () => undefined, getCacheKeyForURL: () => undefined, cleanupOutdatedCaches: () => undefined, matchPrecache: () => Promise.resolve(undefined) }))
vi.mock('workbox-routing', () => ({ registerRoute: vi.fn() }))
vi.mock('workbox-strategies', () => ({ CacheFirst: class { handle = vi.fn() } }))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class { name = 'expiration' } }))

afterEach(() => vi.unstubAllGlobals())

describe('service worker locale cache', () => {
  const origin = 'https://talaria.test'
  const roots = [`${origin}/`, `${origin}/mount/`] as const
  const legacyCache = 'hermes-locale-v1'
  const chunk = (scope: string, language: string) => new URL(`assets/locale-${language}.js`, scope).href

  function cacheStorage() {
    const stores = new Map<string, Map<string, Response>>()
    return {
      match: (request: Request | string, { cacheName }: CacheQueryOptions & { cacheName: string }) =>
        Promise.resolve(stores.get(cacheName)?.get(typeof request === 'string' ? request : request.url)?.clone()),
      open: (name: string) => {
        const entries = stores.get(name) ?? new Map<string, Response>()
        stores.set(name, entries)
        return Promise.resolve({
          match: (url: string) => Promise.resolve(entries.get(url)?.clone()),
          add: async (url: string) => { entries.set(url, await fetch(url)) },
          put: (url: string, response: Response) => { entries.set(url, response.clone()); return Promise.resolve() },
          keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
          delete: (request: Request) => Promise.resolve(entries.delete(request.url)),
        })
      },
    }
  }

  async function boot(scope: string) {
    vi.resetModules()
    vi.mocked(registerRoute).mockClear()
    const listeners: Record<string, (ev: unknown) => void> = {}
    const worker = {
      addEventListener: (name: string, fn: (ev: unknown) => void) => { listeners[name] = fn },
      registration: { scope },
      location: { origin },
      __WB_MANIFEST: [],
    }
    vi.stubGlobal('self', worker)
    await import('./sw')
    const routes = vi.mocked(registerRoute).mock.calls.slice()
    const post = async (url: string) => {
      vi.stubGlobal('self', worker)
      const waits: Promise<unknown>[] = []
      listeners.message?.({ data: { type: 'CACHE_LOCALE', url }, waitUntil: (p: Promise<unknown>) => { waits.push(p) } })
      await Promise.all(waits)
    }
    const read = async (href: string) => {
      vi.stubGlobal('self', worker)
      const url = new URL(href)
      const request = new Request(url)
      const options = { url, request, sameOrigin: url.origin === origin, event: new Event('fetch') as ExtendableEvent }
      for (const [match, handle] of routes) {
        if (typeof match === 'function' && match(options) && typeof handle === 'function') {
          return (await handle(options))?.text()
        }
      }
    }
    return { post, read }
  }

  it.each(roots)('changing the language at %s keeps the other install available offline', async (switchingScope) => {
    vi.stubGlobal('caches', cacheStorage())
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(new Response(url)))
    const otherScope = roots.find((scope) => scope !== switchingScope)!
    const switching = await boot(switchingScope)
    const other = await boot(otherScope)
    const original = chunk(switchingScope, 'de')
    const selected = chunk(switchingScope, 'fr')
    const retained = chunk(otherScope, 'ja')

    await switching.post(original)
    await other.post(retained)
    await switching.post(selected)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))

    expect(await switching.read(selected)).toBe(selected)
    expect(await other.read(retained)).toBe(retained)
    expect(await switching.read(original)).toBeUndefined()
  })

  it('retains a legacy locale offline during upgrade, then pins it independently when reported', async () => {
    const storage = cacheStorage()
    vi.stubGlobal('caches', storage)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    const [upgradedScope, otherScope] = roots
    const upgradedLocale = chunk(upgradedScope, 'ja')
    const otherLocale = chunk(otherScope, 'de')
    const legacy = await storage.open(legacyCache)
    await legacy.put(upgradedLocale, new Response('Japanese'))
    await legacy.put(otherLocale, new Response('German'))
    const upgraded = await boot(upgradedScope)

    expect(await upgraded.read(upgradedLocale)).toBe('Japanese')
    await upgraded.post(upgradedLocale)
    expect(await (await legacy.match(otherLocale))?.text()).toBe('German')

    // An old worker can still prune the shared cache while this registration has upgraded.
    await legacy.delete(new Request(upgradedLocale))
    expect(await upgraded.read(upgradedLocale)).toBe('Japanese')
  })

  it('ignores reported URLs outside the registration assets', async () => {
    vi.stubGlobal('caches', cacheStorage())
    const fetchAsset = vi.fn((url: string) => Promise.resolve(new Response(url)))
    vi.stubGlobal('fetch', fetchAsset)
    const worker = await boot(roots[1])
    const selected = chunk(roots[1], 'fr')
    await worker.post(selected)
    fetchAsset.mockClear()

    await worker.post(chunk(roots[0], 'ja'))
    await worker.post('https://elsewhere.test/mount/assets/locale-ja.js')
    await worker.post(`${roots[1]}api/settings`)

    expect(fetchAsset).not.toHaveBeenCalled()
    expect(await worker.read(selected)).toBe(selected)
  })

  it('keeps the newest reported chunk when a prior replacement is still writing', async () => {
    const firstUrl = chunk(roots[0], 'fr')
    const latestUrl = chunk(roots[0], 'ja')
    const writeStarted = Promise.withResolvers<undefined>()
    const releaseWrite = Promise.withResolvers<undefined>()
    vi.stubGlobal('caches', cacheStorage())
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === firstUrl) {
        writeStarted.resolve(undefined)
        await releaseWrite.promise
      }
      return new Response(url)
    })
    const worker = await boot(roots[0])

    const first = worker.post(firstUrl)
    await writeStarted.promise
    const latest = worker.post(latestUrl)
    releaseWrite.resolve(undefined)
    await Promise.all([first, latest])

    expect(await worker.read(latestUrl)).toBe(latestUrl)
    expect(await worker.read(firstUrl)).toBeUndefined()
  })

  it('can replace the locale after a chunk fetch fails', async () => {
    const missingUrl = chunk(roots[0], 'fr')
    const latestUrl = chunk(roots[0], 'ja')
    vi.stubGlobal('caches', cacheStorage())
    vi.stubGlobal('fetch', (url: string) => url === missingUrl
      ? Promise.reject(new Error('chunk unavailable'))
      : Promise.resolve(new Response(url)))
    const worker = await boot(roots[0])

    await expect(worker.post(missingUrl)).rejects.toThrow('chunk unavailable')
    await worker.post(latestUrl)

    expect(await worker.read(latestUrl)).toBe(latestUrl)
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
