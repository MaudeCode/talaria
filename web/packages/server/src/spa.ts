/**
 * The production SPA shell from `static/dist` (Python `api/spa_shell.py`):
 * route allowlist, placeholder substitution, hashed assets with ETag/gzip.
 */
import { gzipSync } from 'node:zlib'
import { readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve, isAbsolute } from 'node:path'

export const SPA_EXACT_PATHS = new Set([
  '/', '/index.html', '/sessions', '/tasks', '/kanban', '/skills', '/memory', '/workspaces', '/profiles', '/todos', '/insights', '/logs',
  '/settings', '/onboarding', '/login', '/share',
])
export const SPA_PREFIX_PATHS = ['/session/', '/tasks/', '/kanban/', '/skills/', '/memory/', '/workspaces/', '/profiles/', '/settings/', '/ext/', '/share/']
export const SERVER_OWNED_PREFIXES = ['/api/', '/assets/', '/static/', '/extensions/', '/plugins/', '/dashboard-plugins/', '/session/static/']
export const SERVER_OWNED_EXACT = new Set(['/health', '/sw.js', '/manifest.json', '/manifest.webmanifest', '/favicon.ico', '/search', '/session/manifest.json', '/session/manifest.webmanifest'])
export const SPA_PUBLIC_EXACT = new Set(['/login', '/share'])
export const SPA_PUBLIC_PREFIXES = ['/share/']

const ASSET_MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.webmanifest', '.svg', '.txt', '.map'])

export function isServerOwned(path: string): boolean {
  return SERVER_OWNED_EXACT.has(path) || SERVER_OWNED_PREFIXES.some((p) => path.startsWith(p))
}

export function isSpaPath(path: string): boolean {
  if (isServerOwned(path)) return false
  if (SPA_EXACT_PATHS.has(path)) return true
  return SPA_PREFIX_PATHS.some((p) => path.startsWith(p))
}

export function isPublicSpaPath(path: string): boolean {
  return SPA_PUBLIC_EXACT.has(path) || SPA_PUBLIC_PREFIXES.some((p) => path.startsWith(p))
}

/** `/` and `/settings` -> `./`; `/session/abc` -> `../`. */
export function baseHrefFor(path: string): string {
  const depth = Math.max(0, path.split('/').filter(Boolean).length - 1)
  return depth ? '../'.repeat(depth) : './'
}

export interface Asset { body: Buffer; gz: Buffer | null; etag: string; contentType: string }

/** Percent-encode like Python `urllib.parse.quote(value, safe='')`. */
export function quoteAll(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%7E/g, '~')
}

/** Cached files under one root: raw bytes, gzip twin for compressible types over 1 KiB, weak ETag from (size, mtime_ns). */
export class AssetCache {
  readonly root: string
  private readonly entries = new Map<string, { sig: string; asset: Asset }>()

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** Resolve `<root>/<rel>`; null when missing, not a file, or escaping the root. */
  get(rel: string): Asset | null {
    const file = resolve(this.root, rel)
    const inside = relative(this.root, file)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
    let st
    try {
      st = statSync(file, { bigint: true })
    } catch {
      return null
    }
    if (!st.isFile()) return null
    const sig = `${st.size}:${st.mtimeNs}`
    const cached = this.entries.get(file)
    if (cached?.sig === sig) return cached.asset
    const body = readFileSync(file)
    const ext = extname(file).toLowerCase()
    const gz = COMPRESSIBLE.has(ext) && body.length > 1024 ? gzipSync(body, { level: 6 }) : null
    const etag = `W/"${st.size.toString(16)}-${st.mtimeNs.toString(16)}"`
    const asset: Asset = { body, gz, etag, contentType: ASSET_MIME[ext] ?? 'application/octet-stream' }
    this.entries.set(file, { sig, asset })
    return asset
  }
}

export class SpaShell {
  readonly distRoot: string
  private readonly assets: AssetCache
  private shell: { sig: string; text: string } | null = null

  constructor(distRoot: string) {
    this.distRoot = resolve(distRoot)
    this.assets = new AssetCache(this.distRoot)
  }

  available(): boolean {
    try {
      return statSync(resolve(this.distRoot, 'index.html')).isFile()
    } catch {
      return false
    }
  }

  private readTemplate(): string {
    const file = resolve(this.distRoot, 'index.html')
    const st = statSync(file, { bigint: true })
    const sig = `${st.size}:${st.mtimeNs}`
    if (this.shell?.sig === sig) return this.shell.text
    const text = readFileSync(file, 'utf8')
    this.shell = { sig, text }
    return text
  }

  /** The exact frontend build this shell loads, stamped by `finalize-dist` from the shipped assets; null when unreadable. */
  buildId(): string | null {
    try {
      return /<meta name="talaria-build" content="([a-f0-9]{64})"/.exec(this.readTemplate())?.[1] ?? null
    } catch {
      return null
    }
  }

  renderShell(path: string, opts: { lang?: string; version: string }): string {
    const lang = opts.lang ?? 'en'
    const safeLang = lang && /^[A-Za-z0-9-]+$/.test(lang) && /[A-Za-z0-9]/.test(lang) && lang.length <= 16 ? lang : 'en'
    return this.readTemplate()
      .replaceAll('__BASE_HREF__', baseHrefFor(path))
      .replaceAll('__LANG__', safeLang)
      .replaceAll('__WEBUI_VERSION__', quoteAll(opts.version))
  }

  /** Resolve `static/dist/<rel>` inside the root; null when missing or escaping. */
  asset(rel: string): Asset | null {
    return this.assets.get(rel)
  }

  serviceWorker(version: string): Buffer | null {
    const file = resolve(this.distRoot, 'sw.js')
    try {
      if (!statSync(file).isFile()) return null
    } catch {
      return null
    }
    return Buffer.from(readFileSync(file, 'utf8').replaceAll('__WEBUI_VERSION__', quoteAll(version)), 'utf8')
  }
}
