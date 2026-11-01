/**
 * WebUI dashboard plugins (Python `api/plugins.py`): `<plugins>/<name>/dashboard/manifest.json` discovery, the
 * Settings enable gate (`dashboard_plugins`, default off), and the bytes behind `/plugins/plugin.css`, the sandboxed
 * panel document, plugin static assets, and tab pages. A disabled or unknown plugin serves nothing (null → 404).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { AgentDashboardPluginSchema, SidecarResult } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import type { RequestContext } from '../http/context.js'
import { signAssetGrant, assetGrantValue } from '../auth/crypto.js'
import { activeProfileName } from '../auth/gate.js'
import { SidecarError, type SidecarLike } from '../sidecar/client.js'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { escapeHtml } from '../text/markdown.js'
import { htmlWithHeadTag } from '../workspace/media.js'
import { join, resolve } from 'node:path'
import { isDict, type Dict } from '../config/agent-config.js'
import type { SettingsStore } from '../settings.js'
import { pyBool } from '../settings.js'
import { baseHrefFor, isServerOwned, isSpaPath } from '../spa.js'
import { ExtensionError, readContainedFile, text } from './extensions.js'

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

export interface DashboardPluginDeps { env: Record<string, string | undefined>; hermesHome: string; settings: Pick<SettingsStore, 'load' | 'save'>; sidecar?: () => SidecarLike | null }
interface Plugin { name: string; manifest: Dict; tabPath: string; root: string }
export interface PluginFile { body: Buffer; contentType: string }

export interface AgentDashboardScope { home: string; owner: string }
export const isAgentDashboardId = (id: string): boolean => /^agent-[a-f0-9]{40}$/.test(id)
export function dashboardScope(ctx: RequestContext, profile = activeProfileName(ctx)): AgentDashboardScope {
  return { home: ctx.deps.profileHome(profile), owner: createHash('sha256').update(ctx.authCookie() || ctx.notificationOwner || 'local-owner').digest('hex') }
}
type AgentPlugin = z.infer<typeof AgentDashboardPluginSchema>

/** Add `<base href>` unless the document declares its own. */
function withBase(body: Buffer, href: string): Buffer {
  return /<base\b/i.test(body.toString('utf8')) ? body : htmlWithHeadTag(body, `<base href="${escapeHtml(href)}">`)
}

const html = (body: Buffer | string): PluginFile => ({ body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), contentType: ASSET_MIME['.html'] ?? '' })

export class DashboardPlugins {
  private readonly bindingKey = randomBytes(32)
  private readonly assetScopes = new Map<string, { scope: AgentDashboardScope; generation: string }>()
  private readonly grants = new Map<string, { scope: AgentDashboardScope; generation: string; value: unknown }>()
  private readonly owners = new Map<string, { generation: string; pending: Set<AbortController> }>()
  constructor(private readonly deps: DashboardPluginDeps) {}

  private owner(scope: AgentDashboardScope) {
    // One login generation spans profile homes, so switching revokes its frames in every profile.
    const key = createHmac('sha256', this.bindingKey).update(scope.owner).digest('hex')
    let state = this.owners.get(key)
    if (!state) {
      // Idle identities may be evicted: their old opaque ids then fail closed.
      if (this.owners.size >= 512) {
        const oldest = [...this.owners].find(([, value]) => value.pending.size === 0)
        if (oldest) this.owners.delete(oldest[0])
        else throw new ExtensionError('Dashboard host is busy', 503)
      }
      state = { generation: randomBytes(16).toString('hex'), pending: new Set<AbortController>() }
      this.owners.set(key, state)
    }
    return state
  }

  invalidateOwner(scope: AgentDashboardScope): void {
    const state = this.owner(scope)
    state.generation = randomBytes(16).toString('hex')
    for (const pending of state.pending) pending.abort()
  }

  private agentId(scope: AgentDashboardScope, name: string): string {
    return 'agent-' + createHmac('sha256', this.bindingKey).update(JSON.stringify([scope.home, scope.owner, this.owner(scope).generation, name])).digest('hex').slice(0, 40)
  }

  private panelGrant(scope: AgentDashboardScope, id: string, panel: string): string {
    if (!this.assetScopes.has(id) && this.assetScopes.size >= 2048) this.assetScopes.delete(this.assetScopes.keys().next().value!)
    // Store a credential hash, never the login cookie. The grant names only this static source.
    this.assetScopes.set(id, { scope: { ...scope }, generation: this.owner(scope).generation })
    return `agent-dashboard-plugins/${signAssetGrant(this.bindingKey, 'agent-dashboard', id)}/${panel}`
  }

