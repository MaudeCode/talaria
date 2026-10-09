/**
 * WebUI dashboard plugins (Python `api/plugins.py`): `<plugins>/<name>/dashboard/manifest.json` discovery, the
 * Settings enable gate (`dashboard_plugins`, default off), and the bytes behind `/plugins/plugin.css`, the sandboxed
 * panel document, plugin static assets, and tab pages. A disabled or unknown plugin serves nothing (null → 404).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { escapeHtml } from '../text/markdown.js'
import { htmlWithHeadTag } from '../workspace/media.js'
import { join, resolve } from 'node:path'
import { isDict, type Dict } from '../config/agent-config.js'
import type { Settings } from '../settings.js'
import { pyBool } from '../settings.js'
import { baseHrefFor, isServerOwned, isSpaPath } from '../spa.js'
import { readContainedFile, text } from './extensions.js'

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/
/** A clean same-origin path: one leading `/` (never `//`), no quotes, whitespace, query, or fragment. */
const TAB_PATH_RE = /^\/(?!\/)[A-Za-z0-9._~/-]{0,255}$/
const PANEL_RE = /^\/dashboard-plugins\/([a-z][a-z0-9_-]{0,63})\/index\.html$/
const SHARED_ASSETS = new Set(['plugin.css'])
const ASSET_MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

export interface DashboardPluginDeps { env: Record<string, string | undefined>; hermesHome: string; settings: () => Settings }
interface Plugin { name: string; manifest: Dict; tabPath: string; root: string }
export interface PluginFile { body: Buffer; contentType: string }

/** Add `<base href>` unless the document declares its own. */
function withBase(body: Buffer, href: string): Buffer {
  return /<base\b/i.test(body.toString('utf8')) ? body : htmlWithHeadTag(body, `<base href="${escapeHtml(href)}">`)
}

const html = (body: Buffer | string): PluginFile => ({ body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), contentType: ASSET_MIME['.html'] ?? '' })

export class DashboardPlugins {
  constructor(private readonly deps: DashboardPluginDeps) {}

  base(): string {
    const raw = (this.deps.env.HERMES_WEBUI_PLUGINS_DIR ?? '').trim()
    return resolve(raw || join(this.deps.hermesHome, 'plugins'))
  }

  /**
   * Every valid plugin in name order; the first claimant of a name or tab path wins. A tab path the SPA or a
   * server-owned prefix answers is refused, so a plugin can never shadow the app or `/api`.
   * ponytail: rescans per call (a readdir plus small manifest reads); cache by directory mtime if plugin routes get hot.
   */
  list(): Plugin[] {
    let entries: string[]
    try { entries = readdirSync(this.base()).sort() } catch { return [] }
    const out: Plugin[] = []
    for (const entry of entries) {
      const dir = join(this.base(), entry, 'dashboard')
      let manifest: unknown
      try {
        if (!statSync(dir).isDirectory()) continue
        manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      } catch { continue }
      if (!isDict(manifest)) continue
      // Python `manifest.get("name") or entry.name` and `tab.get("path", f"/{name}")`.
      const name: unknown = manifest.name || entry
      if (typeof name !== 'string' || !NAME_RE.test(name)) continue
      const tab = isDict(manifest.tab) ? manifest.tab : {}
      const rawTabPath = 'path' in tab ? tab.path : `/${name}`
      // Request paths arrive without a trailing slash, so the stored tab path drops it too.
      const tabPath = typeof rawTabPath === 'string' ? rawTabPath.replace(/(?<=.)\/+$/, '') : rawTabPath
      if (typeof tabPath !== 'string' || !TAB_PATH_RE.test(tabPath) || isServerOwned(tabPath) || isSpaPath(tabPath)) continue
      if (out.some((p) => p.name === name || p.tabPath === tabPath)) continue
      out.push({ name, manifest, tabPath, root: dir })
    }
    return out
  }

  /** Python `_dashboard_plugin_enabled`: opt-in per plugin under `dashboard_plugins` in settings.json. */
  enabled(name: string): boolean {
    try {
      const prefs = this.deps.settings().dashboard_plugins
      return isDict(prefs) && pyBool(prefs[name])
    } catch {
      return false
    }
  }

  private enabledPlugin(name: string): Plugin | null {
    if (!this.enabled(name)) return null
    return this.list().find((p) => p.name === name) ?? null
  }

