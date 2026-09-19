/**
 * Service worker registration, as the legacy shell did on `load`. The worker
 * (src/sw.ts) waits for SKIP_WAITING before taking over; once a new version has
 * installed behind a controlled page it is told to activate, so the next
 * navigation runs the new build. Skipped in dev and where unsupported.
 */
export function registerServiceWorker(appRoot: URL): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', appRoot).href, { scope: appRoot.pathname }).then((reg) => {
      const activateWhenInstalled = (worker: ServiceWorker | null) => {
        if (!worker) return
        worker.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING' }) })
      }
      if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      reg.addEventListener('updatefound', () => activateWhenInstalled(reg.installing))
    }).catch((err: unknown) => { console.warn('[pwa] service worker registration failed', err) })
  })
}