  /**
   * TAL-1514: an opaque grant for one value, bound to the owner, profile home and this login generation (a profile switch
   * revokes it). The same value in the same scope reuses its grant. Holders recheck the value's own authority on use.
   */
  bindGrant(namespace: string, scope: AgentDashboardScope, key: string, value: unknown): string {
    const generation = this.owner(scope).generation
    const id = createHmac('sha256', this.bindingKey).update(JSON.stringify([namespace, scope.home, scope.owner, generation, key])).digest('hex').slice(0, 40)
    this.grants.delete(id)
    if (this.grants.size >= 4096) this.grants.delete(this.grants.keys().next().value!)
    this.grants.set(id, { scope: { ...scope }, generation, value })
    return signAssetGrant(this.bindingKey, namespace, id)
  }

  /** The value behind a grant, or null when it is unknown, expired, revoked by a new generation, or another caller's. */
  grantValue(namespace: string, segment: string, caller: AgentDashboardScope): { scope: AgentDashboardScope; value: unknown } | null {
    const id = assetGrantValue(this.bindingKey, namespace, segment)
    const bound = id ? this.grants.get(id) : undefined
    if (!bound) return null
    if (bound.generation !== this.owner(bound.scope).generation || caller.owner !== bound.scope.owner || caller.home !== bound.scope.home) return null
    return { scope: bound.scope, value: bound.value }
  }