  /** Python `_from_dashboard_plugin`: one panel entry per plugin for `/api/extensions/manifests`. */
  manifests(): Dict[] {
    return this.list().map(({ name, manifest }) => {
      const tab = isDict(manifest.tab) ? manifest.tab : {}
      return {
        id: name, name: text(manifest.label || manifest.name, 80) || name, version: text(manifest.version, 40), description: text(manifest.description, 300),
        source: 'plugin', enabled: this.enabled(name), panel: `dashboard-plugins/${name}/index.html`,
        nav: { label: text(tab.name || manifest.label || manifest.name, 40) || name },
        capabilities: ['settings', 'storage', 'toast', 'session'], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [],
      }
    })
  }

  /** `/plugins/<rel>`: only the shared `plugin.css` under the plugin base. */
  sharedAsset(rel: string): PluginFile | null {
    if (!SHARED_ASSETS.has(rel)) return null
    const found = readContainedFile(this.base(), rel)
    return found ? { body: found.body, contentType: ASSET_MIME['.css'] ?? '' } : null
  }

  /**
   * Python `serve_plugin_static`: built assets under `dist/` or `static/` with an allowlisted extension, no dotfiles.
   * Any other path resolves inside `dist/`, so a `dist/index.html` served as the panel can use its own relative URLs.
   */
  asset(name: string, rel: string): PluginFile | null {
    const plugin = this.enabledPlugin(name)
    if (!plugin) return null
    const top = rel.split('/')[0]
    return this.builtAsset(plugin, top === 'dist' || top === 'static' ? rel : `dist/${rel}`)
  }

  private builtAsset(plugin: Plugin, rel: string): PluginFile | null {
    const top = rel.split('/')[0]
    if (top !== 'dist' && top !== 'static') return null
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    const contentType = rel.includes('.') ? ASSET_MIME[ext] : undefined
    if (!contentType) return null
    const found = readContainedFile(plugin.root, rel)
    return found ? { body: found.body, contentType } : null
  }

  /** `/dashboard-plugins/<name>/index.html` → plugin name, else null. */
  static panelName(path: string): string | null {
    return PANEL_RE.exec(path)?.[1] ?? null
  }

  /**
   * Python `_serve_dashboard_plugin_panel`: `dist/index.html` as-is, or for a legacy IIFE plugin (`dist/index.js`,
   * optional `dist/style.css`) a wrapper that mounts it beside the extension SDK.
   */
  panel(name: string): PluginFile | null {
    const plugin = this.enabledPlugin(name)
    if (!plugin) return null
    const own = this.builtAsset(plugin, 'dist/index.html')
    if (own) return own
    if (!this.builtAsset(plugin, 'dist/index.js')) return null
    const css = this.builtAsset(plugin, 'dist/style.css') ? '<link rel="stylesheet" href="dist/style.css">' : ''
    return html(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>${escapeHtml(text(plugin.manifest.label, 80) || name)}</title>${css}</head><body><div id="root"></div><div id="app"></div>` +
      '<script src="../../static/dist/extension-sdk.js"></script><script src="dist/index.js"></script></body></html>',
    )
  }

  /** The tab page at a plugin's `tab.path`: `dist/index.html`, the plugin's `static/index.html`, or an IIFE shell. */
  tabPage(path: string): PluginFile | null {
    const listed = this.list().find((p) => p.tabPath === path)
    const plugin = listed && this.enabled(listed.name) ? listed : null
    if (!plugin) return null
    const own = this.builtAsset(plugin, 'dist/index.html')
    // The tab page resolves relative URLs like the panel document beside it, at any mount depth.
    if (own) return html(withBase(own.body, `${baseHrefFor(path)}dashboard-plugins/${plugin.name}/`))
    const page = readContainedFile(join(plugin.root, '..'), 'static/index.html')
    if (page) return html(page.body)
    if (!this.builtAsset(plugin, 'dist/index.js')) return null
    const base = `/dashboard-plugins/${plugin.name}/`
    const css = text(plugin.manifest.css, 300)
    const cssTag = css ? `<link rel="stylesheet" href="${escapeHtml(base + css)}">` : ''
    return html(
      `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>${escapeHtml(text(plugin.manifest.label, 80) || plugin.name)}</title>\n  ${cssTag}\n</head>\n` +
      `<body>\n  <div id="pluginPageContainer"></div>\n  <script src="${base}dist/index.js"></script>\n</body>\n</html>\n`,
    )
  }
}
