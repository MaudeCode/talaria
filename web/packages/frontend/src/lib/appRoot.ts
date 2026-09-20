/**
 * The application root URL (the mount point) derived once from the `<base>`
 * element the Python shell renders as a relative depth prefix. Freezing it to
 * an absolute URL matters: the document base URL is re-resolved against the
 * current location after `pushState`, so a relative `<base href="./">` would
 * drift after the first client-side navigation.
 */
let frozen: URL | null = null

export function freezeAppRoot(): URL {
  if (frozen) return frozen
  const root = new URL(document.baseURI)
  root.search = ''
  root.hash = ''
  if (!root.pathname.endsWith('/')) root.pathname = root.pathname.replace(/[^/]*$/, '')
  const base = document.querySelector('base')
  // The Vite dev server renders no <base>; there the app is mounted at the origin root.
  if (!base && import.meta.env.DEV) root.pathname = '/'
  if (base) base.href = root.href
  frozen = root
  return root
}

export function appRoot(): URL {
  return frozen ?? freezeAppRoot()
}

/** Resolve an app-relative path such as `api/sessions` or `/api/sessions` against the mount root. */
export function appUrl(path: string): URL {
  return new URL(path.replace(/^\/+/, ''), appRoot())
}

/** Router basepath: the mount pathname without its trailing slash, `/` for a root mount. */
export function routerBasepath(root: URL = appRoot()): string {
  const p = root.pathname.replace(/\/+$/, '')
  return p === '' ? '/' : p
}

/** For tests: forget the frozen root. */
export function resetAppRootForTests(): void {
  frozen = null
}
