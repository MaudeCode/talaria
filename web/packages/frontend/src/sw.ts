/// <reference lib="webworker" />
/**
 * Hermes WebUI service worker (HWEB-100). Built by scripts/build-sw.mjs with
 * the workbox injectManifest strategy: the shell precache list is injected at
 * build time.
 *
 * Behaviour carried over from the legacy sw.js:
 * - precache the app shell (index.html, entry chunks, stylesheet, manifest);
 * - hashed lazy chunks are cached on first use (cache-first, bounded);
 * - never cache API responses or SSE (the UI needs a live backend);
 * - navigations are network-first and fall back to the cached shell so an
 *   installed app still opens offline and shows its own offline notice;
 * - obsolete precaches from previous builds are removed on activate;
 * - activation waits for the page's confirmation (`SKIP_WAITING` message) so
 *   the in-app update prompt controls when the new version takes over;
 * - the scope is the mount root, so subpath installs keep working.
 */
import { cleanupOutdatedCaches, precacheAndRoute, matchPrecache } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import type { WorkboxPlugin } from 'workbox-core'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] }

const SHELL_URL = './index.html'
const ASSET_CACHE = 'hermes-assets-v1'

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Hashed, immutable chunks under the mount root: cache on first use, keep a bounded set.
registerRoute(
  ({ url, request }) => request.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith(new URL('./assets/', self.registration.scope).pathname),
  new CacheFirst({ cacheName: ASSET_CACHE, plugins: [new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true }) as unknown as WorkboxPlugin] }),
)

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data: unknown = event.data
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // The pre-HWEB-100 worker kept the legacy shell in `hermes-shell-<version>` caches and only
    // deleted siblings of its own name; nothing else ever removes them after an upgrade.
    const legacy = (await caches.keys()).filter((k) => k.startsWith('hermes-shell-'))
    await Promise.all(legacy.map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

function isServerOwned(url: URL, scope: URL): boolean {
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname
  return rel.startsWith('api/') || rel === 'health' || rel.startsWith('extensions/') || rel.startsWith('plugins/') || rel.startsWith('dashboard-plugins/') || rel === 'sw.js' || (!rel.startsWith('static/') && rel.includes('/static/'))
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const scope = new URL(self.registration.scope)
  if (isServerOwned(url, scope)) return
  if (request.mode !== 'navigate') return
  // Navigation: network first; offline falls back to the precached shell. A login
  // redirect is a network response, so it is never replaced by the app shell.
  event.respondWith(
    (async () => {
      try {
        return await fetch(request)
      } catch {
        const shell = await matchPrecache(SHELL_URL)
        if (shell) return shell
        return new Response('Hermes is offline and no cached shell is available.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    })(),
  )
})