  /** One cancellable, generation-checked sidecar call for an owner's native plugin work. */
  call<T>(scope: AgentDashboardScope, call: (sidecar: SidecarLike, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.agentCall(scope, call, signal)
  }

  async agentAssetGrant(segment: string, path: string, signal?: AbortSignal, caller?: AgentDashboardScope): Promise<PluginFile | null> {
    const id = assetGrantValue(this.bindingKey, 'agent-dashboard', segment)
    const binding = id ? this.assetScopes.get(id) : undefined
    const scope = binding?.scope
    if (!id || !scope || binding.generation !== this.owner(scope).generation || (caller && (caller.owner !== scope.owner || caller.home !== scope.home))) return null
    // Rechecks current consent and the owner's generation, including after a profile switch.
    return this.agentAsset(scope, id, path, signal)
  }

  private async agentCall<T>(scope: AgentDashboardScope, call: (sidecar: SidecarLike, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const sidecar = this.deps.sidecar?.()
    if (!sidecar) throw new ExtensionError('Agent dashboard host unavailable', 503)
    const state = this.owner(scope)
    const generation = state.generation
    const abort = new AbortController()
    state.pending.add(abort)
    const combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal
    try {
      if (combined.aborted) throw new ExtensionError('not found', 404)
      const result = await call(sidecar, combined)
      if (combined.aborted || generation !== state.generation) throw new ExtensionError('not found', 404)
      return result
    } catch (error) {
      if (combined.aborted || generation !== state.generation) throw new ExtensionError('not found', 404)
      if (error instanceof SidecarError && error.condition === 'sidecar_timeout') throw new ExtensionError('Agent dashboard request timed out', 504)
      throw error
    } finally { state.pending.delete(abort) }
  }

  async agentManifests(scope: AgentDashboardScope, signal?: AbortSignal): Promise<Dict[]> {
    if (!this.deps.sidecar?.()) return []
    let list: SidecarResult<'plugins.dashboard_list'>
    try { list = await this.agentCall(scope, (sc, signal) => sc.call('plugins.dashboard_list', { profile_home: scope.home }, { signal, timeoutMs: 12_000 }), signal) }
    catch (error) {
      if (error instanceof SidecarError && (error.code === -32601 || error.condition === 'sidecar_unavailable')) return []
      throw error
    }
    return list.plugins.map((plugin) => {
      const id = this.agentId(scope, plugin.name)
      // TAL-1514: Meshy's dashboard API backs the app's own gallery; its Desktop bundle is never loaded.
      if (plugin.name === 'meshy' && plugin.has_api && !plugin.panel) {
        return { id, display_id: plugin.name, name: text(plugin.label, 80) || 'Meshy', version: text(plugin.version, 40), description: text(plugin.description, 300),
          source: 'agent-plugin', agent_host: true, enabled: plugin.enabled, can_toggle: false, panel: null, native_view: 'meshy_gallery',
          nav: { label: 'Meshy' }, capabilities: [], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [] }
      }
      return { id, display_id: plugin.name, name: text(plugin.label, 80) || plugin.name, version: text(plugin.version, 40), description: text(plugin.description, 300),
        source: 'agent-plugin', agent_host: true, enabled: plugin.enabled, can_toggle: plugin.panel !== null,
        panel: plugin.panel ? this.panelGrant(scope, id, plugin.panel) : null,
        nav: plugin.panel ? { label: text(plugin.label, 40) || plugin.name } : null,
        capabilities: plugin.has_api && plugin.panel ? ['sidecar'] : [], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null,
        legacy_injection: false, warnings: plugin.panel ? [] : ['web_extension_migration_required'] }
    })
  }

  private async agentPlugin(scope: AgentDashboardScope, id: string, signal?: AbortSignal): Promise<AgentPlugin | null> {
    if (!isAgentDashboardId(id)) return null
    const list = await this.agentCall(scope, (sc, signal) => sc.call('plugins.dashboard_list', { profile_home: scope.home }, { signal, timeoutMs: 12_000 }), signal)
    return list.plugins.find((p) => this.agentId(scope, p.name) === id) ?? null
  }

  async setAgentEnabled(scope: AgentDashboardScope, id: string, enabled: unknown): Promise<void> {
    if (typeof enabled !== 'boolean') throw new ExtensionError('enabled must be a boolean', 400)
    const plugin = await this.agentPlugin(scope, id)
    if (!plugin?.panel || this.agentId(scope, plugin.name) !== id) throw new ExtensionError('not found', 404)
    await this.agentCall(scope, (sc, signal) => sc.call('plugins.dashboard_toggle', { profile_home: scope.home, name: plugin.name, enabled }, { signal }))
  }

  async agentAsset(scope: AgentDashboardScope, id: string, path: string, signal?: AbortSignal): Promise<PluginFile | null> {
    const plugin = await this.agentPlugin(scope, id, signal)
    if (!plugin?.enabled || !plugin.panel || this.agentId(scope, plugin.name) !== id) return null
    const result = await this.agentCall(scope, (sc, signal) => sc.call('plugins.dashboard_asset', { profile_home: scope.home, name: plugin.name, path }, { signal, timeoutMs: 12_000 }), signal)
    return result.status === 200 ? { body: Buffer.from(result.body, 'base64'), contentType: result.content_type } : null
  }

  async agentRequest(scope: AgentDashboardScope, id: string, request: Omit<import('@maudecode/talaria-web-contracts').SidecarParams<'plugins.dashboard_request'>, 'profile_home' | 'name' | 'authenticated'>, signal?: AbortSignal) {
    const plugin = await this.agentPlugin(scope, id, signal)
    if (!plugin?.enabled || !plugin.panel || this.agentId(scope, plugin.name) !== id) throw new ExtensionError('not found', 404)
    const result = await this.agentCall(scope, (sc, signal) => sc.call('plugins.dashboard_request', { ...request, profile_home: scope.home, name: plugin.name, authenticated: true }, { signal, timeoutMs: 12_000 }), signal)
    return { status: result.status, headers: { 'content-type': result.content_type }, body: Buffer.from(result.body, 'base64').toString('utf8') }
  }

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
  async enabled(name: string): Promise<boolean> {
    try {
      const prefs = (await this.deps.settings.load()).dashboard_plugins
      return isDict(prefs) && pyBool(prefs[name])
    } catch {
      return false
    }
  }

  /** The Settings > Extensions switch: `SettingsStore.save` merges this one key into `dashboard_plugins`. */
  async setEnabled(name: string, enabled: unknown): Promise<void> {
    if (typeof enabled !== 'boolean') throw new ExtensionError('enabled must be a boolean', 400)
    await this.deps.settings.save({ dashboard_plugins: { [name]: enabled } })
  }

  private async enabledPlugin(name: string): Promise<Plugin | null> {
    if (!(await this.enabled(name))) return null
    return this.list().find((p) => p.name === name) ?? null
  }

  /** Python `_from_dashboard_plugin`: one panel entry per plugin for `/api/extensions/manifests`. */
  async manifests(): Promise<Dict[]> {
    return Promise.all(this.list().map(async ({ name, manifest }) => {
      const tab = isDict(manifest.tab) ? manifest.tab : {}
      return {
        id: name, name: text(manifest.label || manifest.name, 80) || name, version: text(manifest.version, 40), description: text(manifest.description, 300),
        source: 'plugin', enabled: (await this.enabled(name)), can_toggle: true, panel: `dashboard-plugins/${name}/index.html`,
        nav: { label: text(tab.name || manifest.label || manifest.name, 40) || name },
        capabilities: ['settings', 'storage', 'toast', 'session'], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [],
      }
    }))
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
  async asset(name: string, rel: string): Promise<PluginFile | null> {
    const plugin = (await this.enabledPlugin(name))
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
  async panel(name: string): Promise<PluginFile | null> {
    const plugin = (await this.enabledPlugin(name))
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
  async tabPage(path: string): Promise<PluginFile | null> {
    const listed = this.list().find((p) => p.tabPath === path)
    const plugin = listed && (await this.enabled(listed.name)) ? listed : null
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
